import { estimateTokens } from './Utils.js';

const LABELS = {
    en: {
        worldStateOpen: '[RP Memory - World State]',
        worldStateClose: '[/RP Memory]',
        mainCharacter: 'Main Character',
        knownCharacters: 'Known Characters',
        knownLocations: 'Known Locations',
        activeGoals: 'Active Goals',
        majorEvents: 'Major Events',
        pinned: 'PINNED',
        noDescription: 'No description',
        noDetails: 'No details',
        description: 'Description',
        health: 'Health',
        conditions: 'Conditions',
        buffs: 'Buffs',
        skills: 'Skills',
        inventory: 'Inventory',
        personality: 'Personality',
        status: 'Status',
        relationships: 'Relationships',
        atmosphere: 'Atmosphere',
        features: 'Features',
        progress: 'Progress',
        blockers: 'Blockers',
        turn: 'Turn',
        consequences: 'Consequences',
    },
    zh: {
        worldStateOpen: '[RP Memory - 世界状态]',
        worldStateClose: '[/RP Memory]',
        mainCharacter: '主角',
        knownCharacters: '已知角色',
        knownLocations: '已知地点',
        activeGoals: '活跃目标',
        majorEvents: '重大事件',
        pinned: '置顶',
        noDescription: '暂无描述',
        noDetails: '暂无详情',
        description: '描述',
        health: '生命值',
        conditions: '状态',
        buffs: '增益',
        skills: '技能',
        inventory: '物品栏',
        personality: '性格',
        status: '状态',
        relationships: '关系',
        atmosphere: '氛围',
        features: '特征',
        progress: '进度',
        blockers: '阻碍',
        turn: '回合',
        consequences: '后果',
    },
};

export class PromptInjector {
    constructor(getSettings, getLang = null) {
        this.getSettings = getSettings;
        this.getLang = getLang || (() => 'en');
    }

    get labels() {
        const lang = this.getLang();
        return LABELS[lang] || LABELS.en;
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

        const l = this.labels;
        return `${l.worldStateOpen}\n${sections.join('\n\n')}\n${l.worldStateClose}`;
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

        const l = this.labels;
        let currentTokens = estimateTokens(`${l.worldStateOpen}\n${l.worldStateClose}`);

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

        return `${l.worldStateOpen}\n${sections.join('\n\n')}\n${l.worldStateClose}`;
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

    /**
     * Backward-compatible string coercion. Handles old data formats
     * (arrays, objects) and new flat strings uniformly.
     */
    _str(value) {
        if (!value) return '';
        if (Array.isArray(value)) {
            if (value.length && typeof value[0] === 'object') {
                return value.map(v => v.target ? `${v.target}: ${v.nature}` : JSON.stringify(v)).join(', ');
            }
            return value.join(', ');
        }
        if (typeof value === 'object') {
            return Object.entries(value)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
                .filter(([, v]) => v)
                .join(', ');
        }
        return String(value);
    }

    _formatMainCharacter(mc) {
        const f = mc.fields;
        const l = this.labels;
        const lines = [`## ${l.mainCharacter}: ${mc.name}`];

        if (f.description) lines.push(`${l.description}: ${f.description}`);

        // Flat fields (new format)
        const health = this._str(f.health) || this._str(f.status?.health);
        const conditions = this._str(f.conditions) || this._str(f.status?.conditions);
        const buffs = this._str(f.buffs) || this._str(f.status?.buffs);

        if (health) lines.push(`${l.health}: ${health}`);
        if (conditions) lines.push(`${l.conditions}: ${conditions}`);
        if (buffs) lines.push(`${l.buffs}: ${buffs}`);

        const skills = this._str(f.skills);
        const inventory = this._str(f.inventory);
        if (skills) lines.push(`${l.skills}: ${skills}`);
        if (inventory) lines.push(`${l.inventory}: ${inventory}`);

        return lines.join('\n');
    }

    _formatCharacters(characters) {
        const l = this.labels;
        const lines = [`## ${l.knownCharacters}`];
        characters.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));

        for (const c of characters) {
            const tierMarker = c.tier === 1 ? ` [${l.pinned}]` : '';
            lines.push(`- ${c.name}${tierMarker}: ${c.fields.description || l.noDescription}`);
            if (c.fields.personality) lines.push(`  ${l.personality}: ${c.fields.personality}`);
            if (c.fields.status) lines.push(`  ${l.status}: ${this._str(c.fields.status)}`);
            const rels = this._str(c.fields.relationships);
            if (rels) lines.push(`  ${l.relationships}: ${rels}`);
        }

        return lines.join('\n');
    }

    _formatLocations(locations) {
        const l = this.labels;
        const lines = [`## ${l.knownLocations}`];
        locations.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));

        for (const loc of locations) {
            const tierMarker = loc.tier === 1 ? ` [${l.pinned}]` : '';
            lines.push(`- ${loc.name}${tierMarker}: ${loc.fields.description || l.noDescription}`);
            if (loc.fields.atmosphere) lines.push(`  ${l.atmosphere}: ${loc.fields.atmosphere}`);
            const features = this._str(loc.fields.notableFeatures);
            if (features) lines.push(`  ${l.features}: ${features}`);
        }

        return lines.join('\n');
    }

    _formatGoals(goals) {
        const l = this.labels;
        const lines = [`## ${l.activeGoals}`];
        goals.sort((a, b) => (b.importance - a.importance));

        for (const g of goals) {
            const status = g.fields.status || 'in_progress';
            lines.push(`- ${g.name} [${status}]: ${g.fields.description || l.noDescription}`);
            if (g.fields.progress) lines.push(`  ${l.progress}: ${g.fields.progress}`);
            if (g.fields.blockers) lines.push(`  ${l.blockers}: ${g.fields.blockers}`);
        }

        return lines.join('\n');
    }

    _formatEvents(events) {
        const l = this.labels;
        const lines = [`## ${l.majorEvents}`];
        events.sort((a, b) => (b.fields.turn || b.createdTurn) - (a.fields.turn || a.createdTurn));

        for (const e of events) {
            const turn = e.fields.turn || e.createdTurn;
            lines.push(`- ${l.turn} ${turn}: ${e.name} — ${e.fields.description || l.noDescription}`);
            if (e.fields.consequences) lines.push(`  ${l.consequences}: ${e.fields.consequences}`);
        }

        return lines.join('\n');
    }
}
