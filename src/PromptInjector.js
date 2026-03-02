import { estimateTokens } from './Utils.js';

export class PromptInjector {
    constructor(getSettings) {
        this.getSettings = getSettings;
    }

    /**
     * Format all Tier 1 + Tier 2 entities into a prompt string.
     * Returns empty string if no entities to inject.
     */
    format(memoryStore) {
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
