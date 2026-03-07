import { unwrapField } from './Utils.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'abandoned']);

const VALID_PACING = ['accelerate', 'maintain', 'slow_down', 'pivot'];
const VALID_TIMEFRAMES = new Set(['immediate', 'short_term', 'long_term']);

/**
 * Decay speed multiplier per timeframe.
 * Applied to turnsSince so higher = decays faster.
 *   immediate:  1.5× speed  → baseScore 7 hits threshold ~5 turns
 *   short_term: 1.0× speed  → baseScore 7 hits threshold ~7 turns (default)
 *   long_term:  0.4× speed  → baseScore 7 hits threshold ~17 turns
 */
const TIMEFRAME_DECAY_SCALE = {
    immediate: 1.5,
    short_term: 1.0,
    long_term: 0.4,
};

/**
 * Retirement patience multiplier per timeframe.
 * Multiplied against retireAfterTurns.
 */
const TIMEFRAME_RETIRE_SCALE = {
    immediate: 0.5,    // 25 turns
    short_term: 1.0,   // 50 turns (default)
    long_term: 2.5,    // 125 turns
};
const VALID_FOCUS = [
    'character_development', 'plot_advancement', 'world_building',
    'relationship_dynamics', 'action_conflict', 'mystery_revelation',
];

export class GoalsManager {
    /**
     * @param {object} memoryStore
     * @param {object|null} embeddingService - optional, for semantic dedup
     * @param {object} apiClient - OpenRouterClient for LLM calls
     * @param {Function} getSettings
     * @param {Function} getLang
     */
    constructor(memoryStore, embeddingService, apiClient, getSettings, getLang) {
        this.memoryStore = memoryStore;
        this.embeddingService = embeddingService;
        this.apiClient = apiClient;
        this.getSettings = getSettings;
        this.getLang = getLang || (() => 'en');
        this._lastAnalysis = null; // { turn, rankings: Map, narrativeDirection: object|null, directionSuggestions: Array }
    }

    /**
     * Clear cached analysis results (e.g. when they become stale).
     */
    clearAnalysis() {
        this._lastAnalysis = null;
    }

    // ===================== Lifecycle: Decay =====================

    /**
     * Apply decay to all Tier 2 goals.
     * Same math as DecayEngine but scoped to goals only.
     */
    applyDecay(currentTurn) {
        const settings = this.getSettings();
        const { decayFactor, demotionThreshold } = settings;
        const entities = this.memoryStore.getAllEntities('goals');

        for (const entity of Object.values(entities)) {
            if (entity.tier === 1) continue;
            if (entity.tier === 3) continue;
            if (!entity.baseScore) continue;

            const turnsSince = currentTurn - (entity.lastMentionedTurn || 0);
            if (turnsSince <= 0) continue;

            const tf = unwrapField(entity.fields?.timeframe) || 'short_term';
            const scale = TIMEFRAME_DECAY_SCALE[tf] ?? 1.0;
            const effectiveScore = entity.baseScore * Math.pow(decayFactor, turnsSince * scale);
            const rounded = Math.round(effectiveScore * 10) / 10;

            this.memoryStore.updateEntity('goals', entity.id, {
                importance: rounded,
            });

            if (effectiveScore < demotionThreshold) {
                this.memoryStore.updateEntity('goals', entity.id, {
                    tier: 3,
                });

                if (settings.debugMode) {
                    console.debug(`[RP Memory] GoalsManager: Demoted "${entity.name}" to Tier 3 (score: ${effectiveScore.toFixed(2)}, threshold: ${demotionThreshold})`);
                }
            }
        }
    }

    // ===================== Lifecycle: Reinforce =====================

    /**
     * Reinforce a goal when re-mentioned.
     * Resets decay counter and optionally updates importance.
     */
    reinforce(entityId, currentTurn, newImportance = null) {
        const entity = this.memoryStore.getEntity('goals', entityId);
        if (!entity) return;

        const updates = {
            lastMentionedTurn: currentTurn,
        };

        if (newImportance !== null) {
            updates.baseScore = newImportance;
            updates.importance = newImportance;
        } else {
            updates.importance = entity.baseScore;
        }

        const threshold = this.getSettings().demotionThreshold;
        if (entity.tier === 3 && (newImportance || entity.baseScore) >= threshold) {
            updates.tier = 2;

            if (this.getSettings().debugMode) {
                console.debug(`[RP Memory] GoalsManager: Promoted "${entity.name}" back to Tier 2`);
            }
        }

        this.memoryStore.updateEntity('goals', entityId, updates);
    }

    // ===================== Lifecycle: Prune =====================

    /**
     * Prune completed/failed/abandoned goals and retire stale ones.
     * Consolidates MemoryStore.pruneGoals logic.
     */
    prune(currentTurn, keepRecent = 5, retireAfterTurns = 50) {
        const goals = this.memoryStore.getAllEntities('goals');
        const entries = Object.entries(goals);
        if (entries.length <= keepRecent) return;

        entries.sort((a, b) => (b[1].createdTurn || 0) - (a[1].createdTurn || 0));
        const recentIds = new Set(entries.slice(0, keepRecent).map(([id]) => id));

        for (const [id, entity] of entries) {
            if (recentIds.has(id)) continue;

            const status = entity.fields?.status;
            const statusVal = typeof status === 'object' && status !== null && 'value' in status
                ? status.value : status;
            if (TERMINAL_STATUSES.has(statusVal) && entity.tier !== 1 && (entity.importance || 0) < 8) {
                this.memoryStore.deleteEntity('goals', id);
                continue;
            }

            if (retireAfterTurns > 0 && currentTurn > 0 && entity.tier !== 3) {
                const lastMention = entity.lastMentionedTurn || entity.createdTurn || 0;
                const turnsSince = currentTurn - lastMention;
                const tf = unwrapField(entity.fields?.timeframe) || 'short_term';
                const retireScale = TIMEFRAME_RETIRE_SCALE[tf] ?? 1.0;
                if (turnsSince >= retireAfterTurns * retireScale) {
                    this.memoryStore.updateEntity('goals', id, { tier: 3 });
                }
            }
        }
    }

    // ===================== Lifecycle: Dedup =====================

    /**
     * Check if a goal entity is a semantic duplicate of an existing goal.
     * Called during extraction merge.
     *
     * @param {object} goalEntity - The candidate goal from extraction
     * @returns {Promise<string|null>} existing goal ID if duplicate found, null otherwise
     */
    async dedup(goalEntity) {
        const goals = this.memoryStore.getAllEntities('goals');
        const existingGoals = Object.values(goals);
        if (existingGoals.length === 0) return null;

        const candidateName = (goalEntity.name || '').toLowerCase().trim();
        const candidateId = goalEntity.id;

        // Pass 1: ID + alias check (fast, no embeddings needed)
        for (const existing of existingGoals) {
            if (existing.id === candidateId) return existing.id;
            if (existing.name.toLowerCase().trim() === candidateName) return existing.id;
            if (existing.aliases?.some(a => a.toLowerCase().trim() === candidateName)) return existing.id;
        }

        // Pass 2: Semantic similarity via embeddings (if available)
        if (!this.embeddingService || !this.getSettings().embeddingsEnabled) return null;

        try {
            const candidateDesc = unwrapField(goalEntity.fields?.description) || goalEntity.name || '';
            const candidateText = `${goalEntity.name}: ${candidateDesc}`;
            const [candidateEmb] = await this.embeddingService.embedTexts([candidateText]);
            if (!candidateEmb) return null;

            for (const existing of existingGoals) {
                const existingDesc = unwrapField(existing.fields?.description) || existing.name || '';
                const existingText = `${existing.name}: ${existingDesc}`;
                const [existingEmb] = await this.embeddingService.embedTexts([existingText]);
                if (!existingEmb) continue;

                const similarity = this.embeddingService.cosineSimilarity(candidateEmb, existingEmb);
                if (similarity >= 0.85) {
                    if (this.getSettings().debugMode) {
                        console.debug(`[RP Memory] GoalsManager: Semantic dedup — "${goalEntity.name}" matches "${existing.name}" (cosine: ${similarity.toFixed(3)})`);
                    }
                    return existing.id;
                }
            }
        } catch (err) {
            console.warn('[RP Memory] GoalsManager: Semantic dedup failed:', err.message);
        }

        return null;
    }

    // ===================== LLM Intent Analysis =====================

    /**
     * Analyze goals via LLM to classify narrative relevance.
     * Only runs if goalsIntentEnabled is true.
     *
     * @param {Array<string|object>} recentMessages - Recent message texts or structured turn objects
     * @param {number} currentTurn
     * @param {object|null} authorDirection - current user-set direction, if any
     */
    async analyze(recentMessages, currentTurn, authorDirection = null) {
        const settings = this.getSettings();
        if (!settings.goalsIntentEnabled) return;

        const goals = this.memoryStore.getAllEntities('goals');
        const goalList = Object.values(goals)
            .filter(g => !TERMINAL_STATUSES.has(unwrapField(g.fields?.status)));
        if (goalList.length === 0) return;

        const recentBeats = this.memoryStore.getRecentBeats(10);
        const messagesJson = this._normalizeRecentMessages(recentMessages).slice(-10);

        const directionJson = authorDirection?.text?.trim()
            ? { mode: authorDirection.mode, text: authorDirection.text.trim() }
            : null;

        const goalsJson = goalList.map(g => ({
            id: g.id,
            name: g.name,
            status: unwrapField(g.fields?.status) || 'in_progress',
            description: unwrapField(g.fields?.description) || '',
            importance: g.importance || 5,
            archived: g.tier === 3,
            timeframe: unwrapField(g.fields?.timeframe) || '',
            progress: unwrapField(g.fields?.progress) || '',
            blockers: unwrapField(g.fields?.blockers) || '',
        }));

        const beatsJson = recentBeats.map(b => ({
            id: b.id,
            turn: b.storyTurn,
            text: b.text,
        }));

        const lang = this.getLang();
        const systemPrompt = lang === 'zh'
            ? INTENT_SYSTEM_PROMPT_ZH
            : INTENT_SYSTEM_PROMPT;

        const userPrompt = lang === 'zh'
            ? getIntentUserPromptZh(messagesJson, goalsJson, beatsJson, directionJson)
            : getIntentUserPrompt(messagesJson, goalsJson, beatsJson, directionJson);

        const promptMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        try {
            const model = settings.goalsIntentModel || settings.model;
            const response = await this.apiClient.chatCompletion(promptMessages, null, model, { temperature: 0.25 });
            const parsed = this._parseAnalysisResponse(response);

            if (parsed) {
                const rankings = new Map();
                for (const item of parsed.goals) {
                    rankings.set(item.id, {
                        status: item.narrative_status || 'background',
                        relevance: typeof item.relevance === 'number' ? item.relevance : 0.5,
                        adjacentBeatIds: Array.isArray(item.adjacent_beat_ids) ? item.adjacent_beat_ids : [],
                    });
                }

                // Extract narrative direction (pacing, tension, focus, tone)
                let narrativeDirection = null;
                if (parsed.narrative_direction) {
                    const nd = parsed.narrative_direction;
                    narrativeDirection = {
                        pacing: VALID_PACING.includes(nd.pacing) ? nd.pacing : 'maintain',
                        pacingDirective: typeof nd.pacing_directive === 'string'
                            ? nd.pacing_directive.slice(0, 200) : '',
                        tension: typeof nd.tension === 'number'
                            ? Math.max(0, Math.min(1, nd.tension)) : 0.5,
                        focus: Array.isArray(nd.focus)
                            ? nd.focus.filter(f => VALID_FOCUS.includes(f)).slice(0, 3) : [],
                        tone: typeof nd.tone === 'string'
                            ? nd.tone.slice(0, 60) : '',
                        toneAvoid: typeof nd.tone_avoid === 'string'
                            ? nd.tone_avoid.slice(0, 200) : '',
                        nextBeatHint: typeof nd.next_beat_hint === 'string'
                            ? nd.next_beat_hint.slice(0, 200) : null,
                    };
                }

                const directionSuggestions = Array.isArray(parsed.direction_suggestions)
                    ? parsed.direction_suggestions
                        .map((item, index) => this._normalizeDirectionSuggestion(item, index))
                        .filter(Boolean)
                        .slice(0, 4)
                    : [];

                const nudgeDirectionChange = Boolean(parsed.nudge_direction_change);

                this._lastAnalysis = { turn: currentTurn, rankings, narrativeDirection, directionSuggestions, nudgeDirectionChange };

                if (settings.debugMode) {
                    console.debug('[RP Memory] Goal intent analysis:', Object.fromEntries(rankings));
                }
            }
        } catch (err) {
            console.warn('[RP Memory] GoalsManager: Intent analysis failed:', err.message);
        }
    }

    /**
     * Parse the LLM response for intent analysis.
     */
    _parseAnalysisResponse(responseText) {
        let cleaned = responseText.trim();
        if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
        else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
        if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
        cleaned = cleaned.trim();

        try {
            const parsed = JSON.parse(cleaned);
            if (!parsed || !Array.isArray(parsed.goals)) {
                console.warn('[RP Memory] GoalsManager: Invalid intent analysis response structure');
                return null;
            }
            return parsed;
        } catch (e) {
            console.warn('[RP Memory] GoalsManager: Failed to parse intent response:', e.message);
            return null;
        }
    }

    // ===================== Goal Ranking for Injection =====================

    /**
     * Get goals ranked for injection into the prompt.
     *
     * @param {number} currentTurn
     * @returns {Array<{entity, score}>} Ranked goals
     */
    getRankedGoals(currentTurn) {
        const goals = this.memoryStore.getAllEntities('goals');
        const goalList = Object.values(goals)
            .filter(g => !TERMINAL_STATUSES.has(unwrapField(g.fields?.status)));

        if (goalList.length === 0) return [];

        // If intent analysis ran this turn, use its rankings
        if (this._lastAnalysis && this._lastAnalysis.turn === currentTurn) {
            const ranked = [];
            for (const goal of goalList) {
                const analysis = this._lastAnalysis.rankings.get(goal.id);
                if (analysis) {
                    // Keep analysis advisory: do not inject inferred stale/terminal goals,
                    // but also do not rewrite canonical memory from this signal.
                    if (analysis.status === 'stale' || analysis.status === 'completed' || analysis.status === 'abandoned') continue;
                    ranked.push({ entity: goal, score: analysis.relevance, category: 'goals' });
                } else {
                    // Goals not in analysis get a default low score
                    ranked.push({ entity: goal, score: goal.tier === 3 ? 0.2 : 0.3, category: 'goals' });
                }
            }
            ranked.sort((a, b) => b.score - a.score);
            return ranked;
        }

        // Fallback: importance + recency scoring (same as _formatAll in PromptInjector)
        const ranked = goalList.map(goal => {
            const turnsSince = currentTurn - (goal.lastMentionedTurn || goal.createdTurn || 0);
            const recency = 1 / (1 + turnsSince * 0.1);
            const importance = (goal.importance || 5) / 10;
            const score = 0.5 * recency + 0.5 * importance;
            return { entity: goal, score, category: 'goals' };
        });
        ranked.sort((a, b) => b.score - a.score);
        return ranked;
    }

    // ===================== Narrative Direction =====================

    /**
     * Get narrative direction from the last analysis, if fresh.
     *
     * @param {number} currentTurn
     * @returns {object|null} { pacing, pacingDirective, tension, focus, tone, toneAvoid, nextBeatHint } or null
     */
    getNarrativeDirection(currentTurn) {
        if (!this._lastAnalysis) return null;
        if (this._lastAnalysis.turn !== currentTurn) return null;
        return this._lastAnalysis.narrativeDirection || null;
    }

    /**
     * Get explicit direction suggestions from the freshest analysis.
     *
     * @param {number} currentTurn
     * @returns {Array<{id: string, label: string, text: string}>}
     */
    getDirectionSuggestions(currentTurn) {
        if (!this._lastAnalysis) return [];
        if (this._lastAnalysis.turn !== currentTurn) return [];
        return Array.isArray(this._lastAnalysis.directionSuggestions)
            ? this._lastAnalysis.directionSuggestions
            : [];
    }

    /**
     * Whether the LLM analysis recommends the user change their current direction.
     *
     * @param {number} currentTurn
     * @returns {boolean}
     */
    shouldNudgeDirection(currentTurn) {
        if (!this._lastAnalysis) return false;
        if (this._lastAnalysis.turn !== currentTurn) return false;
        return Boolean(this._lastAnalysis.nudgeDirectionChange);
    }

    // ===================== Goal-Adjacent Beats =====================

    /**
     * Get beats related to the top-ranked goals.
     *
     * @param {string[]} goalIds - IDs of top-ranked goals
     * @returns {Map<string, Array>} goalId → array of related beats
     */
    getGoalBeats(goalIds) {
        const result = new Map();
        if (!goalIds || goalIds.length === 0) return result;

        // If intent analysis provided adjacent beat IDs, use those
        if (this._lastAnalysis && this._lastAnalysis.turn === this.memoryStore.getTurnCounter()) {
            const allBeats = this.memoryStore.getBeats();
            const beatIndex = new Map();
            for (const beat of allBeats) {
                beatIndex.set(beat.id, beat);
            }

            for (const goalId of goalIds) {
                const analysis = this._lastAnalysis.rankings?.get(goalId);
                if (analysis?.adjacentBeatIds?.length > 0) {
                    const beats = analysis.adjacentBeatIds
                        .map(id => beatIndex.get(id))
                        .filter(Boolean)
                        .slice(0, 2);
                    if (beats.length > 0) {
                        result.set(goalId, beats);
                        continue;
                    }
                }
                // Fallback for this goal
                result.set(goalId, this._findGoalBeatsByParticipants(goalId));
            }
            return result;
        }

        // No intent analysis — use participant overlap fallback
        for (const goalId of goalIds) {
            result.set(goalId, this._findGoalBeatsByParticipants(goalId));
        }
        return result;
    }

    /**
     * Find beats whose participants overlap with a goal's related entity IDs.
     * Picks top 1-2 by recency.
     */
    _findGoalBeatsByParticipants(goalId) {
        const allBeats = this.memoryStore.getBeats();
        const matching = allBeats
            .filter(b => b.participants?.includes(goalId))
            .sort((a, b) => b.storyTurn - a.storyTurn)
            .slice(0, 2);
        return matching;
    }

    _normalizeRecentMessages(recentMessages) {
        if (!Array.isArray(recentMessages)) return [];

        return recentMessages
            .map((message) => {
                if (typeof message === 'string') {
                    const text = message.trim();
                    return text ? {
                        speaker: 'Unknown',
                        role: 'assistant',
                        priority: 'normal',
                        text,
                    } : null;
                }

                if (!message || typeof message !== 'object') return null;

                const text = typeof message.text === 'string'
                    ? message.text.trim()
                    : typeof message.mes === 'string'
                        ? message.mes.trim()
                        : '';
                if (!text) return null;

                const isUser = Boolean(message.isUser ?? message.is_user);
                return {
                    speaker: message.speaker || message.name || (isUser ? 'User' : 'Assistant'),
                    role: isUser ? 'user' : (message.role || 'assistant'),
                    priority: message.priority || (message.isHighPriority ? 'high' : 'normal'),
                    text,
                };
            })
            .filter(Boolean);
    }

    _normalizeDirectionSuggestion(item, index) {
        if (!item || typeof item !== 'object') return null;

        const text = typeof item.text === 'string'
            ? item.text.trim().slice(0, 240)
            : '';
        if (!text) return null;

        const label = typeof item.label === 'string'
            ? item.label.trim().slice(0, 40)
            : '';
        const rawId = typeof item.id === 'string' && item.id.trim()
            ? item.id.trim()
            : (label || `option-${index + 1}`);
        const id = rawId
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || `option-${index + 1}`;

        return {
            id,
            label: label || `Option ${index + 1}`,
            text,
        };
    }
}

// ===================== Intent Analysis Prompts =====================

const INTENT_SYSTEM_PROMPT = `You are a narrative analyst for a roleplay story. Your job is to:
1. Classify each tracked goal by its current narrative relevance.
2. Assess the overall narrative pacing, tension, tone, and focus.
3. Propose four distinct direction suggestions the user could choose for the next reply.
4. If the user has set a scene direction, evaluate whether it still fits the story and flag if a change is warranted.

Output valid JSON only, no explanation.`;

const INTENT_SYSTEM_PROMPT_ZH = `你是一个角色扮演故事的叙事分析师。你的任务是：
1. 根据当前叙事相关性对每个目标进行分类。
2. 评估整体叙事节奏、张力、基调和焦点。
3. 提出4个不同的下一条回复方向建议，供用户选择。
4. 如果用户已设置场景方向，评估它是否仍然贴合故事，并在需要更换时标记。

只输出有效的JSON，不要解释。`;

function getIntentUserPrompt(messages, goals, beats, currentDirection) {
    const directionBlock = currentDirection
        ? `\nCURRENT AUTHOR DIRECTION (user-set steering for the scene):\n${JSON.stringify(currentDirection, null, 2)}\n`
        : `\nCURRENT AUTHOR DIRECTION: none\n`;

    return `Given the recent narrative and the current tracked goals, analyze each goal's relevance and assess the overall narrative direction.

RECENT MESSAGES:
${JSON.stringify(messages, null, 2)}

CURRENT GOALS:
${JSON.stringify(goals, null, 2)}

RECENT BEATS:
${JSON.stringify(beats, null, 2)}
${directionBlock}
Output this JSON structure:
{
  "goals": [
    {
      "id": "goal-id",
      "narrative_status": "active|background|stale|completed|abandoned",
      "relevance": 0.0-1.0,
      "adjacent_beat_ids": ["beat-id-1"]
    }
  ],
  "narrative_direction": {
    "pacing": "accelerate|maintain|slow_down|pivot",
    "pacing_directive": "1-2 sentence directive for the narrator",
    "tension": 0.0-1.0,
    "focus": ["element1", "element2"],
    "tone": "1-3 word emotional register",
    "tone_avoid": "what tone/approach to steer away from",
    "next_beat_hint": "optional 1-sentence narrative suggestion or null"
  },
  "direction_suggestions": [
    {
      "id": "short-kebab-case-id",
      "label": "2-4 word label",
      "text": "A single-sentence direction the user could choose for the next reply."
    }
  ],
  "nudge_direction_change": false
}

Goal rules:
- Treat entries with "priority": "high" as strong evidence of the user's intent and choices
- "active": user is currently pursuing this goal
- "background": relevant but not immediately pursued
- "stale": hasn't been relevant for a while
- "completed": narrative signals suggest goal was achieved
- "abandoned": narrative signals suggest goal was given up
- archived goals are dormant threads that can become relevant again
- do not mark a goal "completed" or "abandoned" unless the evidence in the recent turns is explicit
- relevance: 0.0 = completely irrelevant, 1.0 = central focus
- adjacent_beat_ids: 0-2 beat IDs most related to this goal (from the RECENT BEATS list)

Narrative direction rules:
- pacing: "accelerate" = push toward climax/resolution; "maintain" = current pace is good; "slow_down" = add breathing room, character moments; "pivot" = shift tone or introduce new thread
- pacing_directive: brief instruction for the narrator's next response style
- tension: 0.0 = relaxed/calm, 1.0 = peak dramatic tension
- focus: 1-3 from [character_development, plot_advancement, world_building, relationship_dynamics, action_conflict, mystery_revelation]
- tone: 1-3 word emotional register (e.g. "somber, introspective", "tense, foreboding", "warm, playful")
- tone_avoid: brief note on what tone or approach to avoid right now, or empty string if none
- next_beat_hint: optional single-sentence narrative nudge based on active goals and trajectory, or null

Direction suggestion rules:
- Generate exactly 4 distinct suggestions for how the next reply could be directed
- These are for the user to choose from, so make them meaningfully different from each other
- Keep labels short (2-4 words) and concrete
- Keep each text to one sentence, forward-looking, and specific to the current scene or trajectory
- Suggestions should be guidance, not canon facts or memory updates

Direction change nudge:
- If CURRENT AUTHOR DIRECTION is "none", set nudge_direction_change to false
- If a direction is set, evaluate whether it still aligns with the story's current trajectory, tone, and the recent messages
- Set nudge_direction_change to true ONLY if the direction has become misaligned, redundant, or counterproductive — i.e. the story has moved past it
- Do NOT nudge just because the direction was partially fulfilled; nudge only when continuing to follow it would steer the story in the wrong direction or hold it back`;
}

function getIntentUserPromptZh(messages, goals, beats, currentDirection) {
    const directionBlock = currentDirection
        ? `\n当前作者方向（用户为场景设置的引导）：\n${JSON.stringify(currentDirection, null, 2)}\n`
        : `\n当前作者方向：无\n`;

    return `根据最近的叙事和当前跟踪的目标，分析每个目标的相关性并评估整体叙事方向。

最近的消息：
${JSON.stringify(messages, null, 2)}

当前目标：
${JSON.stringify(goals, null, 2)}

最近的节拍：
${JSON.stringify(beats, null, 2)}
${directionBlock}
输出以下JSON结构：
{
  "goals": [
    {
      "id": "目标ID",
      "narrative_status": "active|background|stale|completed|abandoned",
      "relevance": 0.0-1.0,
      "adjacent_beat_ids": ["节拍ID"]
    }
  ],
  "narrative_direction": {
    "pacing": "accelerate|maintain|slow_down|pivot",
    "pacing_directive": "给叙述者的1-2句指导",
    "tension": 0.0-1.0,
    "focus": ["元素1", "元素2"],
    "tone": "1-3个词的情感基调",
    "tone_avoid": "当前应避免的基调或方式",
    "next_beat_hint": "可选的1句叙事建议或null"
  },
  "direction_suggestions": [
    {
      "id": "简短-kebab-case-id",
      "label": "2-4词标签",
      "text": "用户可选择的下一条回复方向，一句话。"
    }
  ],
  "nudge_direction_change": false
}

目标规则：
- 将 "priority": "high" 的条目视为用户意图和选择的强信号
- "active"：用户正在积极追求此目标
- "background"：相关但未立即追求
- "stale"：已经有一段时间没有相关性
- "completed"：叙事信号表明目标已达成
- "abandoned"：叙事信号表明目标已放弃
- archived 目标表示休眠线程，仍然可能重新变得相关
- 除非最近回合里有明确证据，否则不要把目标标记为 "completed" 或 "abandoned"
- relevance：0.0 = 完全不相关，1.0 = 核心焦点
- adjacent_beat_ids：与此目标最相关的0-2个节拍ID（来自最近的节拍列表）

叙事方向规则：
- pacing："accelerate" = 推向高潮/解决；"maintain" = 当前节奏良好；"slow_down" = 增加喘息空间、角色互动；"pivot" = 转换基调或引入新线索
- pacing_directive：给叙述者下一个回复风格的简短指导
- tension：0.0 = 放松/平静，1.0 = 最高戏剧张力
- focus：从以下选择1-3个元素 [character_development, plot_advancement, world_building, relationship_dynamics, action_conflict, mystery_revelation]
- tone：1-3个词的情感基调（例如："沉郁、内省"、"紧张、不祥"、"温暖、俏皮"）
- tone_avoid：当前应避免的基调或叙事方式的简短说明，无则留空
- next_beat_hint：基于活跃目标和轨迹的可选单句叙事建议，或null

方向建议规则：
- 恰好生成4个不同的方向建议，供用户选择
- 这些建议之间要有明显差异，不能只是同义改写
- label 保持简短具体（2-4个词）
- text 保持一句话，面向下一条回复，并贴合当前场景或轨迹
- 建议应是引导，不是设定事实，也不是记忆更新

方向变更建议：
- 如果当前作者方向为"无"，则 nudge_direction_change 设为 false
- 如果有方向，评估它是否仍与故事当前的走向、基调和最近消息一致
- 仅当方向已经偏离、冗余或起反作用时才将 nudge_direction_change 设为 true——即故事已经超越了它
- 不要仅仅因为方向被部分实现就建议更换；只在继续遵循会把故事引向错误方向或阻碍发展时才建议`;
}
