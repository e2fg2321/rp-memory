import { ExtractionPrompts, TAVERNDB_TABLE_PROMPT_FEW_SHOT } from './ExtractionPrompts.js';
import { generateId, unwrapField, wrapField, updateFieldProvenance } from './Utils.js';

const CATEGORIES = ['characters', 'locations', 'mainCharacter', 'goals', 'events'];

/**
 * Fields that represent mutable state — expected to change frequently as the
 * story progresses. Changes to these are normal progression, not conflicts.
 *
 * Stable/factual fields like description and personality are NOT in this set,
 * so substantial changes to them will be flagged as conflicts (the rephrasing
 * filter in _isRephrasing handles minor rewording).
 */
const MUTABLE_FIELDS = new Set([
    'currentLocation', 'currentTime', 'status', 'conditions', 'buffs',
    'health', 'inventory', 'present', 'progress', 'blockers',
    'atmosphere', 'skills', 'connections', 'relationships',
]);

/** Patterns that look like prompt injection attempts */
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous/i,
    /system\s*prompt/i,
    /you\s+are\s+now/i,
    /follow\s+these\s+(rules|instructions)/i,
    /disregard\s+(all\s+)?(prior|previous)/i,
    /override\s+(all\s+)?instructions/i,
];

export class ExtractionPipeline {
    constructor(apiClient, memoryStore, getSettings, decayEngine = null, getLang = null) {
        this.apiClient = apiClient;
        this.memoryStore = memoryStore;
        this.getSettings = getSettings;
        this.decayEngine = decayEngine;
        this.getLang = getLang || (() => 'en');
        this._abortController = null;
        this._batchMode = false;
    }

    /**
     * Abort the current extraction if one is in progress.
     */
    abort() {
        if (this._abortController) {
            this._abortController.abort();
        }
    }

    /**
     * Run extraction on recent messages. Single unified API call for all categories.
     * Merges results into memoryStore.
     */
    async extract(context) {
        const settings = this.getSettings();
        const chat = context.chat;
        const CONTEXT_PADDING = 5;

        const targetCount = settings.messagesPerExtraction * 2;
        const totalCount = targetCount + (CONTEXT_PADDING * 2);
        const allRecent = this._getRecentMessages(chat, totalCount);

        if (allRecent.length === 0) {
            console.debug('[RP Memory] No messages to extract from');
            return;
        }

        const splitPoint = Math.max(0, allRecent.length - targetCount);
        const contextMessages = allRecent.slice(0, splitPoint);
        const targetMessages = allRecent.slice(splitPoint);

        const formattedTarget = this._formatMessages(targetMessages, context.name1, context.name2, settings);
        const formattedContext = contextMessages.length > 0
            ? this._formatMessages(contextMessages, context.name1, context.name2, settings)
            : '';

        const currentState = this._buildExtractionState();
        const scenarioContext = this._buildScenarioContext(context);

        this._abortController = new AbortController();
        let result;
        try {
            result = await this._extractAll(formattedTarget, currentState, context, scenarioContext, formattedContext);
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

            // Process beats (Layer 2)
            if (Array.isArray(result.beats) && result.beats.length > 0) {
                this._processBeats(result.beats);
                mergeCount++;
            }

            if (settings.debugMode) {
                console.debug(`[RP Memory] Extraction complete: ${mergeCount} categories had updates`);
            }
        } else if (settings.debugMode) {
            console.debug('[RP Memory] Extraction returned no results');
        }

        // Auto-resolve stale conflicts during incremental extraction only
        if (!this._batchMode) {
            const currentTurn = this.memoryStore.getTurnCounter();
            const resolved = this.memoryStore.autoResolveStaleConflicts(currentTurn);
            if (resolved > 0 && settings.debugMode) {
                console.debug(`[RP Memory] Auto-resolved ${resolved} stale conflict(s)`);
            }
        }
    }

    /**
     * Extract a specific number of exchanges from the end of chat.
     */
    async extractRange(context, exchanges) {
        const settings = this.getSettings();
        const chat = context.chat;
        const CONTEXT_PADDING = 5;
        const targetCount = exchanges * 2;
        const totalCount = targetCount + (CONTEXT_PADDING * 2);

        const allRecent = this._getRecentMessages(chat, totalCount);

        if (allRecent.length === 0) {
            console.debug('[RP Memory] No messages to extract from');
            return;
        }

        const splitPoint = Math.max(0, allRecent.length - targetCount);
        const contextMessages = allRecent.slice(0, splitPoint);
        const targetMessages = allRecent.slice(splitPoint);

        if (settings.debugMode) {
            console.debug(`[RP Memory] Manual extraction: ${targetMessages.length} messages (${exchanges} exchanges) + ${contextMessages.length} context messages`);
        }

        const formattedTarget = this._formatMessages(targetMessages, context.name1, context.name2, settings);
        const formattedContext = contextMessages.length > 0
            ? this._formatMessages(contextMessages, context.name1, context.name2, settings)
            : '';
        const currentState = this._buildExtractionState();
        const scenarioContext = this._buildScenarioContext(context);

        this._abortController = new AbortController();
        let result;
        try {
            result = await this._extractAll(formattedTarget, currentState, context, scenarioContext, formattedContext);
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

            // Process beats
            if (Array.isArray(result.beats) && result.beats.length > 0) {
                this._processBeats(result.beats);
            }
        }
    }

    /**
     * Extract from the ENTIRE chat history in sequential chunks (oldest-first).
     */
    async extractFullHistory(context, onProgress = null) {
        const settings = this.getSettings();
        const chat = context.chat;

        const allMessages = this._getRecentMessages(chat, chat.length);

        if (allMessages.length === 0) {
            console.debug('[RP Memory] No messages to extract from');
            return;
        }

        const chunkSize = settings.messagesPerExtraction * 2;
        const chunks = [];
        for (let i = 0; i < allMessages.length; i += chunkSize) {
            chunks.push(allMessages.slice(i, i + chunkSize));
        }

        if (settings.debugMode) {
            console.debug(`[RP Memory] Full history: ${allMessages.length} messages in ${chunks.length} chunks`);
        }

        const scenarioContext = this._buildScenarioContext(context);

        this._abortController = new AbortController();
        this._batchMode = true;

        try {
            for (let ci = 0; ci < chunks.length; ci++) {
                if (onProgress) onProgress(ci + 1, chunks.length);

                // Advance turn counter per chunk so beats/entities get distinct storyTurns
                this.memoryStore.incrementTurn();

                const formattedTarget = this._formatMessages(chunks[ci], context.name1, context.name2, settings);
                const formattedContext = ci > 0
                    ? this._formatMessages(chunks[ci - 1], context.name1, context.name2, settings)
                    : '';
                const currentState = this._buildExtractionState();

                const result = await this._extractAll(formattedTarget, currentState, context, scenarioContext, formattedContext);

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

                    // Process beats
                    if (Array.isArray(result.beats) && result.beats.length > 0) {
                        this._processBeats(result.beats);
                    }
                }
            }
        } finally {
            this._abortController = null;
            this._batchMode = false;
        }
    }

    /**
     * Build scenario context for extraction.
     */
    _buildScenarioContext(context) {
        const parts = [];

        if (context.getCharacterCardFields) {
            try {
                const fields = context.getCharacterCardFields();
                if (fields.system) parts.push(fields.system);
            } catch (e) {
                console.debug('[RP Memory] Could not read character card fields:', e.message);
            }
        }

        try {
            const globalSP = context.powerUserSettings?.sysprompt;
            if (globalSP?.enabled && globalSP?.content) {
                const content = globalSP.content.trim();
                if (content && !parts.includes(content)) parts.push(content);
            }
        } catch (e) {
            console.debug('[RP Memory] Could not read global system prompt:', e.message);
        }

        return parts.join('\n\n');
    }

    /**
     * Build extraction state: Tier 1 (pinned) entities with full detail,
     * plus a compact catalog of ALL entities (id, name, aliases) for dedup.
     * Unwraps provenance fields to plain strings for the LLM prompt.
     */
    _buildExtractionState() {
        const stripEntity = (entity) => {
            const plainFields = {};
            if (entity.fields) {
                for (const [key, value] of Object.entries(entity.fields)) {
                    plainFields[key] = unwrapField(value);
                }
            }
            return {
                name: entity.name,
                importance: entity.importance,
                fields: plainFields,
            };
        };

        const state = {
            characters: {},
            locations: {},
            mainCharacter: null,
            goals: {},
            events: {},
        };

        const mc = this.memoryStore.getMainCharacter();
        if (mc) {
            state.mainCharacter = stripEntity(mc);
        }

        // Compact catalog for dedup: Tier 1-2 entities (id, name, aliases).
        // Tier 3 are archived and unlikely to be re-mentioned — skip to save prompt tokens.
        // Cap at 50 entries to prevent prompt bloat in long sessions.
        const entityCatalog = [];

        if (mc) {
            entityCatalog.push({ id: mc.id, name: mc.name, aliases: mc.aliases || [] });
        }

        for (const cat of CATEGORIES) {
            const all = this.memoryStore.getAllEntities(cat);
            for (const [id, entity] of Object.entries(all)) {
                if (entity.tier <= 2) {
                    entityCatalog.push({ id, name: entity.name, aliases: entity.aliases || [], _imp: entity.importance || 5 });
                }
                if (entity.tier === 1) state[cat][id] = stripEntity(entity);
            }
        }

        // Sort by importance descending and cap at 50
        entityCatalog.sort((a, b) => (b._imp || 10) - (a._imp || 5));
        // Strip the sort key before sending to LLM
        state.entityCatalog = entityCatalog.slice(0, 50).map(({ _imp, ...rest }) => rest);

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
    async _extractAll(formattedMessages, currentState, context, scenarioContext = '', precedingContext = '') {
        const lang = this.getLang();
        const systemPrompt = lang === 'zh' ? ExtractionPrompts.UNIFIED_SYSTEM_ZH : ExtractionPrompts.UNIFIED_SYSTEM;
        const userPrompt = ExtractionPrompts.getUnifiedUserPrompt(
            formattedMessages,
            currentState,
            context.name1,
            context.name2,
            lang,
            scenarioContext,
            precedingContext,
        );

        const promptMessages = [
            { role: 'system', content: systemPrompt },
            ...TAVERNDB_TABLE_PROMPT_FEW_SHOT,
            { role: 'user', content: userPrompt },
        ];

        try {
            const signal = this._abortController?.signal;
            const response = await this.apiClient.chatCompletion(promptMessages, signal);

            return this._parseUnifiedResponse(response);
        } catch (error) {
            if (error.name === 'AbortError') {
                console.debug('[RP Memory] Extraction aborted by user');
                throw error;
            }
            console.warn('[RP Memory] Unified extraction call failed:', error);
            return null;
        }
    }

    /**
     * Parse unified JSON response containing all category arrays + beats.
     */
    _parseUnifiedResponse(responseText) {
        let cleaned = responseText.trim();

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
            const allKeys = [...CATEGORIES, 'beats'];
            const hasValidCategory = allKeys.some(
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
                parsed[cat] = parsed[cat].map(entity => this._normalizeEntity(entity));
            }

            // Ensure beats is an array
            if (!Array.isArray(parsed.beats)) {
                parsed.beats = [];
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
     * under "fields", move them there.
     */
    _normalizeEntity(entity) {
        if (!entity || typeof entity !== 'object') return entity;

        const STRUCTURAL_KEYS = new Set(['id', 'name', 'importance', 'fields']);

        if (entity.fields && typeof entity.fields === 'object' && Object.keys(entity.fields).length > 0) {
            return entity;
        }

        const extraKeys = Object.keys(entity).filter(k => !STRUCTURAL_KEYS.has(k));
        if (extraKeys.length === 0) return entity;

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

            if (!parsed || !Array.isArray(parsed.entities)) {
                console.warn('[RP Memory] Invalid extraction response structure');
                return null;
            }

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
     * Sanitize a field value string, stripping potential prompt injection patterns.
     */
    _sanitizeFieldValue(value) {
        if (typeof value !== 'string') return value;
        let sanitized = value;
        for (const pattern of INJECTION_PATTERNS) {
            if (pattern.test(sanitized)) {
                console.warn(`[RP Memory] Stripped potential injection from field value: "${sanitized.slice(0, 80)}..."`);
                sanitized = sanitized.replace(pattern, '[REMOVED]');
            }
        }
        return sanitized;
    }

    /**
     * Process extracted beats and store them.
     */
    _processBeats(beats) {
        const currentTurn = this.memoryStore.getTurnCounter();

        for (const beat of beats) {
            if (!beat.text) continue;

            const sanitizedText = this._sanitizeFieldValue(beat.text);
            const resolvedParticipants = this._resolveParticipants(
                Array.isArray(beat.participants) ? beat.participants : [],
            );

            const beatObj = {
                id: `beat-${currentTurn}-${this._shortHash(sanitizedText)}`,
                text: sanitizedText,
                participants: resolvedParticipants,
                sourceTurns: [currentTurn],
                storyTurn: currentTurn,
                importance: beat.importance || 5,
                type: beat.type || 'transition',
            };

            this.memoryStore.addBeat(beatObj);
        }

        if (this.getSettings().debugMode) {
            console.debug(`[RP Memory] ${beats.length} beats extracted at turn ${currentTurn}`);
        }
    }

    /**
     * Resolve beat participant references to valid entity IDs.
     * The LLM may output names instead of IDs, or inconsistent casing.
     */
    _resolveParticipants(participants) {
        const resolved = [];
        const categories = ['mainCharacter', 'characters', 'locations', 'goals', 'events'];

        for (const participant of participants) {
            if (!participant || typeof participant !== 'string') continue;

            const normalized = participant.trim();
            if (!normalized) continue;

            // First: try as-is (already a valid kebab-case ID)
            const asId = generateId(normalized);
            let found = false;

            for (const cat of categories) {
                // Try direct ID lookup
                if (this.memoryStore.getEntity(cat, asId)) {
                    resolved.push(asId);
                    found = true;
                    break;
                }
                // Try original string as ID
                if (normalized !== asId && this.memoryStore.getEntity(cat, normalized)) {
                    resolved.push(normalized);
                    found = true;
                    break;
                }
                // Try alias-based resolution
                const byAlias = this.memoryStore.findEntityByAlias(cat, normalized);
                if (byAlias) {
                    resolved.push(byAlias.id);
                    found = true;
                    break;
                }
            }

            // Fallback: use the kebab-case version even if unresolved
            if (!found) {
                resolved.push(asId);
            }
        }

        return [...new Set(resolved)]; // Deduplicate
    }

    /**
     * Generate a short hash from text for beat IDs.
     */
    _shortHash(text) {
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            const char = text.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(36).slice(0, 6);
    }

    /**
     * Merge extraction result into memory store.
     */
    _mergeResult(category, extractedData) {
        if (!extractedData?.entities) return;

        const currentTurn = this.memoryStore.getTurnCounter();

        for (const entity of extractedData.entities) {
            // Derive missing id/name for events from description field
            if (!entity.name && !entity.id) {
                const desc = entity.fields?.description;
                const descText = typeof desc === 'string' ? desc
                    : (desc && typeof desc === 'object' && 'value' in desc) ? desc.value : null;
                if (descText && category === 'events') {
                    // Truncate at first punctuation boundary within 30 chars for cleaner names
                    const punctMatch = descText.slice(0, 30).match(/[。，！？；、.!?,;]/);
                    entity.name = punctMatch
                        ? descText.slice(0, punctMatch.index)
                        : descText.slice(0, 30);
                    entity.id = 'evt-' + generateId(descText.slice(0, 30));
                } else {
                    continue;
                }
            }

            // Events: derive importance from fields.significance if not set at entity level
            if (category === 'events' && entity.importance == null) {
                const sig = entity.fields?.significance;
                const sigNum = typeof sig === 'number' ? sig
                    : (typeof sig === 'string' ? parseInt(sig, 10) : NaN);
                if (!isNaN(sigNum) && sigNum >= 1 && sigNum <= 10) {
                    entity.importance = sigNum;
                }
            }

            // Flatten any arrays/objects from LLM output to strings
            if (entity.fields) {
                entity.fields = this._flattenFields(entity.fields, currentTurn);
            }

            // Events: backfill the turn field with the actual current turn
            if (category === 'events' && entity.fields) {
                entity.fields.turn = wrapField(String(currentTurn), currentTurn);
            }

            // Sanitize field values
            if (entity.fields) {
                for (const [key, value] of Object.entries(entity.fields)) {
                    if (value && typeof value === 'object' && 'value' in value) {
                        value.value = this._sanitizeFieldValue(value.value);
                    } else if (typeof value === 'string') {
                        entity.fields[key] = this._sanitizeFieldValue(value);
                    }
                }
            }

            const entityId = entity.id || generateId(entity.name);

            // For mainCharacter, always merge into the single MC entry
            if (category === 'mainCharacter') {
                this._mergeMainCharacter(entity, currentTurn);
                continue;
            }

            let existing = this.memoryStore.getEntity(category, entityId);

            // If not found by ID, try alias-based resolution
            if (!existing) {
                existing = this.memoryStore.findEntityByAlias(category, entity.name || entityId);
                if (existing) {
                    // Add the new name as an alias if it's different
                    const newName = (entity.name || '').trim();
                    if (newName && newName.toLowerCase() !== existing.name.toLowerCase()) {
                        if (!existing.aliases) existing.aliases = [];
                        if (!existing.aliases.some(a => a.toLowerCase() === newName.toLowerCase())) {
                            existing.aliases.push(newName);
                        }
                    }
                }
            }

            if (existing) {
                // Update existing entity
                const newConflicts = this._detectConflicts(existing, entity, currentTurn);
                const mergedFields = this._mergeFields(existing.fields, entity.fields, currentTurn);
                const newImportance = entity.importance ?? existing.importance;

                // Dedup: replace stale unresolved conflict on same field with latest
                const mergedConflicts = this._mergeConflicts(existing.conflicts || [], newConflicts);

                this.memoryStore.updateEntity(category, existing.id, {
                    fields: mergedFields,
                    conflicts: mergedConflicts,
                });

                // Reinforce: reset decay, restore score, promote Tier 3 → 2 if applicable
                if (this.decayEngine) {
                    this.decayEngine.reinforce(this.memoryStore, category, existing.id, currentTurn, newImportance);
                } else {
                    this.memoryStore.updateEntity(category, existing.id, {
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
                    aliases: [],
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
            const newConflicts = this._detectConflicts(existing, entity, currentTurn);
            const mergedFields = this._mergeFields(existing.fields, entity.fields, currentTurn);
            const mergedConflicts = this._mergeConflicts(existing.conflicts || [], newConflicts);

            this.memoryStore.updateEntity('mainCharacter', existing.id, {
                name: entity.name || existing.name,
                fields: mergedFields,
                lastMentionedTurn: currentTurn,
                conflicts: mergedConflicts,
            });
        } else {
            this.memoryStore.addEntity('mainCharacter', {
                id: 'main-character',
                name: entity.name || 'Main Character',
                aliases: [],
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
     * Flatten any arrays or objects from LLM output into provenance-wrapped strings.
     */
    _flattenFields(fields, currentTurn) {
        const flat = {};

        for (const [key, value] of Object.entries(fields)) {
            if (value === null || value === undefined) continue;

            let stringValue;
            if (Array.isArray(value)) {
                if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
                    stringValue = value.map(v => v.target ? `${v.target}: ${v.nature || ''}` : JSON.stringify(v)).join(', ');
                } else {
                    stringValue = value.join(', ');
                }
            } else if (typeof value === 'object') {
                // Check if it's already a provenance object
                if ('value' in value && 'sourceTurns' in value) {
                    flat[key] = value;
                    continue;
                }
                // Nested object — promote children
                for (const [subKey, subVal] of Object.entries(value)) {
                    if (subVal === null || subVal === undefined) continue;
                    if (Array.isArray(subVal)) {
                        flat[subKey] = wrapField(subVal.join(', '), currentTurn);
                    } else {
                        flat[subKey] = wrapField(String(subVal), currentTurn);
                    }
                }
                continue;
            } else {
                stringValue = value;
            }

            flat[key] = wrapField(String(stringValue), currentTurn);
        }

        return flat;
    }

    /**
     * Merge new fields into existing fields with provenance tracking.
     */
    _mergeFields(existing, updated, currentTurn) {
        if (!updated) return { ...existing };
        if (!existing) return { ...updated };

        const merged = { ...existing };

        for (const [key, newVal] of Object.entries(updated)) {
            if (newVal === null || newVal === undefined) continue;

            const existingVal = merged[key];

            if (existingVal && typeof existingVal === 'object' && 'value' in existingVal) {
                // Existing is provenance-wrapped
                const newPlain = (typeof newVal === 'object' && 'value' in newVal)
                    ? newVal.value : String(newVal);
                if (newPlain && newPlain !== existingVal.value) {
                    merged[key] = updateFieldProvenance(existingVal, newPlain, currentTurn);
                }
            } else {
                // Existing is plain or doesn't exist — just set new value
                merged[key] = newVal;
            }
        }

        return merged;
    }

    /**
     * Detect field-level conflicts between existing and updated entity.
     * Handles provenance-wrapped fields by unwrapping for comparison.
     */
    _detectConflicts(existing, updated, turn) {
        const conflicts = [];
        if (!updated.fields || !existing.fields) return conflicts;

        for (const [key, newVal] of Object.entries(updated.fields)) {
            if (newVal === null || newVal === undefined) continue;

            // Mutable fields change naturally over time — not conflicts
            if (MUTABLE_FIELDS.has(key)) continue;

            const oldVal = existing.fields[key];
            if (oldVal === undefined || oldVal === null || oldVal === '') continue;

            // Unwrap provenance for comparison
            const oldPlain = unwrapField(oldVal);
            const newPlain = unwrapField(newVal);

            if (!oldPlain || !newPlain) continue;
            if (typeof oldPlain !== 'string' || typeof newPlain !== 'string') continue;
            if (oldPlain.trim() === '' || newPlain.trim() === '') continue;
            if (oldPlain === newPlain) continue;

            // Skip if new value is a superset of old (appending info, not contradicting)
            if (newPlain.includes(oldPlain)) continue;

            // Skip rephrasing: if old and new share most content words, it's not a real conflict
            if (this._isRephrasing(oldPlain, newPlain)) continue;

            conflicts.push({
                field: key,
                oldValue: oldPlain,
                newValue: newPlain,
                detectedTurn: turn,
                resolved: false,
            });
        }

        return conflicts;
    }

    /**
     * Check if two values are likely a rephrasing of the same idea.
     * Tokenizes into content words and checks overlap ratio.
     * High overlap = rephrasing, low overlap = genuine conflict.
     *
     * CJK-aware: splits CJK runs into bigrams (2-char shingles) since
     * Chinese/Japanese/Korean text has no word-separating whitespace.
     */
    _isRephrasing(oldText, newText, threshold = 0.6) {
        const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

        const tokenize = (text) => {
            const tokens = new Set();
            // Strip punctuation, normalize
            const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');

            for (const segment of cleaned.split(/\s+/)) {
                if (!segment) continue;
                if (CJK_RANGE.test(segment)) {
                    // CJK: emit character bigrams (shingles)
                    if (segment.length === 1) {
                        tokens.add(segment);
                    } else {
                        for (let i = 0; i < segment.length - 1; i++) {
                            tokens.add(segment.slice(i, i + 2));
                        }
                    }
                } else {
                    tokens.add(segment);
                }
            }
            return tokens;
        };

        const oldTokens = tokenize(oldText);
        const newTokens = tokenize(newText);

        if (oldTokens.size === 0 || newTokens.size === 0) return false;

        let shared = 0;
        for (const t of oldTokens) {
            if (newTokens.has(t)) shared++;
        }

        const minSize = Math.min(oldTokens.size, newTokens.size);
        return (shared / minSize) >= threshold;
    }

    /**
     * Merge new conflicts into existing list. For each field:
     * - Resolved conflicts are always kept (historical record)
     * - If there's already an unresolved conflict on the same field,
     *   replace it with the latest one (don't stack rephrasings)
     */
    _mergeConflicts(existing, incoming) {
        const merged = [...existing];

        for (const newConflict of incoming) {
            const staleIdx = merged.findIndex(
                c => !c.resolved && c.field === newConflict.field,
            );
            if (staleIdx !== -1) {
                // Replace stale unresolved conflict with latest
                merged[staleIdx] = newConflict;
            } else {
                merged.push(newConflict);
            }
        }

        return merged;
    }

    /**
     * Assign tier based on importance score.
     */
    _assignTier(importance) {
        if (importance >= 8) return 1;
        if (importance >= 4) return 2;
        return 3;
    }
}
