import { ExtractionPrompts } from './ExtractionPrompts.js';
import { generateId } from './Utils.js';

const CATEGORIES = ['characters', 'locations', 'mainCharacter', 'goals', 'events'];

export class ExtractionPipeline {
    constructor(apiClient, memoryStore, getSettings) {
        this.apiClient = apiClient;
        this.memoryStore = memoryStore;
        this.getSettings = getSettings;
    }

    /**
     * Run extraction on recent messages. Calls all 5 categories in parallel.
     * Merges results into memoryStore.
     */
    async extract(context) {
        const settings = this.getSettings();
        const chat = context.chat;

        // Step 1: Gather recent messages
        const recentMessages = this._getRecentMessages(chat, settings.messagesPerExtraction);

        if (recentMessages.length === 0) {
            console.debug('[RP Memory] No messages to extract from');
            return;
        }

        // Step 2: Format messages with sender attribution and priority markers
        const formattedMessages = this._formatMessages(recentMessages, context.name1, context.name2, settings);

        // Step 3: Snapshot current memory state for diff-mode prompts
        const currentState = this.memoryStore.serialize();

        // Step 4: Run all 5 category extractions in parallel
        const results = await Promise.allSettled(
            CATEGORIES.map(category =>
                this._extractCategory(category, formattedMessages, currentState, context),
            ),
        );

        // Step 5: Process results, merge into memory store
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < CATEGORIES.length; i++) {
            const category = CATEGORIES[i];
            const result = results[i];

            if (result.status === 'fulfilled' && result.value) {
                try {
                    this._mergeResult(category, result.value);
                    successCount++;
                } catch (mergeError) {
                    console.warn(`[RP Memory] Merge failed for ${category}:`, mergeError);
                    failCount++;
                }
            } else if (result.status === 'rejected') {
                console.warn(`[RP Memory] Extraction failed for ${category}:`, result.reason);
                failCount++;
            } else {
                // fulfilled but null (empty response or parse failure)
                successCount++;
            }
        }

        if (settings.debugMode) {
            console.debug(`[RP Memory] Extraction complete: ${successCount} succeeded, ${failCount} failed`);
        }
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
     * Run extraction for a single category via OpenRouter.
     */
    async _extractCategory(category, formattedMessages, currentState, context) {
        const categoryState = category === 'mainCharacter'
            ? (currentState.mainCharacter ? { main_character: currentState.mainCharacter } : {})
            : (currentState[category] || {});

        const systemPrompt = ExtractionPrompts.getSystemPrompt(category);
        const userPrompt = ExtractionPrompts.getUserPrompt(
            category,
            formattedMessages,
            categoryState,
            context.name1,
            context.name2,
        );

        const response = await this.apiClient.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]);

        return this._parseResponse(response);
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

                this.memoryStore.updateEntity(category, entityId, {
                    fields: mergedFields,
                    importance: entity.importance ?? existing.importance,
                    baseScore: entity.importance ?? existing.baseScore,
                    lastMentionedTurn: currentTurn,
                    tier: this._assignTier(entity.importance ?? existing.importance),
                    conflicts: [...(existing.conflicts || []), ...conflicts],
                });
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

            // For MC status, do a deeper merge
            if (entity.fields?.status && existing.fields?.status) {
                mergedFields.status = this._mergeFields(existing.fields.status, entity.fields.status);
            }

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
     * Merge new fields into existing fields.
     * Only overwrites fields that are present in the new data.
     * For arrays, replaces entirely (not appends) — the LLM should output the full updated array.
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
