import { unwrapField } from './Utils.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'abandoned']);

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
        this._lastAnalysis = null; // { turn, rankings: Map<goalId, {status, relevance, adjacentBeatIds}> }
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

            const effectiveScore = entity.baseScore * Math.pow(decayFactor, turnsSince);
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
                if (turnsSince >= retireAfterTurns) {
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
     * @param {string[]} recentMessages - Recent message texts
     * @param {number} currentTurn
     */
    async analyze(recentMessages, currentTurn) {
        const settings = this.getSettings();
        if (!settings.goalsIntentEnabled) return;

        const goals = this.memoryStore.getAllEntities('goals');
        const goalList = Object.values(goals).filter(g => g.tier !== 3);
        if (goalList.length === 0) return;

        const recentBeats = this.memoryStore.getRecentBeats(10);

        const goalsJson = goalList.map(g => ({
            id: g.id,
            name: g.name,
            status: unwrapField(g.fields?.status) || 'in_progress',
            description: unwrapField(g.fields?.description) || '',
            importance: g.importance || 5,
        }));

        const beatsJson = recentBeats.map(b => ({
            id: b.id,
            turn: b.storyTurn,
            text: b.text,
        }));

        const messagesText = recentMessages.slice(-10).join('\n\n---\n\n');

        const lang = this.getLang();
        const systemPrompt = lang === 'zh'
            ? INTENT_SYSTEM_PROMPT_ZH
            : INTENT_SYSTEM_PROMPT;

        const userPrompt = lang === 'zh'
            ? getIntentUserPromptZh(messagesText, goalsJson, beatsJson)
            : getIntentUserPrompt(messagesText, goalsJson, beatsJson);

        const promptMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        try {
            const model = settings.goalsIntentModel || settings.model;
            const response = await this.apiClient.chatCompletion(promptMessages, null, model);
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

                this._lastAnalysis = { turn: currentTurn, rankings };

                // Auto-update entity status for terminal classifications
                for (const [goalId, ranking] of rankings) {
                    if (ranking.status === 'completed' || ranking.status === 'abandoned') {
                        const entity = this.memoryStore.getEntity('goals', goalId);
                        if (entity) {
                            const currentStatus = unwrapField(entity.fields?.status);
                            if (!TERMINAL_STATUSES.has(currentStatus)) {
                                if (entity.fields?.status && typeof entity.fields.status === 'object' && 'value' in entity.fields.status) {
                                    entity.fields.status.value = ranking.status;
                                    entity.fields.status.lastUpdated = currentTurn;
                                } else {
                                    if (!entity.fields) entity.fields = {};
                                    entity.fields.status = ranking.status;
                                }
                                if (settings.debugMode) {
                                    console.debug(`[RP Memory] GoalsManager: Auto-updated "${entity.name}" status to "${ranking.status}" based on intent analysis`);
                                }
                            }
                        }
                    }
                }

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
     * @returns {Array<{entity, score}>} Ranked goals (excluding tier-3)
     */
    getRankedGoals(currentTurn) {
        const goals = this.memoryStore.getAllEntities('goals');
        const goalList = Object.values(goals).filter(g => g.tier !== 3);

        if (goalList.length === 0) return [];

        // If intent analysis ran this turn, use its rankings
        if (this._lastAnalysis && this._lastAnalysis.turn === currentTurn) {
            const ranked = [];
            for (const goal of goalList) {
                const analysis = this._lastAnalysis.rankings.get(goal.id);
                if (analysis) {
                    // Filter out stale goals
                    if (analysis.status === 'stale') continue;
                    ranked.push({ entity: goal, score: analysis.relevance, category: 'goals' });
                } else {
                    // Goals not in analysis get a default low score
                    ranked.push({ entity: goal, score: 0.3, category: 'goals' });
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
        if (this._lastAnalysis) {
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
}

// ===================== Intent Analysis Prompts =====================

const INTENT_SYSTEM_PROMPT = `You are a narrative analyst for a roleplay story. Your job is to classify goals by their current narrative relevance.

Output valid JSON only, no explanation.`;

const INTENT_SYSTEM_PROMPT_ZH = `你是一个角色扮演故事的叙事分析师。你的任务是根据当前叙事相关性对目标进行分类。

只输出有效的JSON，不要解释。`;

function getIntentUserPrompt(messages, goals, beats) {
    return `Given the recent narrative and the current tracked goals, analyze each goal's relevance.

RECENT MESSAGES:
${messages}

CURRENT GOALS:
${JSON.stringify(goals, null, 2)}

RECENT BEATS:
${JSON.stringify(beats, null, 2)}

For each goal, output:
{
  "goals": [
    {
      "id": "goal-id",
      "narrative_status": "active|background|stale|completed|abandoned",
      "relevance": 0.0-1.0,
      "adjacent_beat_ids": ["beat-id-1"]
    }
  ]
}

Rules:
- "active": user is currently pursuing this goal
- "background": relevant but not immediately pursued
- "stale": hasn't been relevant for a while
- "completed": narrative signals suggest goal was achieved
- "abandoned": narrative signals suggest goal was given up
- relevance: 0.0 = completely irrelevant, 1.0 = central focus
- adjacent_beat_ids: 0-2 beat IDs most related to this goal (from the RECENT BEATS list)`;
}

function getIntentUserPromptZh(messages, goals, beats) {
    return `根据最近的叙事和当前跟踪的目标，分析每个目标的相关性。

最近的消息：
${messages}

当前目标：
${JSON.stringify(goals, null, 2)}

最近的节拍：
${JSON.stringify(beats, null, 2)}

对每个目标输出：
{
  "goals": [
    {
      "id": "目标ID",
      "narrative_status": "active|background|stale|completed|abandoned",
      "relevance": 0.0-1.0,
      "adjacent_beat_ids": ["节拍ID"]
    }
  ]
}

规则：
- "active"：用户正在积极追求此目标
- "background"：相关但未立即追求
- "stale"：已经有一段时间没有相关性
- "completed"：叙事信号表明目标已达成
- "abandoned"：叙事信号表明目标已放弃
- relevance：0.0 = 完全不相关，1.0 = 核心焦点
- adjacent_beat_ids：与此目标最相关的0-2个节拍ID（来自最近的节拍列表）`;
}
