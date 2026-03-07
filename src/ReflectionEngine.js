import { ReflectionPrompts } from './ReflectionPrompts.js';
import { unwrapField } from './Utils.js';

export class ReflectionEngine {
    constructor(apiClient, memoryStore, getSettings, getLang) {
        this.apiClient = apiClient;
        this.memoryStore = memoryStore;
        this.getSettings = getSettings;
        this.getLang = getLang || (() => 'en');
        this._abortController = null;
    }

    /**
     * Abort any in-progress reflection or compression.
     */
    abort() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    }

    /**
     * Check whether it's time to run a reflection.
     * Triggers when cumulative importance of new beats since last reflection
     * exceeds the configured threshold.
     */
    shouldReflect() {
        const settings = this.getSettings();
        if (!settings.reflectionEnabled) return false;

        const threshold = settings.reflectionThreshold || 30;
        const lastReflectionTurn = this.memoryStore.getLastReflectionTurn();
        const beats = this.memoryStore.getBeats();
        const newBeats = beats.filter(b => b.storyTurn > lastReflectionTurn);
        const totalImportance = newBeats.reduce((sum, b) => sum + (b.importance || 0), 0);

        return totalImportance >= threshold;
    }

    /**
     * Run reflection: gather recent beats + entity state, ask LLM for observations.
     * Returns true if reflections were generated, false otherwise.
     */
    async reflect() {
        const settings = this.getSettings();
        const lang = this.getLang();
        const lastReflectionTurn = this.memoryStore.getLastReflectionTurn();

        // Gather recent beats since last reflection
        const allBeats = this.memoryStore.getBeats();
        const recentBeats = allBeats
            .filter(b => b.storyTurn > lastReflectionTurn)
            .sort((a, b) => a.storyTurn - b.storyTurn)
            .slice(-20); // Cap at 20 beats for prompt size

        if (recentBeats.length === 0) {
            if (settings.debugMode) {
                console.debug('[RP Memory] Reflection: no new beats to reflect on');
            }
            return false;
        }

        // Gather key entities (Tier 1-2) across categories — include IDs for participant matching
        const categories = ['mainCharacter', 'characters', 'locations', 'goals', 'events'];
        const keyEntities = [];
        for (const category of categories) {
            const entities = this.memoryStore.getEntitiesByTier(category, [1, 2]);
            for (const entity of entities) {
                keyEntities.push({
                    id: entity.id,
                    name: entity.name,
                    category,
                    importance: entity.importance,
                });
            }
        }

        // Build prompt
        const systemPrompt = lang === 'zh'
            ? ReflectionPrompts.REFLECTION_SYSTEM_ZH
            : ReflectionPrompts.REFLECTION_SYSTEM;
        const userPrompt = ReflectionPrompts.getReflectionUserPrompt(recentBeats, keyEntities, lang);

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        this._abortController = new AbortController();

        try {
            const signal = this._abortController.signal;
            const response = await this.apiClient.chatCompletion(messages, signal, null, { temperature: 0.3 });
            const reflections = this._parseReflectionResponse(response);

            if (reflections && reflections.length > 0) {
                const currentTurn = this.memoryStore.getTurnCounter();
                // Use the max beat storyTurn as the reflection's narrative timestamp
                const narrativeTurn = Math.max(...recentBeats.map(b => b.storyTurn));

                for (let i = 0; i < reflections.length; i++) {
                    const ref = reflections[i];
                    this.memoryStore.addReflection({
                        id: `reflection-${currentTurn}-${ref.type || 'obs'}-${i}`,
                        type: ref.type || 'plot_thread',
                        horizon: ref.horizon || 'short',
                        branch: ref.branch || 'plot',
                        text: ref.text,
                        participants: Array.isArray(ref.participants) ? ref.participants : [],
                        sourceTurns: recentBeats.map(b => b.storyTurn),
                        storyTurn: narrativeTurn,
                        importance: ref.importance || 7,
                    });
                }

                this.memoryStore.setLastReflectionTurn(currentTurn);

                // Enforce max reflections
                const maxReflections = settings.maxReflections || 30;
                this.memoryStore.enforceMaxReflections(maxReflections);

                if (settings.debugMode) {
                    console.debug(`[RP Memory] Reflection complete: ${reflections.length} observations generated`);
                }
                return true;
            }
        } catch (err) {
            if (err?.name === 'AbortError') {
                console.debug('[RP Memory] Reflection aborted');
                return false;
            }
            console.warn('[RP Memory] Reflection failed:', err.message);
        } finally {
            this._abortController = null;
        }
        return false;
    }

    /**
     * Compress old beats when count exceeds the cap.
     * Groups old beats by temporal windows, then by type within each window.
     */
    async compress() {
        const settings = this.getSettings();
        const maxBeats = settings.maxBeats || 200;
        const beats = this.memoryStore.getBeats();

        if (beats.length <= maxBeats) return;

        if (settings.debugMode) {
            console.debug(`[RP Memory] Beat compression: ${beats.length} beats, cap is ${maxBeats}`);
        }

        // Work on a sorted copy (getBeats now returns a copy)
        const sorted = beats.sort((a, b) => a.storyTurn - b.storyTurn);

        // Keep the last 50 beats as-is (recent detail)
        const recentCutoff = sorted.length - 50;
        const oldBeats = sorted.slice(0, recentCutoff);
        const recentBeats = sorted.slice(recentCutoff);

        // Group by temporal windows of ~10 turns, then subdivide by type
        const windowSize = 10;
        const windows = [];
        let currentWindow = [];
        let windowStart = oldBeats.length > 0 ? oldBeats[0].storyTurn : 0;

        for (const beat of oldBeats) {
            if (beat.storyTurn - windowStart >= windowSize && currentWindow.length > 0) {
                windows.push(currentWindow);
                currentWindow = [];
                windowStart = beat.storyTurn;
            }
            currentWindow.push(beat);
        }
        if (currentWindow.length > 0) windows.push(currentWindow);

        // Compress each window
        const summaryBeats = [];
        const lang = this.getLang();
        this._abortController = new AbortController();

        try {
            for (const windowBeats of windows) {
                if (this._abortController?.signal?.aborted) break;

                if (windowBeats.length < 3) {
                    summaryBeats.push(...windowBeats);
                    continue;
                }

                // Within each window, group by type for coherent summaries
                const byType = {};
                for (const beat of windowBeats) {
                    const key = beat.type || 'transition';
                    if (!byType[key]) byType[key] = [];
                    byType[key].push(beat);
                }

                for (const [type, groupBeats] of Object.entries(byType)) {
                    if (groupBeats.length < 2) {
                        summaryBeats.push(...groupBeats);
                        continue;
                    }

                    try {
                        const summary = await this._compressGroup(groupBeats, lang);
                        if (summary) {
                            const allParticipants = [...new Set(groupBeats.flatMap(b => b.participants || []))];
                            const allTurns = groupBeats.map(b => b.storyTurn);
                            summaryBeats.push({
                                id: `beat-summary-${allTurns[0]}-${allTurns[allTurns.length - 1]}`,
                                text: summary.text,
                                participants: allParticipants,
                                sourceTurns: allTurns,
                                storyTurn: allTurns[allTurns.length - 1],
                                importance: summary.importance || Math.max(...groupBeats.map(b => b.importance || 5)),
                                type,
                                compressed: true,
                            });
                        } else {
                            summaryBeats.push(...groupBeats.filter(b => b.importance >= 7));
                        }
                    } catch (err) {
                        if (err?.name === 'AbortError') break;
                        console.warn('[RP Memory] Beat compression failed for group:', err.message);
                        summaryBeats.push(...groupBeats.filter(b => b.importance >= 7));
                    }
                }
            }
        } finally {
            this._abortController = null;
        }

        // Rebuild beats: summaries + recent
        const newBeats = [...summaryBeats, ...recentBeats];
        this.memoryStore.setBeats(newBeats);

        if (settings.debugMode) {
            console.debug(`[RP Memory] Beat compression complete: ${beats.length} -> ${newBeats.length} beats`);
        }
    }

    /**
     * Compress a group of beats into a single summary via LLM.
     */
    async _compressGroup(beats, lang) {
        const systemPrompt = lang === 'zh'
            ? ReflectionPrompts.COMPRESSION_SYSTEM_ZH
            : ReflectionPrompts.COMPRESSION_SYSTEM;
        const userPrompt = ReflectionPrompts.getCompressionUserPrompt(beats, lang);

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        const signal = this._abortController?.signal;
        const response = await this.apiClient.chatCompletion(messages, signal);
        return this._parseJSON(response);
    }

    /**
     * Parse reflection response (array of observation objects).
     */
    _parseReflectionResponse(responseText) {
        const parsed = this._parseJSON(responseText);
        if (Array.isArray(parsed)) return parsed;
        return null;
    }

    /**
     * Parse JSON from LLM response, stripping code fences.
     */
    _parseJSON(responseText) {
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
            return JSON.parse(cleaned);
        } catch (e) {
            console.warn('[RP Memory] Failed to parse reflection/compression response:', e.message);
            if (this.getSettings().debugMode) {
                console.debug('[RP Memory] Raw response:', responseText);
            }
            return null;
        }
    }
}
