import { estimateTokens } from './Utils.js';

export class PromptInjector {
    constructor(getSettings) {
        this.getSettings = getSettings;
    }

    /**
     * Format entities into a prompt string.
     *
     * If relevantEntities is provided (from embedding ranking), uses that list
     * with budget enforcement. Tier 1 entities from the list are always included.
     *
     * If relevantEntities is null, falls back to the original behavior:
     * all Tier 1 + Tier 2 entities injected.
     *
     * @param {object} memoryStore
     * @param {Array<{category: string, entity: object, score: number}>|null} relevantEntities
     * @returns {string}
     */
    format(memoryStore, relevantEntities = null) {
        if (relevantEntities !== null) {
            return this._formatWithBudget(relevantEntities);
        }
        return this._formatAll(memoryStore);
    }

    /**
     * Original behavior: format all Tier 1 + Tier 2 entities.
     */
    _formatAll(memoryStore) {
        const sections = [];

        const mc = memoryStore.getMainCharacter();
        if (mc && mc.tier <= 2) {
            sections.push(this._formatMainCharacter(mc));
        }

        const characters = memoryStore.getEntitiesByTier('characters', [1, 2]);
        if (characters.length > 0) {
            sections.push(this._formatCharacters(characters));
        }

        const locations = memoryStore.getEntitiesByTier('locations', [1, 2]);
        if (locations.length > 0) {
            sections.push(this._formatLocations(locations));
        }

        const goals = memoryStore.getEntitiesByTier('goals', [1, 2]);
        if (goals.length > 0) {
            sections.push(this._formatGoals(goals));
        }

        const events = memoryStore.getEntitiesByTier('events', [1, 2]);
        if (events.length > 0) {
            sections.push(this._formatEvents(events));
        }

        if (sections.length === 0) return '';

        return `[RP Memory - World State]\n${sections.join('\n\n')}\n[/RP Memory]`;
    }

    /**
     * Budget-aware formatting: include entities in rank order, stopping when budget is reached.
     * Tier 1 (pinned) entities are always included first.
     */
    _formatWithBudget(relevantEntities) {
        const budget = this.getSettings().tokenBudget;

        // Separate pinned vs ranked
        const pinned = relevantEntities.filter(e => e.entity.tier === 1);
        const ranked = relevantEntities.filter(e => e.entity.tier !== 1);

        // Group by category for formatting
        const included = { mainCharacter: [], characters: [], locations: [], goals: [], events: [] };

        let currentTokens = estimateTokens('[RP Memory - World State]\n[/RP Memory]');

        // Always include pinned entities
        for (const item of pinned) {
            const entityText = this._formatSingleEntity(item.category, item.entity);
            const entityTokens = estimateTokens(entityText);
            included[item.category].push(item.entity);
            currentTokens += entityTokens;
        }

        // Add ranked entities until budget is reached
        for (const item of ranked) {
            const entityText = this._formatSingleEntity(item.category, item.entity);
            const entityTokens = estimateTokens(entityText);

            if (budget > 0 && (currentTokens + entityTokens) > budget) {
                break;
            }

            included[item.category].push(item.entity);
            currentTokens += entityTokens;
        }

        // Build sections from included entities
        const sections = [];

        if (included.mainCharacter.length > 0) {
            sections.push(this._formatMainCharacter(included.mainCharacter[0]));
        }
        if (included.characters.length > 0) {
            sections.push(this._formatCharacters(included.characters));
        }
        if (included.locations.length > 0) {
            sections.push(this._formatLocations(included.locations));
        }
        if (included.goals.length > 0) {
            sections.push(this._formatGoals(included.goals));
        }
        if (included.events.length > 0) {
            sections.push(this._formatEvents(included.events));
        }

        if (sections.length === 0) return '';

        return `[RP Memory - World State]\n${sections.join('\n\n')}\n[/RP Memory]`;
    }

    /**
     * Format a single entity into text (used for token estimation during budget enforcement).
     */
    _formatSingleEntity(category, entity) {
        switch (category) {
            case 'mainCharacter':
                return this._formatMainCharacter(entity);
            case 'characters':
                return this._formatCharacters([entity]);
            case 'locations':
                return this._formatLocations([entity]);
            case 'goals':
                return this._formatGoals([entity]);
            case 'events':
                return this._formatEvents([entity]);
            default:
                return '';
        }
    }

    /**
     * Get the estimated token count of the current injection.
     */
    getTokenCount(memoryStore) {
        const text = this.format(memoryStore);
        return estimateTokens(text);
    }

    _formatMainCharacter(mc) {
        const f = mc.fields;
        const lines = [`## Main Character: ${mc.name}`];

        if (f.description) lines.push(`Description: ${f.description}`);

        if (f.status) {
            if (f.status.health) lines.push(`Health: ${f.status.health}`);
            if (f.status.conditions?.length) lines.push(`Conditions: ${f.status.conditions.join(', ')}`);
            if (f.status.buffs?.length) lines.push(`Buffs: ${f.status.buffs.join(', ')}`);
        }

        if (f.skills?.length) lines.push(`Skills: ${f.skills.join(', ')}`);
        if (f.inventory?.length) lines.push(`Inventory: ${f.inventory.join(', ')}`);

        return lines.join('\n');
    }

    _formatCharacters(characters) {
        const lines = ['## Known Characters'];
        characters.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));

        for (const c of characters) {
            const tierMarker = c.tier === 1 ? ' [PINNED]' : '';
            lines.push(`- ${c.name}${tierMarker}: ${c.fields.description || 'No description'}`);
            if (c.fields.personality) lines.push(`  Personality: ${c.fields.personality}`);
            if (c.fields.status) lines.push(`  Status: ${c.fields.status}`);
            if (c.fields.relationships?.length) {
                const rels = c.fields.relationships.map(r => `${r.target}: ${r.nature}`).join('; ');
                lines.push(`  Relationships: ${rels}`);
            }
        }

        return lines.join('\n');
    }

    _formatLocations(locations) {
        const lines = ['## Known Locations'];
        locations.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));

        for (const loc of locations) {
            const tierMarker = loc.tier === 1 ? ' [PINNED]' : '';
            lines.push(`- ${loc.name}${tierMarker}: ${loc.fields.description || 'No description'}`);
            if (loc.fields.atmosphere) lines.push(`  Atmosphere: ${loc.fields.atmosphere}`);
            if (loc.fields.notableFeatures?.length) {
                lines.push(`  Features: ${loc.fields.notableFeatures.join(', ')}`);
            }
        }

        return lines.join('\n');
    }

    _formatGoals(goals) {
        const lines = ['## Active Goals'];
        goals.sort((a, b) => (b.importance - a.importance));

        for (const g of goals) {
            const status = g.fields.status || 'in_progress';
            lines.push(`- ${g.name} [${status}]: ${g.fields.description || 'No description'}`);
            if (g.fields.progress) lines.push(`  Progress: ${g.fields.progress}`);
            if (g.fields.blockers) lines.push(`  Blockers: ${g.fields.blockers}`);
        }

        return lines.join('\n');
    }

    _formatEvents(events) {
        const lines = ['## Major Events'];
        events.sort((a, b) => (b.fields.turn || b.createdTurn) - (a.fields.turn || a.createdTurn));

        for (const e of events) {
            const turn = e.fields.turn || e.createdTurn;
            lines.push(`- Turn ${turn}: ${e.name} — ${e.fields.description || 'No description'}`);
            if (e.fields.consequences) lines.push(`  Consequences: ${e.fields.consequences}`);
        }

        return lines.join('\n');
    }
}
