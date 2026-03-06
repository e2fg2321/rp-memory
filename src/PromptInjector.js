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
        mood: 'Mood',
        status: 'Status',
        relationships: 'Relationships',
        atmosphere: 'Atmosphere',
        features: 'Features',
        progress: 'Progress',
        blockers: 'Blockers',
        timeframe: 'Timeframe',
        turn: 'Turn',
        consequences: 'Consequences',
        currentLocation: 'Location',
        currentTime: 'Time',
        connections: 'Connections',
        backstory: 'Backstory',
        speechPatterns: 'Speech Patterns',
        history: 'History',
        goals: 'Goals',
        keyEvents: 'Key Events',
        narrativeDirection: 'Narrative Direction',
        narrativeNote: '(Guidance based on current story trajectory — not prescriptive.)',
        pacing: 'Pacing',
        tension: 'Tension',
        focus: 'Focus',
        tone: 'Tone',
        toneAvoid: 'Avoid',
        nextBeat: 'Possible Next Beat',
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
        mood: '情绪',
        status: '状态',
        relationships: '关系',
        atmosphere: '氛围',
        features: '特征',
        progress: '进度',
        blockers: '阻碍',
        timeframe: '时间范围',
        turn: '回合',
        consequences: '后果',
        currentLocation: '当前位置',
        currentTime: '当前时间',
        connections: '连接',
        backstory: '背景故事',
        speechPatterns: '说话方式',
        history: '历史',
        goals: '目标',
        keyEvents: '关键事件',
        narrativeDirection: '叙事方向',
        narrativeNote: '(基于当前故事轨迹的指导——非强制性。)',
        pacing: '节奏',
        tension: '张力',
        focus: '焦点',
        tone: '基调',
        toneAvoid: '避免',
        nextBeat: '可能的下一节拍',
    },
};

const FOCUS_LABELS = {
    en: {
        character_development: 'Character Development',
        plot_advancement: 'Plot Advancement',
        world_building: 'World-Building',
        relationship_dynamics: 'Relationship Dynamics',
        action_conflict: 'Action/Conflict',
        mystery_revelation: 'Mystery/Revelation',
    },
    zh: {
        character_development: '角色发展',
        plot_advancement: '剧情推进',
        world_building: '世界构建',
        relationship_dynamics: '关系动态',
        action_conflict: '动作/冲突',
        mystery_revelation: '谜团/揭示',
    },
};

const PACING_LABELS = {
    en: {
        accelerate: 'Accelerate',
        maintain: 'Maintain',
        slow_down: 'Slow Down',
        pivot: 'Pivot',
    },
    zh: {
        accelerate: '加速',
        maintain: '保持',
        slow_down: '放缓',
        pivot: '转折',
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
     * @param {Array|null} rankedGoals - pre-ranked goals from GoalsManager
     * @param {Map|null} goalBeats - goal-adjacent beats from GoalsManager (goalId → beat[])
     * @returns {string}
     */
    format(memoryStore, relevantEntities = null, sceneType = null, currentTurn = 0, rankedBeats = null, reflections = null, rankedGoals = null, goalBeats = null, narrativeDirection = null) {
        if (relevantEntities !== null) {
            return this._formatWithBudget(relevantEntities, sceneType, rankedBeats, reflections, memoryStore, rankedGoals, goalBeats, narrativeDirection);
        }
        return this._formatAll(memoryStore, currentTurn, rankedBeats, reflections, rankedGoals, goalBeats, narrativeDirection);
    }

    /**
     * Fallback: format all entities with tri-score-like ordering.
     * Includes all entities (not just Tier 1-2), sorted by score.
     */
    _formatAll(memoryStore, currentTurn = 0, rankedBeats = null, reflections = null, rankedGoals = null, goalBeats = null, narrativeDirection = null) {
        const budget = this.getSettings().tokenBudget;
        const l = this.labels;

        // Collect all entities across categories with scores
        const allEntities = [];
        const categories = ['mainCharacter', 'characters', 'locations', 'goals', 'events'];

        for (const category of categories) {
            const entities = memoryStore.getAllEntities(category);
            for (const entity of Object.values(entities)) {
                // Skip tier-3 (archived) entities — they stay in UI but are noise in the prompt
                if (entity.tier === 3 && category !== 'mainCharacter') continue;
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
            return this._formatWithBudget(allEntities, null, rankedBeats, reflections, null, rankedGoals, goalBeats, narrativeDirection);
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
            sections.push(this._formatCharacters(characters, null, memoryStore));
        }

        const locations = this._getSortedEntities(memoryStore, 'locations');
        if (locations.length > 0) {
            sections.push(this._formatLocations(locations));
        }

        if (rankedGoals && rankedGoals.length > 0) {
            const goalEntities = rankedGoals.map(g => g.entity);
            sections.push(this._formatGoals(goalEntities, null, goalBeats));
        } else {
            const goals = this._getSortedEntities(memoryStore, 'goals');
            if (goals.length > 0) {
                sections.push(this._formatGoals(goals));
            }
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

        // Narrative direction (budget-exempt, appended after all factual sections)
        const narrativeText = this._formatNarrativeDirection(narrativeDirection);
        if (narrativeText) {
            sections.push(narrativeText);
        }

        if (sections.length === 0) return '';

        return `${l.worldStateOpen}\n${sections.join('\n\n')}\n${l.worldStateClose}`;
    }

    /**
     * Get all entities from a category sorted by tier then importance.
     */
    _getSortedEntities(memoryStore, category) {
        const all = memoryStore.getAllEntities(category);
        const list = Object.values(all).filter(e => e.tier !== 3);
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
    _formatWithBudget(relevantEntities, sceneType = null, rankedBeats = null, reflections = null, memoryStore = null, rankedGoals = null, goalBeats = null, narrativeDirection = null) {
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

        // Reserve budget portions for reflections and beats (cap combined at 60% so entities get at least 40%)
        const combinedPercent = Math.min(reflectionBudgetPercent + beatBudgetPercent, 60);
        const adjustedReflectionPercent = combinedPercent > 60 ? Math.floor(reflectionBudgetPercent * 60 / combinedPercent) : reflectionBudgetPercent;
        const adjustedBeatPercent = combinedPercent > 60 ? 60 - adjustedReflectionPercent : beatBudgetPercent;
        const reflectionBudget = budget > 0 ? Math.floor(totalBudget * adjustedReflectionPercent / 100) : Infinity;
        const beatBudget = budget > 0 ? Math.floor(totalBudget * adjustedBeatPercent / 100) : Infinity;
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
            sections.push(this._formatCharacters(included.characters, fieldMaps.characters, memoryStore));
        }
        if (included.locations.length > 0) {
            sections.push(this._formatLocations(included.locations, fieldMaps.locations));
        }
        if (rankedGoals && rankedGoals.length > 0) {
            const goalEntities = rankedGoals.map(g => g.entity);
            sections.push(this._formatGoals(goalEntities, null, goalBeats));
        } else if (included.goals.length > 0) {
            sections.push(this._formatGoals(included.goals, fieldMaps.goals));
        }
        if (included.events.length > 0) {
            sections.push(this._formatEvents(included.events, fieldMaps.events));
        }

        // Beats section (with context expansion)
        if (rankedBeats && rankedBeats.length > 0) {
            const expandedBeats = this._expandBeatContext(rankedBeats, memoryStore, beatBudget, budget <= 0);
            if (expandedBeats.length > 0) {
                const beatsText = this._formatExpandedBeats(expandedBeats);
                const beatsTokens = estimateTokens(beatsText);
                if (beatsTokens <= beatBudget || budget <= 0) {
                    sections.push(beatsText);
                }
            }
        }

        // Narrative direction (budget-exempt, appended after all factual sections)
        const narrativeText = this._formatNarrativeDirection(narrativeDirection);
        if (narrativeText) {
            sections.push(narrativeText);
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
     * Get the estimated total token count of ALL stored memory
     * (all tiers, all fields, all beats, all reflections — no filtering).
     */
    getTotalStoredTokens(memoryStore) {
        const l = this.labels;
        const sections = [];

        const mc = memoryStore.getMainCharacter();
        if (mc) sections.push(this._formatMainCharacter(mc));

        const categories = ['characters', 'locations', 'goals', 'events'];
        const formatters = {
            characters: (list) => this._formatCharacters(list, null, memoryStore),
            locations: (list) => this._formatLocations(list),
            goals: (list) => this._formatGoals(list),
            events: (list) => this._formatEvents(list),
        };

        for (const cat of categories) {
            const all = memoryStore.getAllEntities(cat);
            const list = Object.values(all);
            if (list.length > 0) sections.push(formatters[cat](list));
        }

        const beats = memoryStore.getBeats();
        if (beats.length > 0) sections.push(this._formatBeats(beats));

        const reflections = memoryStore.getReflections();
        if (reflections.length > 0) sections.push(this._formatReflections(reflections));

        if (sections.length === 0) return 0;
        const text = `${l.worldStateOpen}\n${sections.join('\n\n')}\n${l.worldStateClose}`;
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

        const currentLocation = this._str(f.currentLocation);
        const currentTime = this._str(f.currentTime);
        if (ok('currentLocation') && currentLocation) lines.push(`${l.currentLocation}: ${currentLocation}`);
        if (ok('currentTime') && currentTime) lines.push(`${l.currentTime}: ${currentTime}`);

        return lines.join('\n');
    }

    _formatCharacters(characters, allowedFieldsMap = null, memoryStore = null) {
        const l = this.labels;
        const lines = [`## ${l.knownCharacters}`];
        characters.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));

        for (const c of characters) {
            const ok = (field) => this._isFieldAllowed(allowedFieldsMap, c.id, field);
            const tierMarker = c.tier === 1 ? ` [${l.pinned}]` : '';
            const desc = this._str(c.fields.description) || l.noDescription;
            lines.push(`- ${c.name}${tierMarker}: ${ok('description') ? desc : l.noDescription}`);
            if (ok('personality') && this._str(c.fields.personality)) lines.push(`  ${l.personality}: ${this._str(c.fields.personality)}`);
            if (ok('mood') && this._str(c.fields.mood)) lines.push(`  ${l.mood}: ${this._str(c.fields.mood)}`);
            if (ok('status') && this._str(c.fields.status)) lines.push(`  ${l.status}: ${this._str(c.fields.status)}`);
            const rels = this._str(c.fields.relationships);
            if (ok('relationships') && rels) lines.push(`  ${l.relationships}: ${rels}`);

            // Expanded profile — only for high-importance characters (>= 7)
            if (c.importance >= 7) {
                if (ok('backstory') && this._str(c.fields.backstory))
                    lines.push(`  ${l.backstory}: ${this._str(c.fields.backstory)}`);
                if (ok('speechPatterns') && this._str(c.fields.speechPatterns))
                    lines.push(`  ${l.speechPatterns}: ${this._str(c.fields.speechPatterns)}`);
                if (ok('history') && this._str(c.fields.history))
                    lines.push(`  ${l.history}: ${this._str(c.fields.history)}`);
                if (ok('goals') && this._str(c.fields.goals))
                    lines.push(`  ${l.goals}: ${this._str(c.fields.goals)}`);

                // Derived key events from the events system
                const keyEvents = this._getCharacterKeyEvents(c, memoryStore);
                if (keyEvents.length > 0) {
                    lines.push(`  ${l.keyEvents}:`);
                    for (const evt of keyEvents) {
                        lines.push(`    - ${l.turn} ${evt.turn}: ${evt.name} — ${evt.description}`);
                    }
                }
            }
        }

        return lines.join('\n');
    }

    /**
     * Derive key events for a character from the events system.
     * Looks up events where involvedEntities contains the character's name or aliases.
     * Returns top 5 events by importance.
     */
    _getCharacterKeyEvents(character, memoryStore) {
        if (!memoryStore) return [];

        const allEvents = memoryStore.getAllEntities('events');
        if (!allEvents || Object.keys(allEvents).length === 0) return [];

        const nameVariants = [character.name.toLowerCase()];
        if (character.aliases) {
            for (const alias of character.aliases) {
                nameVariants.push(alias.toLowerCase());
            }
        }

        const matched = [];
        for (const event of Object.values(allEvents)) {
            const involved = this._str(event.fields.involvedEntities).toLowerCase();
            if (!involved) continue;

            const isInvolved = nameVariants.some(name => involved.includes(name));
            if (isInvolved) {
                matched.push({
                    turn: unwrapField(event.fields.turn) || event.createdTurn || 0,
                    name: event.name,
                    description: this._str(event.fields.description),
                    importance: event.importance || 5,
                });
            }
        }

        // Sort by importance descending, limit to top 5
        matched.sort((a, b) => b.importance - a.importance);
        return matched.slice(0, 5);
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
            const connections = this._str(loc.fields.connections);
            if (ok('connections') && connections) lines.push(`  ${l.connections}: ${connections}`);
        }

        return lines.join('\n');
    }

    _formatGoals(goals, allowedFieldsMap = null, goalBeats = null) {
        const l = this.labels;
        const lines = [`## ${l.activeGoals}`];
        // Only sort by importance if no pre-ranked order was provided
        if (!goalBeats) {
            goals.sort((a, b) => (b.importance - a.importance));
        }

        for (const g of goals) {
            const ok = (field) => this._isFieldAllowed(allowedFieldsMap, g.id, field);
            const status = this._str(g.fields.status) || 'in_progress';
            const desc = this._str(g.fields.description) || l.noDescription;
            const tf = ok('timeframe') && this._str(g.fields.timeframe) ? ` | ${this._str(g.fields.timeframe)}` : '';
            lines.push(`- ${g.name} [${ok('status') ? status : 'in_progress'}${tf}]: ${ok('description') ? desc : l.noDescription}`);
            if (ok('progress') && this._str(g.fields.progress)) lines.push(`  ${l.progress}: ${this._str(g.fields.progress)}`);
            if (ok('blockers') && this._str(g.fields.blockers)) lines.push(`  ${l.blockers}: ${this._str(g.fields.blockers)}`);

            // Render goal-adjacent beats inline
            if (goalBeats) {
                const beats = goalBeats.get?.(g.id);
                if (beats && beats.length > 0) {
                    for (const beat of beats) {
                        lines.push(`  Context: [${l.turn} ${beat.storyTurn}] ${beat.text}`);
                    }
                }
            }
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
     * Format narrative direction section for injection.
     * Budget-exempt (~80-120 tokens). Returns empty string if no data.
     */
    _formatNarrativeDirection(narrativeDirection) {
        if (!narrativeDirection) return '';

        const l = this.labels;
        const lang = this.getLang();
        const focusLabels = FOCUS_LABELS[lang] || FOCUS_LABELS.en;
        const pacingLabels = PACING_LABELS[lang] || PACING_LABELS.en;

        const lines = [`## ${l.narrativeDirection}`, l.narrativeNote];

        // Pacing + directive
        const pacingLabel = pacingLabels[narrativeDirection.pacing] || narrativeDirection.pacing;
        lines.push(`${l.pacing}: ${pacingLabel}`);
        if (narrativeDirection.pacingDirective) {
            lines.push(`> ${narrativeDirection.pacingDirective}`);
        }

        // Tension level
        if (typeof narrativeDirection.tension === 'number') {
            const tensionPct = Math.round(narrativeDirection.tension * 100);
            lines.push(`${l.tension}: ${tensionPct}%`);
        }

        // Focus elements
        if (narrativeDirection.focus && narrativeDirection.focus.length > 0) {
            const focusNames = narrativeDirection.focus
                .map(f => focusLabels[f] || f)
                .join(', ');
            lines.push(`${l.focus}: ${focusNames}`);
        }

        // Tone
        if (narrativeDirection.tone) {
            lines.push(`${l.tone}: ${narrativeDirection.tone}`);
        }

        // Tone avoid
        if (narrativeDirection.toneAvoid) {
            lines.push(`${l.toneAvoid}: ${narrativeDirection.toneAvoid}`);
        }

        // Next beat hint (optional)
        if (narrativeDirection.nextBeatHint) {
            lines.push(`${l.nextBeat}: ${narrativeDirection.nextBeatHint}`);
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
     * Groups by branch (plot vs portrayal) with sub-headings by horizon.
     */
    _formatReflections(reflections) {
        const l = this.labels;
        const lang = this.getLang();

        // Group by branch
        const plotRefs = reflections.filter(r => r.branch !== 'portrayal');
        const portrayalRefs = reflections.filter(r => r.branch === 'portrayal');

        const lines = [`## ${l.storyContext}`];

        if (plotRefs.length > 0) {
            const plotLabel = lang === 'zh' ? '剧情线索' : 'Plot Threads';
            lines.push(`### ${plotLabel}`);
            // Sort: short horizon first, then mid, then long
            const horizonOrder = { short: 0, mid: 1, long: 2 };
            plotRefs.sort((a, b) => (horizonOrder[a.horizon] || 0) - (horizonOrder[b.horizon] || 0));
            for (const ref of plotRefs) {
                const tag = ref.horizon === 'mid' ? (lang === 'zh' ? '[持续]' : '[Ongoing]')
                    : ref.horizon === 'long' ? (lang === 'zh' ? '[长期]' : '[Long-term]')
                        : (lang === 'zh' ? '[近期]' : '[Recent]');
                lines.push(`- ${tag} ${ref.text}`);
            }
        }

        if (portrayalRefs.length > 0) {
            const portLabel = lang === 'zh' ? '角色刻画' : 'Character Portrayal';
            lines.push(`### ${portLabel}`);
            for (const ref of portrayalRefs) {
                lines.push(`- ${ref.text}`);
            }
        }

        // Fallback: if no branch info, just list all
        if (plotRefs.length === 0 && portrayalRefs.length === 0) {
            for (const ref of reflections) {
                lines.push(`- ${ref.text}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Expand ranked beat anchors with surrounding context beats.
     * Picks top anchors, then greedily adds ±beatContextRadius neighbors
     * by storyTurn until the token budget is filled.
     *
     * @param {Array<{beat, score}>} rankedBeats - scored beats from embedding service
     * @param {object|null} memoryStore - memory store for full beat list
     * @param {number} beatBudget - token budget for beats section
     * @param {boolean} unlimited - true when no budget limit applies
     * @returns {Array<{beat, isAnchor: boolean}>}
     */
    _expandBeatContext(rankedBeats, memoryStore, beatBudget, unlimited) {
        const settings = this.getSettings();
        const radius = settings.beatContextRadius ?? 2;

        // Extract anchor beats (top 6 to leave room for context)
        const anchors = rankedBeats.slice(0, 6).map(rb => rb.beat || rb);
        const selectedIds = new Set(anchors.map(b => b.id));
        const selected = anchors.map(b => ({ beat: b, isAnchor: true }));

        // Graceful degradation: no memoryStore or no radius → anchors only
        if (!memoryStore || radius <= 0) {
            return selected;
        }

        // Build storyTurn → beats[] index from all beats
        const allBeats = memoryStore.getBeats();
        const turnIndex = new Map();
        for (const beat of allBeats) {
            const turn = beat.storyTurn;
            if (!turnIndex.has(turn)) {
                turnIndex.set(turn, []);
            }
            turnIndex.get(turn).push(beat);
        }

        // Track token usage for budget enforcement
        let usedTokens = this._estimateBeatsTokens(selected);

        // Expand each anchor in score order (highest-scored anchor first)
        for (const anchor of anchors) {
            const anchorTurn = anchor.storyTurn;

            // Expand inner distances first (dist=1 before dist=2)
            for (let dist = 1; dist <= radius; dist++) {
                const neighborTurns = [anchorTurn - dist, anchorTurn + dist];

                for (const turn of neighborTurns) {
                    const beatsAtTurn = turnIndex.get(turn);
                    if (!beatsAtTurn) continue;

                    for (const beat of beatsAtTurn) {
                        if (selectedIds.has(beat.id)) continue;

                        // Check budget before adding
                        const candidateTokens = this._estimateBeatsTokens([{ beat, isAnchor: false }]);
                        if (!unlimited && (usedTokens + candidateTokens) > beatBudget) {
                            continue; // A shorter neighbor at same distance may still fit
                        }

                        selected.push({ beat, isAnchor: false });
                        selectedIds.add(beat.id);
                        usedTokens += candidateTokens;
                    }
                }
            }
        }

        // Sort final selection chronologically by storyTurn
        selected.sort((a, b) => a.beat.storyTurn - b.beat.storyTurn);

        return selected;
    }

    /**
     * Format expanded beats with anchor/context distinction and cluster gaps.
     * Anchors:  `- [Turn X] text (participants)`
     * Context:  `  ~ [Turn X] text (participants)`
     * Blank line between clusters when turn gap > 3.
     *
     * @param {Array<{beat, isAnchor: boolean}>} expandedBeats
     * @returns {string}
     */
    _formatExpandedBeats(expandedBeats) {
        const l = this.labels;
        const lines = [`## ${l.storyBeats}`];
        let prevTurn = null;

        for (const { beat, isAnchor } of expandedBeats) {
            // Insert blank line for cluster gap
            if (prevTurn !== null && (beat.storyTurn - prevTurn) > 3) {
                lines.push('');
            }

            const participants = (beat.participants || []).join(', ');
            const participantStr = participants ? ` (${participants})` : '';
            const prefix = isAnchor ? '-' : '  ~';
            lines.push(`${prefix} [${l.turn} ${beat.storyTurn}] ${beat.text}${participantStr}`);
            prevTurn = beat.storyTurn;
        }

        return lines.join('\n');
    }

    /**
     * Estimate token count for a set of beat entries.
     * Used during expansion to enforce budget constraints.
     *
     * @param {Array<{beat, isAnchor: boolean}>} entries
     * @returns {number}
     */
    _estimateBeatsTokens(entries) {
        const l = this.labels;
        let text = '';
        for (const { beat, isAnchor } of entries) {
            const participants = (beat.participants || []).join(', ');
            const participantStr = participants ? ` (${participants})` : '';
            const prefix = isAnchor ? '-' : '  ~';
            text += `${prefix} [${l.turn} ${beat.storyTurn}] ${beat.text}${participantStr}\n`;
        }
        return estimateTokens(text);
    }
}
