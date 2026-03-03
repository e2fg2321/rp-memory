import { ExtractionPrompts } from './ExtractionPrompts.js';
import { generateId } from './Utils.js';

const CATEGORIES = ['characters', 'locations', 'mainCharacter', 'goals', 'events'];

export class ExtractionPipeline {
    constructor(apiClient, memoryStore, getSettings, decayEngine = null, getLang = null) {
        this.apiClient = apiClient;
        this.memoryStore = memoryStore;
        this.getSettings = getSettings;
        this.decayEngine = decayEngine;
        this.getLang = getLang || (() => 'en');
        this._abortController = null;
    }

    /**
     * Abort the current extraction if one is in progress.
     */
    abort() {
        if (this._abortController) {
            this._abortController.abort();
            // Don't null out here — let the finally blocks in extract/extractRange/extractFullHistory handle cleanup
        }
    }

    /**
     * Run extraction on recent messages. Single unified API call for all 5 categories.
     * Merges results into memoryStore.
     */
    async extract(context) {
        const settings = this.getSettings();
        const chat = context.chat;

        // Step 1: Gather recent messages (setting is in exchanges, each exchange = 2 messages)
        const recentMessages = this._getRecentMessages(chat, settings.messagesPerExtraction * 2);

        if (recentMessages.length === 0) {
            console.debug('[RP Memory] No messages to extract from');
            return;
        }

        // Step 2: Format messages with sender attribution and priority markers
        const formattedMessages = this._formatMessages(recentMessages, context.name1, context.name2, settings);

        // Step 3: Build trimmed memory state for diff-mode prompts (budget-aware)
        const currentState = this._buildExtractionState();

        // Step 4: Build scenario context (character card, world info, system prompt)
        const scenarioContext = await this._buildScenarioContext(context);

        // Step 5: Single unified extraction call (with abort support)
        this._abortController = new AbortController();
        let result;
        try {
            result = await this._extractAll(formattedMessages, currentState, context, scenarioContext);
        } finally {
            this._abortController = null;
        }

        if (result) {
            let mergeCount = 0;
            for (const category of CATEGORIES) {
                const entities = result[category];
                if (entities?.length) {
                    if (settings.debugMode) {
                        console.debug(`[RP Memory] ${category}: ${entities.length} entities extracted`, entities);
                    }
                    try {
                        this._mergeResult(category, { entities });
                        mergeCount++;
                    } catch (mergeError) {
                        console.warn(`[RP Memory] Merge failed for ${category}:`, mergeError);
                    }
                }
            }
            if (settings.debugMode) {
                console.debug(`[RP Memory] Extraction complete: ${mergeCount} categories had updates`);
            }
        } else if (settings.debugMode) {
            console.debug('[RP Memory] Extraction returned no results');
        }
    }

    /**
     * Extract a specific number of exchanges from the end of chat.
     * Used for manual extraction with a configurable depth.
     * @param {object} context - SillyTavern context
     * @param {number} exchanges - Number of exchanges to extract
     */
    async extractRange(context, exchanges) {
        const settings = this.getSettings();
        const chat = context.chat;
        const messageCount = exchanges * 2;

        const recentMessages = this._getRecentMessages(chat, messageCount);

        if (recentMessages.length === 0) {
            console.debug('[RP Memory] No messages to extract from');
            return;
        }

        if (settings.debugMode) {
            console.debug(`[RP Memory] Manual extraction: ${recentMessages.length} messages (${exchanges} exchanges)`);
        }

        const formattedMessages = this._formatMessages(recentMessages, context.name1, context.name2, settings);
        const currentState = this._buildExtractionState();
        const scenarioContext = await this._buildScenarioContext(context);

        this._abortController = new AbortController();
        let result;
        try {
            result = await this._extractAll(formattedMessages, currentState, context, scenarioContext);
        } finally {
            this._abortController = null;
        }

        if (result) {
            for (const category of CATEGORIES) {
                const entities = result[category];
                if (entities?.length) {
                    if (settings.debugMode) {
                        console.debug(`[RP Memory] ${category}: ${entities.length} entities extracted`, entities);
                    }
                    try {
                        this._mergeResult(category, { entities });
                    } catch (mergeError) {
                        console.warn(`[RP Memory] Merge failed for ${category}:`, mergeError);
                    }
                }
            }
        }
    }

    /**
     * Extract from the ENTIRE chat history in sequential chunks (oldest-first).
     * Each chunk sees the accumulated memory state from prior chunks.
     * @param {object} context - SillyTavern context
     * @param {function} [onProgress] - Callback: (chunkIndex, totalChunks) => void
     */
    async extractFullHistory(context, onProgress = null) {
        const settings = this.getSettings();
        const chat = context.chat;

        // Get ALL non-system messages
        const allMessages = this._getRecentMessages(chat, chat.length);

        if (allMessages.length === 0) {
            console.debug('[RP Memory] No messages to extract from');
            return;
        }

        // Chunk size: use the messagesPerExtraction setting (in exchanges × 2)
        const chunkSize = settings.messagesPerExtraction * 2;
        const chunks = [];
        for (let i = 0; i < allMessages.length; i += chunkSize) {
            chunks.push(allMessages.slice(i, i + chunkSize));
        }

        if (settings.debugMode) {
            console.debug(`[RP Memory] Full history: ${allMessages.length} messages in ${chunks.length} chunks`);
        }

        // Build scenario context once — same character/world for all chunks
        const scenarioContext = await this._buildScenarioContext(context);

        this._abortController = new AbortController();

        try {
            for (let ci = 0; ci < chunks.length; ci++) {
                if (onProgress) onProgress(ci + 1, chunks.length);

                const formattedMessages = this._formatMessages(chunks[ci], context.name1, context.name2, settings);
                // Fresh trimmed state each chunk — includes results from prior chunks
                const currentState = this._buildExtractionState();

                // _extractAll throws AbortError if aborted — breaks the loop naturally
                const result = await this._extractAll(formattedMessages, currentState, context, scenarioContext);

                if (result) {
                    for (const category of CATEGORIES) {
                        const entities = result[category];
                        if (entities?.length) {
                            if (settings.debugMode) {
                                console.debug(`[RP Memory] Chunk ${ci + 1}/${chunks.length} — ${category}: ${entities.length} entities`, entities);
                            }
                            try {
                                this._mergeResult(category, { entities });
                            } catch (mergeError) {
                                console.warn(`[RP Memory] Merge failed for ${category} in chunk ${ci + 1}:`, mergeError);
                            }
                        }
                    }
                }
            }
        } finally {
            this._abortController = null;
        }
    }

    /**
     * Build scenario context from SillyTavern's character card, system prompt, and world info.
     * This gives the extraction LLM knowledge of the RP setting for better entity extraction
     * and importance scoring.
     */
    async _buildScenarioContext(context) {
        const MAX_CHARS = 6000; // ~1500 tokens
        const parts = [];

        // Character card fields
        if (context.getCharacterCardFields) {
            try {
                const fields = context.getCharacterCardFields();
                if (fields.description) parts.push(`Character Description: ${fields.description}`);
                if (fields.personality) parts.push(`Personality: ${fields.personality}`);
                if (fields.scenario) parts.push(`Scenario: ${fields.scenario}`);
                if (fields.system) parts.push(`System Prompt: ${fields.system}`);
            } catch (e) {
                console.debug('[RP Memory] Could not read character card fields:', e.message);
            }
        }

        // World Info / Lorebook — dry run to get activated entries without side effects
        if (context.getWorldInfoPrompt && context.chat) {
            try {
                const chatStrings = context.chat
                    .filter(m => !m.is_system && m.mes)
                    .slice(-20)
                    .map(m => m.mes)
                    .reverse();
                const wi = await context.getWorldInfoPrompt(chatStrings, context.maxContext || 8192, true);
                if (wi?.worldInfoString) parts.push(`World Lore:\n${wi.worldInfoString}`);
            } catch (e) {
                console.debug('[RP Memory] Could not read world info:', e.message);
            }
        }

        let result = parts.length > 0 ? parts.join('\n\n') : '';
        if (result.length > MAX_CHARS) {
            result = result.slice(0, MAX_CHARS) + '…[truncated]';
        }
        return result;
    }

    /**
     * Build a trimmed memory state for extraction prompts.
     * Enforces a hard character budget (~1500 tokens) so extraction costs stay flat.
     *
     * Priority order:
     * 1. Main character (always full)
     * 2. Active goals (full — needed for status tracking)
     * 3. Characters sorted by importance desc (full, then summary)
     * 4. Locations sorted by importance desc (full, then summary)
     * 5. Recent events (most recent first, summary only)
     */
    _buildExtractionState() {
        const MAX_CHARS = 6000; // ~1500 tokens
        const MAX_EVENTS = 10;

        const fullEntity = (entity) => ({
            name: entity.name,
            importance: entity.importance,
            fields: entity.fields || {},
        });

        const summaryEntity = (entity) => ({
            name: entity.name,
            importance: entity.importance,
        });

        const state = {
            characters: {},
            locations: {},
            mainCharacter: null,
            goals: {},
            events: {},
        };

        const measure = () => JSON.stringify(state).length;

        // 1. Main Character — always include full
        const mc = this.memoryStore.getMainCharacter();
        if (mc) {
            state.mainCharacter = fullEntity(mc);
        }

        // 2. Active goals (Tier 1+2) — need full fields for status tracking
        const allGoals = Object.entries(this.memoryStore.getAllEntities('goals'))
            .filter(([, e]) => e.tier < 3)
            .sort(([, a], [, b]) => b.importance - a.importance);
        for (const [id, entity] of allGoals) {
            state.goals[id] = fullEntity(entity);
            if (measure() > MAX_CHARS) {
                state.goals[id] = summaryEntity(entity);
            }
        }

        // 3. Characters (Tier 1+2) — full if budget allows, then summary
        const allChars = Object.entries(this.memoryStore.getAllEntities('characters'))
            .filter(([, e]) => e.tier < 3)
            .sort(([, a], [, b]) => b.importance - a.importance);
        for (const [id, entity] of allChars) {
            if (measure() > MAX_CHARS) {
                state.characters[id] = summaryEntity(entity);
            } else {
                state.characters[id] = fullEntity(entity);
            }
        }

        // 4. Locations (Tier 1+2) — full if budget allows, then summary
        const allLocs = Object.entries(this.memoryStore.getAllEntities('locations'))
            .filter(([, e]) => e.tier < 3)
            .sort(([, a], [, b]) => b.importance - a.importance);
        for (const [id, entity] of allLocs) {
            if (measure() > MAX_CHARS) {
                state.locations[id] = summaryEntity(entity);
            } else {
                state.locations[id] = fullEntity(entity);
            }
        }

        // 5. Events — most recent N, summary only (just name + turn)
        const allEvents = Object.entries(this.memoryStore.getAllEntities('events'))
            .filter(([, e]) => e.tier < 3)
            .sort(([, a], [, b]) => (b.fields.turn || b.createdTurn || 0) - (a.fields.turn || a.createdTurn || 0))
            .slice(0, MAX_EVENTS);
        for (const [id, entity] of allEvents) {
            state.events[id] = summaryEntity(entity);
        }

        return state;
    }

    /**
     * Extract recent non-system messages from chat.
     */
    _getRecentMessages(chat, count) {
        const messages = [];
        for (let i = Math.max(0, chat.length - count); i < chat.length; i++) {
            const msg = chat[i];
            if (msg.is_system) continue;
            messages.push({
                index: i,
                name: msg.name,
                text: msg.mes,
                isUser: msg.is_user,
            });
        }
        return messages;
    }

    /**
     * Format messages for extraction prompt.
     * User messages get [HIGH PRIORITY] marker.
     */
    _formatMessages(messages, userName, charName, settings) {
        return messages.map(msg => {
            const priority = msg.isUser && settings.userMessageWeight === 'high'
                ? ' [HIGH PRIORITY - User action/decision]'
                : '';
            return `[${msg.name}]${priority}: ${msg.text}`;
        }).join('\n\n---\n\n');
    }

    /**
     * Run unified extraction for all categories in a single API call.
     */
    async _extractAll(formattedMessages, currentState, context, scenarioContext = '') {
        const lang = this.getLang();
        const systemPrompt = lang === 'zh' ? ExtractionPrompts.UNIFIED_SYSTEM_ZH : ExtractionPrompts.UNIFIED_SYSTEM;
        const userPrompt = ExtractionPrompts.getUnifiedUserPrompt(
            formattedMessages,
            currentState,
            context.name1,
            context.name2,
            lang,
            scenarioContext,
        );

        try {
            const signal = this._abortController?.signal;
            const response = await this.apiClient.chatCompletion([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ], signal);

            return this._parseUnifiedResponse(response);
        } catch (error) {
            if (error.name === 'AbortError') {
                console.debug('[RP Memory] Extraction aborted by user');
                throw error; // Propagate so callers can stop immediately
            }
            console.warn('[RP Memory] Unified extraction call failed:', error);
            return null;
        }
    }

    /**
     * Parse unified JSON response containing all 5 category arrays.
     */
    _parseUnifiedResponse(responseText) {
        let cleaned = responseText.trim();

        // Strip markdown code fences
        if (cleaned.startsWith('```json')) {
            cleaned = cleaned.slice(7);
        } else if (cleaned.startsWith('```')) {
            cleaned = cleaned.slice(3);
        }
        if (cleaned.endsWith('```')) {
            cleaned = cleaned.slice(0, -3);
        }
        cleaned = cleaned.trim();

        try {
            const parsed = JSON.parse(cleaned);

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                console.warn('[RP Memory] Unified response is not an object');
                return null;
            }

            // Validate: at least one known category key with an array value
            const hasValidCategory = CATEGORIES.some(
                cat => Array.isArray(parsed[cat]),
            );
            if (!hasValidCategory) {
                console.warn('[RP Memory] Unified response has no valid category arrays');
                return null;
            }

            // Ensure all category values are arrays (default to empty)
            for (const cat of CATEGORIES) {
                if (!Array.isArray(parsed[cat])) {
                    parsed[cat] = [];
                }
                // Normalize entities: if fields aren't nested under "fields", move them there
                parsed[cat] = parsed[cat].map(entity => this._normalizeEntity(entity));
            }

            return parsed;
        } catch (e) {
            console.warn('[RP Memory] Failed to parse unified response:', e.message);
            if (this.getSettings().debugMode) {
                console.debug('[RP Memory] Raw response:', responseText);
            }
            return null;
        }
    }

    /**
     * Normalize an entity: if field values are at the top level instead of nested
     * under "fields", move them there. LLMs sometimes ignore the nesting instruction.
     */
    _normalizeEntity(entity) {
        if (!entity || typeof entity !== 'object') return entity;

        // Known structural keys that belong at entity top level
        const STRUCTURAL_KEYS = new Set(['id', 'name', 'importance', 'fields']);

        // If entity already has a populated fields object, it's fine
        if (entity.fields && typeof entity.fields === 'object' && Object.keys(entity.fields).length > 0) {
            return entity;
        }

        // Check if there are extra keys beyond structural ones (i.e. field values at top level)
        const extraKeys = Object.keys(entity).filter(k => !STRUCTURAL_KEYS.has(k));
        if (extraKeys.length === 0) return entity;

        // Move extra keys into fields
        const fields = entity.fields && typeof entity.fields === 'object' ? { ...entity.fields } : {};
        for (const key of extraKeys) {
            fields[key] = entity[key];
            delete entity[key];
        }
        entity.fields = fields;

        return entity;
    }

    /**
     * Parse JSON from LLM response, handling markdown code fences.
     */
    _parseResponse(responseText) {
        let cleaned = responseText.trim();

        // Strip markdown code fences
        if (cleaned.startsWith('```json')) {
            cleaned = cleaned.slice(7);
        } else if (cleaned.startsWith('```')) {
            cleaned = cleaned.slice(3);
        }
        if (cleaned.endsWith('```')) {
            cleaned = cleaned.slice(0, -3);
        }
        cleaned = cleaned.trim();

        try {
            const parsed = JSON.parse(cleaned);

            // Validate basic structure
            if (!parsed || !Array.isArray(parsed.entities)) {
                console.warn('[RP Memory] Invalid extraction response structure');
                return null;
            }

            // Filter out empty entities array
            if (parsed.entities.length === 0) {
                return null;
            }

            return parsed;
        } catch (e) {
            console.warn('[RP Memory] Failed to parse extraction response:', e.message);
            if (this.getSettings().debugMode) {
                console.debug('[RP Memory] Raw response:', responseText);
            }
            return null;
        }
    }

    /**
     * Merge extraction result into memory store.
     */
    _mergeResult(category, extractedData) {
        if (!extractedData?.entities) return;

        const currentTurn = this.memoryStore.getTurnCounter();

        for (const entity of extractedData.entities) {
            if (!entity.name && !entity.id) continue;

            // Flatten any arrays/objects from LLM output to strings
            if (entity.fields) {
                entity.fields = this._flattenFields(entity.fields);
            }

            const entityId = entity.id || generateId(entity.name);

            // For mainCharacter, always merge into the single MC entry
            if (category === 'mainCharacter') {
                this._mergeMainCharacter(entity, currentTurn);
                continue;
            }

            const existing = this.memoryStore.getEntity(category, entityId);

            if (existing) {
                // Update existing entity
                const conflicts = this._detectConflicts(existing, entity, currentTurn);
                const mergedFields = this._mergeFields(existing.fields, entity.fields);
                const newImportance = entity.importance ?? existing.importance;

                this.memoryStore.updateEntity(category, entityId, {
                    fields: mergedFields,
                    conflicts: [...(existing.conflicts || []), ...conflicts],
                });

                // Reinforce: reset decay, restore score, promote Tier 3 → 2 if applicable
                if (this.decayEngine) {
                    this.decayEngine.reinforce(this.memoryStore, category, entityId, currentTurn, newImportance);
                } else {
                    this.memoryStore.updateEntity(category, entityId, {
                        importance: newImportance,
                        baseScore: newImportance,
                        lastMentionedTurn: currentTurn,
                        tier: this._assignTier(newImportance),
                    });
                }
            } else {
                // New entity
                const tier = this._assignTier(entity.importance || 5);
                this.memoryStore.addEntity(category, {
                    id: entityId,
                    name: entity.name || entityId,
                    tier,
                    importance: entity.importance || 5,
                    baseScore: entity.importance || 5,
                    lastMentionedTurn: currentTurn,
                    createdTurn: currentTurn,
                    fields: entity.fields || {},
                    conflicts: [],
                    source: 'extracted',
                });
            }
        }
    }

    /**
     * Merge extracted main character data into the existing MC entry.
     */
    _mergeMainCharacter(entity, currentTurn) {
        const existing = this.memoryStore.getMainCharacter();

        if (existing) {
            const conflicts = this._detectConflicts(existing, entity, currentTurn);
            const mergedFields = this._mergeFields(existing.fields, entity.fields);

            this.memoryStore.updateEntity('mainCharacter', existing.id, {
                name: entity.name || existing.name,
                fields: mergedFields,
                lastMentionedTurn: currentTurn,
                conflicts: [...(existing.conflicts || []), ...conflicts],
            });
        } else {
            // First time seeing MC
            this.memoryStore.addEntity('mainCharacter', {
                id: 'main-character',
                name: entity.name || 'Main Character',
                tier: 1,
                importance: 10,
                baseScore: 10,
                lastMentionedTurn: currentTurn,
                createdTurn: currentTurn,
                fields: entity.fields || {},
                conflicts: [],
                source: 'extracted',
            });
        }
    }

    /**
     * Flatten any arrays or objects from LLM output into plain strings.
     * Ensures all field values are stored as strings (or numbers for 'turn').
     */
    _flattenFields(fields) {
        const flat = {};

        for (const [key, value] of Object.entries(fields)) {
            if (value === null || value === undefined) continue;

            if (Array.isArray(value)) {
                // Array of objects (e.g. old-format relationships [{target, nature}])
                if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
                    flat[key] = value.map(v => v.target ? `${v.target}: ${v.nature || ''}` : JSON.stringify(v)).join(', ');
                } else {
                    flat[key] = value.join(', ');
                }
            } else if (typeof value === 'object') {
                // Nested object (e.g. old-format status {health, conditions, buffs})
                // Promote children to top-level
                for (const [subKey, subVal] of Object.entries(value)) {
                    if (subVal === null || subVal === undefined) continue;
                    if (Array.isArray(subVal)) {
                        flat[subKey] = subVal.join(', ');
                    } else {
                        flat[subKey] = String(subVal);
                    }
                }
            } else {
                flat[key] = value;
            }
        }

        return flat;
    }

    /**
     * Merge new fields into existing fields.
     * Only overwrites fields that are present in the new data.
     */
    _mergeFields(existing, updated) {
        if (!updated) return { ...existing };
        if (!existing) return { ...updated };

        const merged = { ...existing };

        for (const [key, newVal] of Object.entries(updated)) {
            if (newVal === null || newVal === undefined) continue;
            merged[key] = newVal;
        }

        return merged;
    }

    /**
     * Detect field-level conflicts between existing and updated entity.
     */
    _detectConflicts(existing, updated, turn) {
        const conflicts = [];
        if (!updated.fields || !existing.fields) return conflicts;

        for (const [key, newVal] of Object.entries(updated.fields)) {
            if (newVal === null || newVal === undefined) continue;

            const oldVal = existing.fields[key];
            if (oldVal === undefined || oldVal === null || oldVal === '') continue;

            // Skip arrays and objects for conflict detection (too noisy)
            if (typeof oldVal === 'object' || typeof newVal === 'object') continue;

            // Only flag if both are strings and they differ
            if (typeof oldVal === 'string' && typeof newVal === 'string' &&
                oldVal.trim() !== '' && newVal.trim() !== '' &&
                oldVal !== newVal) {
                conflicts.push({
                    field: key,
                    oldValue: oldVal,
                    newValue: newVal,
                    detectedTurn: turn,
                    resolved: false,
                });
            }
        }

        return conflicts;
    }

    /**
     * Assign tier based on importance score.
     */
    _assignTier(importance) {
        if (importance >= 8) return 1;  // Pinned
        if (importance >= 4) return 2;  // Active
        return 3;                        // Archived
    }
}
