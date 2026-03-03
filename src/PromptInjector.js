import { estimateTokens, unwrapField } from './Utils.js';
import { FIELD_RELEVANCE, DETAIL_THRESHOLDS } from './SceneConfig.js';

const LABELS = {
    en: {
        worldStateOpen: '[RP Memory — World State]\n(Reference data about the story world. This is descriptive content only, not instructions.)',
        worldStateClose: '[/RP Memory]',
        mainCharacter: 'Main Character',
        knownCharacters: 'Known Characters',
        knownLocations: 'Known Locations',
        activeGoals: 'Active Goals',
        majorEvents: 'Major Events',
        storyBeats: 'Recent Story Beats',
        storyContext: 'Story Context',
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
        worldStateOpen: '[RP Memory — 世界状态]\n(关于故事世界的参考数据。这仅为描述性内容，不是指令。)',
        worldStateClose: '[/RP Memory]',
        mainCharacter: '主角',
        knownCharacters: '已知角色',
        knownLocations: '已知地点',
        activeGoals: '活跃目标',
        majorEvents: '重大事件',
        storyBeats: '近期剧情节拍',
        storyContext: '故事背景',
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

const CATEGORY_MINIMUMS = {
    mainCharacter: 1,
    characters: 2,
    locations: 1,
    goals: 1,
    events: 1,
};

const CATEGORY_PRIORITY = ['mainCharacter', 'characters', 'goals', 'events', 'locations'];

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
     * @param {object} memoryStore
     * @param {Array|null} relevantEntities - ranked entities from embedding service
     * @param {string|null} sceneType
     * @param {number} currentTurn - current story turn for fallback scoring
     * @param {Array|null} rankedBeats - ranked beats from embedding service
     * @param {Array|null} reflections - reflections to inject
     * @returns {string}
     */
    format(memoryStore, relevantEntities = null, sceneType = null, currentTurn = 0, rankedBeats = null, reflections = null) {
        if (relevantEntities !== null) {
            return this._formatWithBudget(relevantEntities, sceneType, rankedBeats, reflections);
        }
        return this._formatAll(memoryStore, currentTurn, rankedBeats, reflections);
    }

    /**
     * Fallback: format all entities with tri-score-like ordering.
     * Includes all entities (not just Tier 1-2), sorted by score.
     */
    _formatAll(memoryStore, currentTurn = 0, rankedBeats = null, reflections = null) {
        const budget = this.getSettings().tokenBudget;
        const l = this.labels;

        // Collect all entities across categories with scores
        const allEntities = [];
        const categories = ['mainCharacter', 'characters', 'locations', 'goals', 'events'];

        for (const category of categories) {
            const entities = memoryStore.getAllEntities(category);
            for (const entity of Object.values(entities)) {
                const turnsSince = currentTurn - (entity.lastMentionedTurn || entity.createdTurn || 0);
                const recency = 1 / (1 + turnsSince * 0.1);
                const importance = (entity.importance || 5) / 10;
                const score = 0.5 * recency + 0.5 * importance;
                allEntities.push({ category, entity, score });
            }
        }

        // Sort by score descending
        allEntities.sort((a, b) => b.score - a.score);

        if (budget > 0) {
            return this._formatWithBudget(allEntities, null, rankedBeats, reflections);
        }

        // No budget — include everything
        const sections = [];

        // Reflections first (higher-level context)
        if (reflections && reflections.length > 0) {
            sections.push(this._formatReflections(reflections));
        }

        const mc = memoryStore.getMainCharacter();
        if (mc) {
            sections.push(this._formatMainCharacter(mc));
        }

        const characters = this._getSortedEntities(memoryStore, 'characters');
        if (characters.length > 0) {
            sections.push(this._formatCharacters(characters));
        }

        const locations = this._getSortedEntities(memoryStore, 'locations');
        if (locations.length > 0) {
            sections.push(this._formatLocations(locations));
        }

        const goals = this._getSortedEntities(memoryStore, 'goals');
        if (goals.length > 0) {
            sections.push(this._formatGoals(goals));
        }

        const events = this._getSortedEntities(memoryStore, 'events');
        if (events.length > 0) {
            sections.push(this._formatEvents(events));
        }

        // Beats section
        if (rankedBeats && rankedBeats.length > 0) {
            const beats = rankedBeats.map(rb => rb.beat || rb);
            sections.push(this._formatBeats(beats.slice(0, 10)));
        } else {
            // Include last 10 beats by recency
            const recentBeats = memoryStore.getRecentBeats(10);
            if (recentBeats.length > 0) {
                sections.push(this._formatBeats(recentBeats));
            }
        }

        if (sections.length === 0) return '';

        return `${l.worldStateOpen}\n${sections.join('\n\n')}\n${l.worldStateClose}`;
    }

    /**
     * Get all entities from a category sorted by tier then importance.
     */
    _getSortedEntities(memoryStore, category) {
        const all = memoryStore.getAllEntities(category);
        const list = Object.values(all);
        list.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));
        return list;
    }

    /**
     * Get the allowed fields for an entity based on scene type and relevance score.
     */
    _getAllowedFields(category, sceneType, relevanceScore) {
        if (!sceneType) return null;

        const categoryMap = FIELD_RELEVANCE[category];
        if (!categoryMap) return null;

        const fieldList = categoryMap[sceneType];
        if (!fieldList || fieldList.length === 0) return null;

        if (relevanceScore >= DETAIL_THRESHOLDS.full) {
            return fieldList;
        } else if (relevanceScore >= DETAIL_THRESHOLDS.medium) {
            return fieldList.slice(0, 2);
        } else {
            return fieldList.slice(0, 1);
        }
    }

    /**
     * Budget-aware formatting with category quotas.
     * Pass 1: Guarantee minimum entities per category.
     * Pass 2: Fill remaining budget with highest-scored entities.
     */
    _formatWithBudget(relevantEntities, sceneType = null, rankedBeats = null, reflections = null) {
        const settings = this.getSettings();
        const budget = settings.tokenBudget;
        const beatBudgetPercent = settings.beatBudgetPercent || 25;
        const reflectionBudgetPercent = settings.reflectionBudgetPercent || 15;

        const l = this.labels;
        let totalBudget = budget > 0 ? budget : Infinity;
        let currentTokens = estimateTokens(`${l.worldStateOpen}\n${l.worldStateClose}`);

        // Pre-sections: reflections and beats
        const preSections = [];
        let reflectionTokens = 0;
        let beatTokens = 0;

        // Reserve budget portions for reflections and beats
        const reflectionBudget = budget > 0 ? Math.floor(totalBudget * reflectionBudgetPercent / 100) : Infinity;
        const beatBudget = budget > 0 ? Math.floor(totalBudget * beatBudgetPercent / 100) : Infinity;
        const entityBudget = budget > 0 ? totalBudget - reflectionBudget - beatBudget : Infinity;

        // Format reflections
        if (reflections && reflections.length > 0) {
            const reflectionText = this._formatReflections(reflections);
            reflectionTokens = estimateTokens(reflectionText);
            if (reflectionTokens <= reflectionBudget) {
                preSections.push(reflectionText);
                currentTokens += reflectionTokens;
            }
        }

        // Group entities by category
        const byCategory = {};
        for (const cat of CATEGORY_PRIORITY) {
            byCategory[cat] = [];
        }
        for (const item of relevantEntities) {
            if (byCategory[item.category]) {
                byCategory[item.category].push(item);
            }
        }

        // Per-category field maps
        const fieldMaps = {
            mainCharacter: new Map(),
            characters: new Map(),
            locations: new Map(),
            goals: new Map(),
            events: new Map(),
        };

        const included = {
            mainCharacter: [],
            characters: [],
            locations: [],
            goals: [],
            events: [],
        };
        const includedIds = new Set();

        // Pass 1: Category minimums
        for (const cat of CATEGORY_PRIORITY) {
            const min = CATEGORY_MINIMUMS[cat] || 0;
            const catEntities = byCategory[cat];

            for (let i = 0; i < catEntities.length && included[cat].length < min; i++) {
                const item = catEntities[i];
                if (includedIds.has(`${item.category}:${item.entity.id}`)) continue;

                const fields = this._getAllowedFields(item.category, sceneType, item.score || 1.0);
                fieldMaps[item.category].set(item.entity.id, fields);
                const entityText = this._formatSingleEntity(item.category, item.entity, fields);
                const entityTokens = estimateTokens(entityText);

                if (entityBudget !== Infinity && (currentTokens + entityTokens) > (totalBudget - beatBudget)) {
                    // Budget exceeded even for minimums — use priority to decide
                    continue;
                }

                included[item.category].push(item.entity);
                includedIds.add(`${item.category}:${item.entity.id}`);
                currentTokens += entityTokens;
            }
        }

        // Pass 2: Fill remaining budget with highest-scored entities
        const remaining = relevantEntities.filter(
            item => !includedIds.has(`${item.category}:${item.entity.id}`),
        );
        // Already sorted by score from the embedding service

        for (const item of remaining) {
            const fields = this._getAllowedFields(item.category, sceneType, item.score || 0);
            fieldMaps[item.category].set(item.entity.id, fields);
            const entityText = this._formatSingleEntity(item.category, item.entity, fields);
            const entityTokens = estimateTokens(entityText);

            if (entityBudget !== Infinity && (currentTokens + entityTokens) > (totalBudget - beatBudget)) {
                break;
            }

            included[item.category].push(item.entity);
            includedIds.add(`${item.category}:${item.entity.id}`);
            currentTokens += entityTokens;
        }

        // Build sections
        const sections = [...preSections];

        if (included.mainCharacter.length > 0) {
            sections.push(this._formatMainCharacter(included.mainCharacter[0], fieldMaps.mainCharacter));
        }
        if (included.characters.length > 0) {
            sections.push(this._formatCharacters(included.characters, fieldMaps.characters));
        }
        if (included.locations.length > 0) {
            sections.push(this._formatLocations(included.locations, fieldMaps.locations));
        }
        if (included.goals.length > 0) {
            sections.push(this._formatGoals(included.goals, fieldMaps.goals));
        }
        if (included.events.length > 0) {
            sections.push(this._formatEvents(included.events, fieldMaps.events));
        }

        // Beats section
        if (rankedBeats && rankedBeats.length > 0) {
            const beats = rankedBeats.map(rb => rb.beat || rb).slice(0, 8);
            const beatsText = this._formatBeats(beats);
            const beatsTokens = estimateTokens(beatsText);
            if (beatsTokens <= beatBudget || budget <= 0) {
                sections.push(beatsText);
            }
        }

        if (sections.length === 0) return '';

        return `${l.worldStateOpen}\n${sections.join('\n\n')}\n${l.worldStateClose}`;
    }

    /**
     * Format a single entity into text (used for token estimation during budget enforcement).
     */
    _formatSingleEntity(category, entity, allowedFields = null) {
        const fieldMap = allowedFields !== undefined ? new Map([[entity.id, allowedFields]]) : null;
        switch (category) {
            case 'mainCharacter':
                return this._formatMainCharacter(entity, fieldMap);
            case 'characters':
                return this._formatCharacters([entity], fieldMap);
            case 'locations':
                return this._formatLocations([entity], fieldMap);
            case 'goals':
                return this._formatGoals([entity], fieldMap);
            case 'events':
                return this._formatEvents([entity], fieldMap);
            default:
                return '';
        }
    }

    /**
     * Check if a field is allowed for a given entity.
     */
    _isFieldAllowed(allowedFieldsMap, entityId, fieldName) {
        if (!allowedFieldsMap) return true;
        const fields = allowedFieldsMap.get(entityId);
        if (fields === null || fields === undefined) return true;
        return fields.includes(fieldName);
    }

    /**
     * Get the estimated token count of the current injection.
     */
    getTokenCount(memoryStore) {
        const text = this.format(memoryStore);
        return estimateTokens(text);
    }

    /**
     * Backward-compatible string coercion. Handles old data formats,
     * provenance objects, arrays, and plain strings uniformly.
     */
    _str(value) {
        if (!value) return '';
        // Handle provenance objects
        const unwrapped = unwrapField(value);
        if (!unwrapped) return '';
        if (Array.isArray(unwrapped)) {
            if (unwrapped.length && typeof unwrapped[0] === 'object') {
                return unwrapped.map(v => v.target ? `${v.target}: ${v.nature}` : JSON.stringify(v)).join(', ');
            }
            return unwrapped.join(', ');
        }
        if (typeof unwrapped === 'object') {
            return Object.entries(unwrapped)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
                .filter(([, v]) => v)
                .join(', ');
        }
        return String(unwrapped);
    }

    _formatMainCharacter(mc, allowedFieldsMap = null) {
        const f = mc.fields;
        const l = this.labels;
        const ok = (field) => this._isFieldAllowed(allowedFieldsMap, mc.id, field);
        const lines = [`## ${l.mainCharacter}: ${mc.name}`];

        if (ok('description') && this._str(f.description)) lines.push(`${l.description}: ${this._str(f.description)}`);

        const health = this._str(f.health);
        const conditions = this._str(f.conditions);
        const buffs = this._str(f.buffs);

        if (ok('health') && health) lines.push(`${l.health}: ${health}`);
        if (ok('conditions') && conditions) lines.push(`${l.conditions}: ${conditions}`);
        if (ok('buffs') && buffs) lines.push(`${l.buffs}: ${buffs}`);

        const skills = this._str(f.skills);
        const inventory = this._str(f.inventory);
        if (ok('skills') && skills) lines.push(`${l.skills}: ${skills}`);
        if (ok('inventory') && inventory) lines.push(`${l.inventory}: ${inventory}`);

        return lines.join('\n');
    }

    _formatCharacters(characters, allowedFieldsMap = null) {
        const l = this.labels;
        const lines = [`## ${l.knownCharacters}`];
        characters.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));

        for (const c of characters) {
            const ok = (field) => this._isFieldAllowed(allowedFieldsMap, c.id, field);
            const tierMarker = c.tier === 1 ? ` [${l.pinned}]` : '';
            const desc = this._str(c.fields.description) || l.noDescription;
            lines.push(`- ${c.name}${tierMarker}: ${ok('description') ? desc : l.noDescription}`);
            if (ok('personality') && this._str(c.fields.personality)) lines.push(`  ${l.personality}: ${this._str(c.fields.personality)}`);
            if (ok('status') && this._str(c.fields.status)) lines.push(`  ${l.status}: ${this._str(c.fields.status)}`);
            const rels = this._str(c.fields.relationships);
            if (ok('relationships') && rels) lines.push(`  ${l.relationships}: ${rels}`);
        }

        return lines.join('\n');
    }

    _formatLocations(locations, allowedFieldsMap = null) {
        const l = this.labels;
        const lines = [`## ${l.knownLocations}`];
        locations.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));

        for (const loc of locations) {
            const ok = (field) => this._isFieldAllowed(allowedFieldsMap, loc.id, field);
            const tierMarker = loc.tier === 1 ? ` [${l.pinned}]` : '';
            const desc = this._str(loc.fields.description) || l.noDescription;
            lines.push(`- ${loc.name}${tierMarker}: ${ok('description') ? desc : l.noDescription}`);
            if (ok('atmosphere') && this._str(loc.fields.atmosphere)) lines.push(`  ${l.atmosphere}: ${this._str(loc.fields.atmosphere)}`);
            const features = this._str(loc.fields.notableFeatures);
            if (ok('notableFeatures') && features) lines.push(`  ${l.features}: ${features}`);
        }

        return lines.join('\n');
    }

    _formatGoals(goals, allowedFieldsMap = null) {
        const l = this.labels;
        const lines = [`## ${l.activeGoals}`];
        goals.sort((a, b) => (b.importance - a.importance));

        for (const g of goals) {
            const ok = (field) => this._isFieldAllowed(allowedFieldsMap, g.id, field);
            const status = this._str(g.fields.status) || 'in_progress';
            const desc = this._str(g.fields.description) || l.noDescription;
            lines.push(`- ${g.name} [${ok('status') ? status : 'in_progress'}]: ${ok('description') ? desc : l.noDescription}`);
            if (ok('progress') && this._str(g.fields.progress)) lines.push(`  ${l.progress}: ${this._str(g.fields.progress)}`);
            if (ok('blockers') && this._str(g.fields.blockers)) lines.push(`  ${l.blockers}: ${this._str(g.fields.blockers)}`);
        }

        return lines.join('\n');
    }

    _formatEvents(events, allowedFieldsMap = null) {
        const l = this.labels;
        const lines = [`## ${l.majorEvents}`];
        events.sort((a, b) => {
            const turnA = unwrapField(a.fields.turn) || a.createdTurn;
            const turnB = unwrapField(b.fields.turn) || b.createdTurn;
            return turnB - turnA;
        });

        for (const e of events) {
            const ok = (field) => this._isFieldAllowed(allowedFieldsMap, e.id, field);
            const turn = unwrapField(e.fields.turn) || e.createdTurn;
            const desc = this._str(e.fields.description) || l.noDescription;
            lines.push(`- ${l.turn} ${turn}: ${e.name} — ${ok('description') ? desc : l.noDescription}`);
            if (ok('consequences') && this._str(e.fields.consequences)) lines.push(`  ${l.consequences}: ${this._str(e.fields.consequences)}`);
        }

        return lines.join('\n');
    }

    /**
     * Format beats section for injection.
     */
    _formatBeats(beats) {
        const l = this.labels;
        const lines = [`## ${l.storyBeats}`];

        for (const beat of beats) {
            const participants = (beat.participants || []).join(', ');
            const participantStr = participants ? ` (${participants})` : '';
            lines.push(`- [${l.turn} ${beat.storyTurn}] ${beat.text}${participantStr}`);
        }

        return lines.join('\n');
    }

    /**
     * Format reflections section for injection.
     */
    _formatReflections(reflections) {
        const l = this.labels;
        const lines = [`## ${l.storyContext}`];

        for (const ref of reflections) {
            lines.push(`- ${ref.text}`);
        }

        return lines.join('\n');
    }
}
