import { deepClone } from './Utils.js';

const CATEGORIES = ['characters', 'locations', 'goals', 'events'];

export class MemoryStore {
    constructor() {
        this._state = this._createEmptyState();
    }

    _createEmptyState() {
        return {
            version: 2,
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
        };
    }

    load(savedState) {
        if (!savedState) {
            this._state = this._createEmptyState();
            return;
        }

        if (savedState.version === 1) {
            // Migrate v1 → v2: convert plain string fields to provenance objects
            this._state = deepClone(savedState);
            this._state.version = 2;
            this._state.extractionInProgress = false;
            this._state.lastReflectionTurn = 0;
            this._state.beats = [];
            this._state.reflections = [];
            delete this._state._embeddings;

            // Migrate field values to provenance format
            this._migrateFieldsToProvenance();
            // Ensure aliases exist on all entities
            this._ensureAliases();
        } else if (savedState.version === 2) {
            this._state = deepClone(savedState);
            this._state.extractionInProgress = false;
            delete this._state._embeddings;
            // Ensure arrays exist (defensive)
            if (!Array.isArray(this._state.beats)) this._state.beats = [];
            if (!Array.isArray(this._state.reflections)) this._state.reflections = [];
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
        this._state.beats.push(beat);
    }

    getBeats() {
        return this._state.beats;
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
        return this._state.reflections;
    }

    getRecentReflections(n) {
        return this._state.reflections
            .slice()
            .sort((a, b) => b.storyTurn - a.storyTurn)
            .slice(0, n);
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
