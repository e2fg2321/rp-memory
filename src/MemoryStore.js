import { deepClone } from './Utils.js';

const CATEGORIES = ['characters', 'locations', 'goals', 'events'];

export class MemoryStore {
    constructor() {
        this._state = this._createEmptyState();
    }

    _createEmptyAuthorDirection() {
        return {
            mode: 'auto',
            source: 'auto',
            text: '',
            label: '',
            suggestionId: '',
            updatedTurn: 0,
        };
    }

    _createEmptyState() {
        return {
            version: 3,
            lastExtractionTurn: 0,
            lastReflectionTurn: 0,
            extractionInProgress: false,
            turnCounter: 0,
            characters: {},
            locations: {},
            mainCharacter: null,
            goals: {},
            events: {},
            beats: [],
            reflections: [],
            authorDirection: this._createEmptyAuthorDirection(),
        };
    }

    load(savedState) {
        if (!savedState) {
            this._state = this._createEmptyState();
            return;
        }

        if (savedState.version === 1) {
            // Migrate v1 state to the latest schema: provenance-wrapped fields + author direction support
            this._state = deepClone(savedState);
            this._state.version = 3;
            this._state.extractionInProgress = false;
            this._state.lastReflectionTurn = 0;
            this._state.beats = [];
            this._state.reflections = [];
            delete this._state._embeddings;

            // Migrate field values to provenance format
            this._migrateFieldsToProvenance();
            // Ensure aliases exist on all entities
            this._ensureAliases();
            this._ensureAuthorDirection();
        } else if (savedState.version === 2 || savedState.version === 3) {
            this._state = deepClone(savedState);
            this._state.version = 3;
            this._state.extractionInProgress = false;
            delete this._state._embeddings;
            // Ensure arrays exist (defensive)
            if (!Array.isArray(this._state.beats)) this._state.beats = [];
            if (!Array.isArray(this._state.reflections)) this._state.reflections = [];
            this._ensureAliases();
            this._ensureAuthorDirection();
        } else {
            this._state = this._createEmptyState();
        }
    }

    /**
     * Migrate v1 plain-string fields to provenance-wrapped { value, sourceTurns, lastUpdated }.
     */
    _migrateFieldsToProvenance() {
        const migrateEntity = (entity) => {
            if (!entity || !entity.fields) return;
            for (const [key, value] of Object.entries(entity.fields)) {
                if (value === null || value === undefined) continue;
                // Skip if already provenance-wrapped
                if (typeof value === 'object' && 'value' in value) continue;
                // Convert plain values
                entity.fields[key] = {
                    value: String(value),
                    sourceTurns: [],
                    lastUpdated: 0,
                };
            }
        };

        // Main character
        if (this._state.mainCharacter) {
            migrateEntity(this._state.mainCharacter);
        }

        // All other categories
        for (const cat of CATEGORIES) {
            const entities = this._state[cat] || {};
            for (const entity of Object.values(entities)) {
                migrateEntity(entity);
            }
        }
    }

    /**
     * Ensure all entities have an aliases array.
     */
    _ensureAliases() {
        const ensureEntity = (entity) => {
            if (!entity) return;
            if (!Array.isArray(entity.aliases)) entity.aliases = [];
        };

        if (this._state.mainCharacter) {
            ensureEntity(this._state.mainCharacter);
        }

        for (const cat of CATEGORIES) {
            const entities = this._state[cat] || {};
            for (const entity of Object.values(entities)) {
                ensureEntity(entity);
            }
        }
    }

    _ensureAuthorDirection() {
        const fallback = this._createEmptyAuthorDirection();
        const current = this._state.authorDirection;
        if (!current || typeof current !== 'object') {
            this._state.authorDirection = fallback;
            return;
        }

        this._state.authorDirection = {
            ...fallback,
            ...current,
            mode: ['auto', 'custom', 'suggested'].includes(current.mode) ? current.mode : 'auto',
            source: ['auto', 'custom', 'suggested'].includes(current.source) ? current.source : 'auto',
            text: typeof current.text === 'string' ? current.text : '',
            label: typeof current.label === 'string' ? current.label : '',
            suggestionId: typeof current.suggestionId === 'string' ? current.suggestionId : '',
            updatedTurn: Number.isFinite(current.updatedTurn) ? current.updatedTurn : 0,
        };
    }

    clear() {
        this._state = this._createEmptyState();
    }

    serialize() {
        return deepClone(this._state);
    }

    // --- Turn management ---

    getTurnCounter() {
        return this._state.turnCounter;
    }

    incrementTurn() {
        this._state.turnCounter++;
    }

    advanceTurn(n) {
        this._state.turnCounter += n;
    }

    getLastExtractionTurn() {
        return this._state.lastExtractionTurn;
    }

    setLastExtractionTurn(turn) {
        this._state.lastExtractionTurn = turn;
    }

    getLastReflectionTurn() {
        return this._state.lastReflectionTurn || 0;
    }

    setLastReflectionTurn(turn) {
        this._state.lastReflectionTurn = turn;
    }

    isExtractionInProgress() {
        return this._state.extractionInProgress;
    }

    setExtractionInProgress(val) {
        this._state.extractionInProgress = val;
    }

    // --- Author direction ---

    getAuthorDirection() {
        return deepClone(this._state.authorDirection || this._createEmptyAuthorDirection());
    }

    hasAuthorDirection() {
        const direction = this._state.authorDirection;
        return Boolean(direction?.mode !== 'auto' && direction?.text?.trim());
    }

    setAuthorDirection(direction) {
        const fallback = this._createEmptyAuthorDirection();
        const next = {
            ...fallback,
            ...(direction || {}),
        };

        next.mode = ['custom', 'suggested'].includes(next.mode) ? next.mode : 'custom';
        next.source = ['custom', 'suggested'].includes(next.source) ? next.source : next.mode;
        next.text = typeof next.text === 'string' ? next.text.trim() : '';
        next.label = typeof next.label === 'string' ? next.label.trim() : '';
        next.suggestionId = typeof next.suggestionId === 'string' ? next.suggestionId.trim() : '';
        next.updatedTurn = Number.isFinite(next.updatedTurn) ? next.updatedTurn : this.getTurnCounter();

        if (!next.text) {
            this.clearAuthorDirection();
            return;
        }

        this._state.authorDirection = next;
    }

    clearAuthorDirection() {
        this._state.authorDirection = this._createEmptyAuthorDirection();
    }

    // --- Entity CRUD ---

    getEntity(category, id) {
        if (category === 'mainCharacter') return this._state.mainCharacter;
        return this._state[category]?.[id] || null;
    }

    getAllEntities(category) {
        if (category === 'mainCharacter') {
            return this._state.mainCharacter
                ? { main_character: this._state.mainCharacter }
                : {};
        }
        return this._state[category] || {};
    }

    getEntitiesByTier(category, tiers) {
        const all = this.getAllEntities(category);
        return Object.values(all).filter(e => tiers.includes(e.tier));
    }

    addEntity(category, entity) {
        if (category === 'mainCharacter') {
            this._state.mainCharacter = entity;
        } else {
            this._state[category][entity.id] = entity;
        }
    }

    updateEntity(category, id, updates) {
        const entity = this.getEntity(category, id);
        if (!entity) return;
        Object.assign(entity, updates);
    }

    deleteEntity(category, id) {
        if (category === 'mainCharacter') {
            this._state.mainCharacter = null;
        } else if (this._state[category]) {
            delete this._state[category][id];
        }
    }

    getMainCharacter() {
        return this._state.mainCharacter;
    }

    /**
     * Find an entity by alias (case-insensitive) across all entities in a category.
     */
    findEntityByAlias(category, name) {
        const normalized = name.toLowerCase().trim();
        const entities = this.getAllEntities(category);
        for (const entity of Object.values(entities)) {
            if (entity.name.toLowerCase().trim() === normalized) return entity;
            if (entity.aliases?.some(a => a.toLowerCase().trim() === normalized)) return entity;
        }
        return null;
    }

    /**
     * Get counts per category for UI display.
     */
    getCounts() {
        return {
            characters: Object.keys(this._state.characters).length,
            locations: Object.keys(this._state.locations).length,
            mainCharacter: this._state.mainCharacter ? 1 : 0,
            goals: Object.keys(this._state.goals).length,
            events: Object.keys(this._state.events).length,
            beats: this._state.beats.length,
            reflections: this._state.reflections.length,
        };
    }

    /**
     * Get all entities across all categories with unresolved conflicts.
     */
    getConflicts() {
        const conflicts = [];
        const allCategories = ['mainCharacter', ...CATEGORIES];

        for (const cat of allCategories) {
            const entities = this.getAllEntities(cat);
            for (const entity of Object.values(entities)) {
                const unresolved = (entity.conflicts || []).filter(c => !c.resolved);
                if (unresolved.length > 0) {
                    conflicts.push({ category: cat, entity, conflicts: unresolved });
                }
            }
        }

        return conflicts;
    }

    /**
     * Auto-resolve conflicts that have gone stale (no user action for N turns).
     * Only call during incremental extraction — never during batch/full-history.
     * @param {number} currentTurn
     * @param {number} staleTurns - Turns after which unresolved conflicts auto-resolve
     * @returns {number} Number of conflicts auto-resolved
     */
    autoResolveStaleConflicts(currentTurn, staleTurns = 10) {
        let resolved = 0;
        const allCategories = ['mainCharacter', ...CATEGORIES];

        for (const cat of allCategories) {
            const entities = this.getAllEntities(cat);
            for (const entity of Object.values(entities)) {
                if (!entity.conflicts?.length) continue;
                for (const c of entity.conflicts) {
                    if (c.resolved) continue;
                    if (currentTurn - c.detectedTurn >= staleTurns) {
                        c.resolved = true;
                        c.autoResolved = true;
                        resolved++;
                    }
                }
            }
        }

        return resolved;
    }

    /**
     * Get total count of unresolved conflicts.
     */
    getConflictCount() {
        let count = 0;
        const allCategories = ['mainCharacter', ...CATEGORIES];

        for (const cat of allCategories) {
            const entities = this.getAllEntities(cat);
            for (const entity of Object.values(entities)) {
                count += (entity.conflicts || []).filter(c => !c.resolved).length;
            }
        }

        return count;
    }

    // --- Beats (Episodic Memory Layer 2) ---

    addBeat(beat) {
        // Dedup: skip if a beat with the same ID already exists
        if (this._state.beats.some(b => b.id === beat.id)) return;
        this._state.beats.push(beat);
    }

    getBeats() {
        return [...this._state.beats];
    }

    getRecentBeats(n) {
        return this._state.beats
            .slice()
            .sort((a, b) => b.storyTurn - a.storyTurn)
            .slice(0, n);
    }

    /**
     * Enforce max beats cap. When exceeded, drop oldest low-importance beats
     * (keeping those with importance >= 7).
     */
    enforceMaxBeats(maxBeats = 200) {
        if (this._state.beats.length <= maxBeats) return;

        // Sort by storyTurn ascending (oldest first)
        this._state.beats.sort((a, b) => a.storyTurn - b.storyTurn);

        // Keep recent 50 beats unconditionally
        const recentCutoff = this._state.beats.length - 50;
        const candidates = this._state.beats.slice(0, recentCutoff);
        const kept = this._state.beats.slice(recentCutoff);

        // From candidates, keep high-importance beats
        const filtered = candidates.filter(b => b.importance >= 7);

        this._state.beats = [...filtered, ...kept];

        // If still over cap, just truncate oldest
        if (this._state.beats.length > maxBeats) {
            this._state.beats = this._state.beats.slice(-maxBeats);
        }
    }

    /**
     * Replace beats array (used after compression).
     */
    setBeats(beats) {
        this._state.beats = beats;
    }

    // --- Reflections (Layer 3) ---

    addReflection(reflection) {
        this._state.reflections.push(reflection);
    }

    getReflections() {
        return [...this._state.reflections];
    }

    getRecentReflections(n) {
        return this._state.reflections
            .slice()
            .sort((a, b) => b.storyTurn - a.storyTurn)
            .slice(0, n);
    }

    /**
     * Prune low-importance events. Keeps events with importance >= minImportance
     * plus the most recent `keepRecent` events regardless of importance.
     */
    pruneEvents(minImportance = 6, keepRecent = 10) {
        const events = this._state.events;
        const entries = Object.entries(events);
        if (entries.length <= keepRecent) return;

        // Sort by createdTurn descending (newest first)
        entries.sort((a, b) => (b[1].createdTurn || 0) - (a[1].createdTurn || 0));

        const recentIds = new Set(entries.slice(0, keepRecent).map(([id]) => id));

        for (const [id, entity] of entries) {
            if (recentIds.has(id)) continue;
            if (entity.tier === 1) continue; // Never prune pinned
            if ((entity.importance || 0) < minImportance) {
                delete this._state.events[id];
            }
        }
    }

    /**
     * Prune completed/failed/abandoned goals that are no longer narratively relevant,
     * and retire (demote to tier-3) goals that haven't been mentioned for too long.
     *
     * @param {number} keepRecent - Always keep the N most recently created goals
     * @param {number} currentTurn - Current story turn (for staleness check)
     * @param {number} retireAfterTurns - Demote to tier-3 after this many turns without mention (0 = disabled)
     */
    pruneGoals(keepRecent = 5, currentTurn = 0, retireAfterTurns = 50) {
        const goals = this._state.goals;
        const entries = Object.entries(goals);
        if (entries.length <= keepRecent) return;

        const TERMINAL_STATUSES = new Set(['completed', 'failed', 'abandoned']);

        // Sort by createdTurn descending (newest first)
        entries.sort((a, b) => (b[1].createdTurn || 0) - (a[1].createdTurn || 0));

        const recentIds = new Set(entries.slice(0, keepRecent).map(([id]) => id));

        for (const [id, entity] of entries) {
            if (recentIds.has(id)) continue;

            // Delete terminal goals (completed/failed/abandoned) unless pinned or high-importance
            const status = entity.fields?.status;
            const statusVal = typeof status === 'object' && status !== null && 'value' in status
                ? status.value : status;
            if (TERMINAL_STATUSES.has(statusVal) && entity.tier !== 1 && (entity.importance || 0) < 8) {
                delete this._state.goals[id];
                continue;
            }

            // Retire stale goals: demote to tier-3 if not mentioned for retireAfterTurns
            if (retireAfterTurns > 0 && currentTurn > 0 && entity.tier !== 3) {
                const lastMention = entity.lastMentionedTurn || entity.createdTurn || 0;
                const turnsSince = currentTurn - lastMention;
                if (turnsSince >= retireAfterTurns) {
                    entity.tier = 3;
                }
            }
        }
    }

    /**
     * Enforce max reflections cap.
     * When exceeded, drop oldest low-importance reflections.
     */
    enforceMaxReflections(maxReflections = 30) {
        if (this._state.reflections.length <= maxReflections) return;

        // Sort by importance descending, then by storyTurn descending
        this._state.reflections.sort((a, b) =>
            b.importance - a.importance || b.storyTurn - a.storyTurn,
        );

        this._state.reflections = this._state.reflections.slice(0, maxReflections);
    }
}
