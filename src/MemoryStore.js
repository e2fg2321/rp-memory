import { deepClone } from './Utils.js';

const CATEGORIES = ['characters', 'locations', 'goals', 'events'];

export class MemoryStore {
    constructor() {
        this._state = this._createEmptyState();
    }

    _createEmptyState() {
        return {
            version: 1,
            lastExtractionTurn: 0,
            extractionInProgress: false,
            turnCounter: 0,
            characters: {},
            locations: {},
            mainCharacter: null,
            goals: {},
            events: {},
        };
    }

    load(savedState) {
        if (savedState && savedState.version === 1) {
            this._state = deepClone(savedState);
            // Ensure extractionInProgress is reset on load (in case of crash mid-extraction)
            this._state.extractionInProgress = false;
        } else {
            this._state = this._createEmptyState();
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
     * Get counts per category for UI display.
     */
    getCounts() {
        return {
            characters: Object.keys(this._state.characters).length,
            locations: Object.keys(this._state.locations).length,
            mainCharacter: this._state.mainCharacter ? 1 : 0,
            goals: Object.keys(this._state.goals).length,
            events: Object.keys(this._state.events).length,
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
}
