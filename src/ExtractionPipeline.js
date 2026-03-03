import { ExtractionPrompts } from './ExtractionPrompts.js';
import { generateId } from './Utils.js';

const CATEGORIES = ['characters', 'locations', 'mainCharacter', 'goals', 'events'];

export class ExtractionPipeline {
    constructor(apiClient, memoryStore, getSettings, decayEngine = null) {
        this.apiClient = apiClient;
        this.memoryStore = memoryStore;
        this.getSettings = getSettings;
        this.decayEngine = decayEngine;
    }

    /**
     * Run extraction on recent messages. Single unified API call for all 5 categories.
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

        // Step 4: Single unified extraction call
        const result = await this._extractAll(formattedMessages, currentState, context);

        if (result) {
            let mergeCount = 0;
            for (const category of CATEGORIES) {
                const entities = result[category];
                if (entities?.length) {
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
    async _extractAll(formattedMessages, currentState, context) {
        const systemPrompt = ExtractionPrompts.UNIFIED_SYSTEM;
        const userPrompt = ExtractionPrompts.getUnifiedUserPrompt(
            formattedMessages,
            currentState,
            context.name1,
            context.name2,
        );

        try {
            const response = await this.apiClient.chatCompletion([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ]);

            return this._parseUnifiedResponse(response);
        } catch (error) {
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
