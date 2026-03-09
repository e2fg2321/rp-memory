import { estimateTokens, unwrapField } from './Utils.js';

const MAX_SELECTED_TURNS = 8;
const MAX_SUBMITTED_TURNS = 120;
const MAX_SUBMITTED_TOKENS = 12000;
const MAX_VERBATIM_ANCHORS = 2;

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class RawTurnRanker {
    constructor(apiClient, getSettings, getLang = null) {
        this.apiClient = apiClient;
        this.getSettings = getSettings;
        this.getLang = getLang || (() => 'en');
    }

    /**
     * Rank raw turns linked to the currently relevant entities.
     * Returns ranked turns plus debug-friendly stats for future benchmarking.
     */
    async rank(memoryStore, recentMessages, relevantEntities, currentTurn = 0, opts = {}) {
        const {
            rawTurnBudget = Infinity,
            compactionEnabled = true,
        } = opts;
        const { candidates, totalLinked, relevantIds } = this._buildCandidates(memoryStore, relevantEntities, currentTurn);
        if (candidates.length === 0) {
            return {
                ranked: [],
                stats: {
                    mode: 'raw_turns_experimental',
                    candidateCount: 0,
                    linkedCount: totalLinked,
                    submittedCount: 0,
                    selectedCount: 0,
                    estimatedPromptTokens: 0,
                    compactionEstimatedPromptTokens: 0,
                    finalTurnTokens: 0,
                    rawTurnBudget: Number.isFinite(rawTurnBudget) ? Math.max(0, Math.floor(rawTurnBudget)) : null,
                    usage: null,
                    compactionUsage: null,
                    totalUsage: null,
                    fallbackUsed: false,
                    compactionEnabled,
                    compactionApplied: false,
                    compactionFallbackUsed: false,
                    compactedCount: 0,
                    anchorCount: 0,
                    droppedForBudget: 0,
                },
            };
        }

        const { submitted, truncatedCount } = this._limitCandidates(candidates);
        const messages = this._buildPromptMessages(recentMessages, relevantEntities, submitted);
        const estimatedPromptTokens = estimateTokens(messages.map(m => m.content).join('\n\n'));

        let parsed = null;
        let usage = null;
        let fallbackUsed = false;

        try {
            const response = await this.apiClient.chatCompletionDetailed(messages, null, null, { temperature: 0.0 });
            usage = response.usage || null;
            parsed = this._parseResponse(response.content, submitted);
        } catch (err) {
            console.warn('[RP Memory] Raw-turn ranking failed, using heuristic fallback:', err.message);
        }

        if (!parsed || parsed.length === 0) {
            fallbackUsed = true;
            parsed = this._heuristicRank(submitted, relevantIds, currentTurn);
        }

        const initialSelectedCount = parsed.length;
        const preCompactionTokens = this._estimateInjectionTokens(parsed);
        const anchorCount = Math.min(MAX_VERBATIM_ANCHORS, parsed.length);

        let compactionUsage = null;
        let compactionEstimatedPromptTokens = 0;
        let compactionApplied = false;
        let compactionFallbackUsed = false;
        let compactedCount = 0;

        if (compactionEnabled && parsed.length > anchorCount) {
            const compactionResult = await this._compactSupportTurns(recentMessages, relevantEntities, parsed, anchorCount);
            parsed = compactionResult.ranked;
            compactionUsage = compactionResult.usage;
            compactionEstimatedPromptTokens = compactionResult.estimatedPromptTokens;
            compactionApplied = compactionResult.applied;
            compactionFallbackUsed = compactionResult.fallbackUsed;
            compactedCount = compactionResult.compactedCount;
        }

        const postCompactionTokens = this._estimateInjectionTokens(parsed);
        const normalizedRawTurnBudget = Number.isFinite(rawTurnBudget)
            ? Math.max(0, Math.floor(rawTurnBudget))
            : Infinity;
        const fitted = this._fitRankedTurnsToBudget(parsed, normalizedRawTurnBudget);
        const finalTurnTokens = this._estimateInjectionTokens(fitted);
        const droppedForBudget = Math.max(0, parsed.length - fitted.length);

        return {
            ranked: fitted,
            stats: {
                mode: 'raw_turns_experimental',
                candidateCount: candidates.length,
                linkedCount: totalLinked,
                submittedCount: submitted.length,
                selectedCount: fitted.length,
                rankedCountBeforeBudget: initialSelectedCount,
                truncatedCount,
                estimatedPromptTokens,
                compactionEstimatedPromptTokens,
                preCompactionTokens,
                postCompactionTokens,
                finalTurnTokens,
                rawTurnBudget: Number.isFinite(normalizedRawTurnBudget) ? normalizedRawTurnBudget : null,
                usage,
                compactionUsage,
                totalUsage: this._mergeUsage(usage, compactionUsage),
                fallbackUsed,
                compactionEnabled,
                compactionApplied,
                compactionFallbackUsed,
                compactedCount,
                anchorCount,
                droppedForBudget,
            },
        };
    }

    _buildCandidates(memoryStore, relevantEntities, currentTurn) {
        const rawTurns = memoryStore.getRawTurns();
        const relevantIds = new Set(relevantEntities.slice(0, 20).map(item => item.entity.id));
        const candidates = [];

        for (const turn of rawTurns) {
            const linkedEntities = Array.isArray(turn.linkedEntities) ? turn.linkedEntities : [];
            const overlap = linkedEntities.filter(id => relevantIds.has(id));
            if (overlap.length === 0) continue;

            const turnsSince = Math.max(0, currentTurn - (turn.storyTurn || 0));
            const recency = 1 / (1 + turnsSince * 0.15);
            candidates.push({
                turn,
                overlapCount: overlap.length,
                overlapIds: overlap,
                heuristicScore: overlap.length + recency,
            });
        }

        if (candidates.length === 0) {
            const fallbackTurns = rawTurns
                .slice()
                .sort((a, b) => (b.storyTurn || 0) - (a.storyTurn || 0))
                .slice(0, 24);

            return {
                candidates: fallbackTurns.map(turn => ({
                    turn,
                    overlapCount: 0,
                    overlapIds: [],
                    heuristicScore: 0.25 + (1 / (1 + Math.max(0, currentTurn - (turn.storyTurn || 0)) * 0.15)),
                })),
                totalLinked: 0,
                relevantIds,
            };
        }

        candidates.sort((a, b) =>
            b.overlapCount - a.overlapCount
            || b.heuristicScore - a.heuristicScore
            || (b.turn.storyTurn || 0) - (a.turn.storyTurn || 0),
        );

        return {
            candidates,
            totalLinked: candidates.length,
            relevantIds,
        };
    }

    _limitCandidates(candidates) {
        const submitted = [];
        let tokenCount = 0;

        for (const candidate of candidates) {
            if (submitted.length >= MAX_SUBMITTED_TURNS) break;

            const candidateTokens = estimateTokens(this._formatCandidate(candidate, true));
            if (submitted.length > 0 && (tokenCount + candidateTokens) > MAX_SUBMITTED_TOKENS) {
                continue;
            }

            submitted.push(candidate);
            tokenCount += candidateTokens;
        }

        return {
            submitted,
            truncatedCount: Math.max(0, candidates.length - submitted.length),
        };
    }

    _buildPromptMessages(recentMessages, relevantEntities, submitted) {
        const lang = this.getLang();
        const systemPrompt = lang === 'zh'
            ? `你是一个角色扮演记忆检索排序器。你的任务是从候选原始回合中挑出最值得注入到当前提示里的内容。

规则：
- 只返回有效 JSON，不要解释。
- 优先选择能提供事实锚点、未解决承诺、关系变化、地点状态或关键决策的回合。
- 避免重复或几乎相同的回合。
- 优先选择与“相关实体”强相关的回合。
- 最多选择 ${MAX_SELECTED_TURNS} 个回合。

输出格式：
{
  "selected": [
    { "id": "raw-turn-42", "score": 0.93, "reason": "说明此回合为何相关" }
  ]
}`
            : `You are a retrieval ranker for roleplay memory injection. Select the raw turns that should be injected for the next model call.

Rules:
- Return valid JSON only. No explanation outside the JSON.
- Prefer turns that anchor facts, unresolved commitments, relationship shifts, location state, or key decisions.
- Avoid redundant near-duplicate turns.
- Prefer turns tightly connected to the relevant entities.
- Select at most ${MAX_SELECTED_TURNS} turns.

Output format:
{
  "selected": [
    { "id": "raw-turn-42", "score": 0.93, "reason": "Why this turn matters" }
  ]
}`;

        const contextBlock = recentMessages
            .slice(-8)
            .map(msg => `- ${msg}`)
            .join('\n');

        const entityBlock = relevantEntities
            .slice(0, 12)
            .map(item => this._formatEntity(item))
            .join('\n');

        const candidateBlock = submitted
            .map(candidate => this._formatCandidate(candidate))
            .join('\n\n');

        const userPrompt = lang === 'zh'
            ? `=== 当前最近上下文 ===
${contextBlock || '(无)'}

=== 相关实体 ===
${entityBlock || '(无)'}

=== 候选原始回合 ===
${candidateBlock}

挑选最有助于下一次生成的原始回合。`
            : `=== Recent Context ===
${contextBlock || '(none)'}

=== Relevant Entities ===
${entityBlock || '(none)'}

=== Candidate Raw Turns ===
${candidateBlock}

Select the raw turns that will most help the next generation call.`;

        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];
    }

    _buildCompactionMessages(recentMessages, relevantEntities, anchors, supportTurns) {
        const lang = this.getLang();
        const systemPrompt = lang === 'zh'
            ? `你是一个角色扮演记忆压缩器。你会收到已经通过相关性筛选的低优先级原始回合，请把它们压缩成更适合注入提示词的短摘要。

规则：
- 只返回有效 JSON，不要解释。
- 每个回合单独压缩，不要合并不同回合。
- 保留名字、地点、承诺、请求、关系变化、状态变化、数字、时间、物品、伤势，以及任何未解决的钩子。
- 不要编造事实，也不要改写事实含义。
- 尽量比原文更短，但不要删掉会影响下一次生成的重要信息。

输出格式：
{
  "snippets": [
    { "id": "raw-turn-42", "text": "压缩后的相关摘要" }
  ]
}`
            : `You compact support turns for roleplay memory injection. These turns were already selected as relevant, but they are lower priority than the verbatim anchors.

Rules:
- Return valid JSON only. No explanation outside the JSON.
- Compact each turn independently. Do not merge multiple turns together.
- Preserve names, locations, promises, requests, relationship changes, state changes, numbers, time references, items, injuries, and unresolved hooks.
- Do not invent facts or change the meaning of the source turn.
- Make each snippet shorter than the source when possible, but keep the information that could matter for the next generation.

Output format:
{
  "snippets": [
    { "id": "raw-turn-42", "text": "Compacted task-specific summary" }
  ]
}`;

        const contextBlock = recentMessages
            .slice(-8)
            .map(msg => `- ${msg}`)
            .join('\n');

        const entityBlock = relevantEntities
            .slice(0, 12)
            .map(item => this._formatEntity(item))
            .join('\n');

        const anchorBlock = anchors
            .map(item => this._formatTurnBlock(item.turn))
            .join('\n\n');

        const supportBlock = supportTurns
            .map(item => this._formatTurnBlock(item.turn))
            .join('\n\n');

        const userPrompt = lang === 'zh'
            ? `=== 当前最近上下文 ===
${contextBlock || '(无)'}

=== 相关实体 ===
${entityBlock || '(无)'}

=== 已保留原文的锚点回合 ===
${anchorBlock || '(无)'}

=== 需要压缩的支持回合 ===
${supportBlock}

请分别压缩每个支持回合，使其更适合当前场景的提示词注入。`
            : `=== Recent Context ===
${contextBlock || '(none)'}

=== Relevant Entities ===
${entityBlock || '(none)'}

=== Verbatim Anchor Turns ===
${anchorBlock || '(none)'}

=== Support Turns To Compact ===
${supportBlock}

Compact each support turn so it is more useful for the current scene injection.`;

        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];
    }

    _formatEntity(item) {
        const entity = item.entity;
        const fields = entity.fields || {};
        const summaryParts = [];

        const preferredFields = ['description', 'status', 'currentLocation', 'progress', 'goals', 'relationships', 'consequences'];
        for (const field of preferredFields) {
            const value = unwrapField(fields[field]);
            if (value) {
                summaryParts.push(`${field}: ${value}`);
            }
            if (summaryParts.length >= 2) break;
        }

        const summary = summaryParts.length > 0 ? ` | ${summaryParts.join(' | ')}` : '';
        return `- ${item.category}:${entity.id} (${entity.name})${summary}`;
    }

    _formatCandidate(candidate, compact = false) {
        const linked = candidate.turn.linkedEntityNames?.length
            ? candidate.turn.linkedEntityNames.join(', ')
            : candidate.turn.linkedEntities?.length
                ? candidate.turn.linkedEntities.join(', ')
            : 'none';
        const header = `[${candidate.turn.id}] Turn ${candidate.turn.storyTurn} | linked: ${linked}`;
        if (compact) {
            return `${header}\n${candidate.turn.text}`;
        }
        return `${header}\n${candidate.turn.text}`;
    }

    _formatTurnBlock(turn) {
        const linked = turn.linkedEntityNames?.length
            ? turn.linkedEntityNames.join(', ')
            : turn.linkedEntities?.length
                ? turn.linkedEntities.join(', ')
            : 'none';
        return `[${turn.id}] Turn ${turn.storyTurn} | linked: ${linked}\n${this._getTurnText(turn)}`;
    }

    _parseResponse(responseText, submitted) {
        const cleaned = this._cleanJsonResponse(responseText);

        const byId = new Map(submitted.map(candidate => [candidate.turn.id, candidate]));

        try {
            const parsed = JSON.parse(cleaned);
            const selected = Array.isArray(parsed?.selected) ? parsed.selected : [];
            const ranked = [];

            for (const item of selected) {
                const candidate = byId.get(item?.id);
                if (!candidate) continue;

                ranked.push({
                    turn: candidate.turn,
                    score: Number.isFinite(item.score) ? item.score : candidate.heuristicScore,
                    reason: typeof item.reason === 'string' ? item.reason.trim() : '',
                });
            }

            ranked.sort((a, b) => b.score - a.score || (b.turn.storyTurn || 0) - (a.turn.storyTurn || 0));
            return ranked.slice(0, MAX_SELECTED_TURNS);
        } catch (err) {
            console.warn('[RP Memory] Failed to parse raw-turn ranking response:', err.message);
            return null;
        }
    }

    _parseCompactionResponse(responseText, supportTurns) {
        const cleaned = this._cleanJsonResponse(responseText);
        const allowedIds = new Set(supportTurns.map(item => item.turn.id));
        const compacted = new Map();

        try {
            const parsed = JSON.parse(cleaned);
            const snippets = Array.isArray(parsed?.snippets) ? parsed.snippets : [];
            for (const snippet of snippets) {
                if (!allowedIds.has(snippet?.id)) continue;
                if (typeof snippet?.text !== 'string') continue;
                const text = snippet.text.trim();
                if (!text) continue;
                compacted.set(snippet.id, text);
            }
            return compacted;
        } catch (err) {
            console.warn('[RP Memory] Failed to parse raw-turn compaction response:', err.message);
            return null;
        }
    }

    _heuristicRank(submitted, relevantIds, currentTurn) {
        const ranked = submitted.map(candidate => {
            const overlapBoost = candidate.overlapIds.reduce((sum, id) => sum + (relevantIds.has(id) ? 1 : 0), 0);
            const turnsSince = Math.max(0, currentTurn - (candidate.turn.storyTurn || 0));
            const recency = 1 / (1 + turnsSince * 0.15);
            return {
                turn: candidate.turn,
                score: overlapBoost + recency,
                reason: '',
            };
        });

        ranked.sort((a, b) => b.score - a.score || (b.turn.storyTurn || 0) - (a.turn.storyTurn || 0));
        return ranked.slice(0, MAX_SELECTED_TURNS);
    }

    async _compactSupportTurns(recentMessages, relevantEntities, ranked, anchorCount) {
        const anchors = ranked.slice(0, anchorCount);
        const supportTurns = ranked.slice(anchorCount);
        if (supportTurns.length === 0) {
            return {
                ranked,
                usage: null,
                estimatedPromptTokens: 0,
                applied: false,
                fallbackUsed: false,
                compactedCount: 0,
            };
        }

        const messages = this._buildCompactionMessages(recentMessages, relevantEntities, anchors, supportTurns);
        const estimatedPromptTokens = estimateTokens(messages.map(m => m.content).join('\n\n'));

        let usage = null;
        let parsed = null;

        try {
            const response = await this.apiClient.chatCompletionDetailed(messages, null, null, { temperature: 0.0 });
            usage = response.usage || null;
            parsed = this._parseCompactionResponse(response.content, supportTurns);
        } catch (err) {
            console.warn('[RP Memory] Raw-turn compaction failed, keeping verbatim support turns:', err.message);
        }

        if (!parsed || parsed.size === 0) {
            return {
                ranked,
                usage,
                estimatedPromptTokens,
                applied: false,
                fallbackUsed: true,
                compactedCount: 0,
            };
        }

        let compactedCount = 0;
        const nextRanked = ranked.map((item, index) => {
            if (index < anchorCount) return item;

            const compactedText = parsed.get(item.turn.id);
            if (!compactedText) return item;

            const displayText = this._selectDisplayText(item.turn.text, compactedText);
            if (displayText === item.turn.text) return item;

            compactedCount++;
            return {
                ...item,
                turn: {
                    ...item.turn,
                    displayText,
                    compacted: true,
                },
            };
        });

        return {
            ranked: nextRanked,
            usage,
            estimatedPromptTokens,
            applied: compactedCount > 0,
            fallbackUsed: false,
            compactedCount,
        };
    }

    _fitRankedTurnsToBudget(rankedTurns, rawTurnBudget) {
        if (!Number.isFinite(rawTurnBudget)) {
            return rankedTurns;
        }
        if (rawTurnBudget <= 0) {
            return [];
        }

        const selected = [];
        let usedTokens = estimateTokens('## Relevant Raw Turns');

        for (const item of rankedTurns) {
            const candidateTokens = this._estimateTurnTokens(item.turn);
            if (selected.length > 0 && (usedTokens + candidateTokens) > rawTurnBudget) {
                continue;
            }

            if (selected.length === 0 && (usedTokens + candidateTokens) > rawTurnBudget) {
                selected.push(item);
                break;
            }

            selected.push(item);
            usedTokens += candidateTokens;
        }

        return selected;
    }

    _estimateInjectionTokens(rankedTurns) {
        if (!Array.isArray(rankedTurns) || rankedTurns.length === 0) return 0;

        const ordered = rankedTurns
            .map(item => item.turn || item)
            .slice()
            .sort((a, b) => (a.storyTurn || 0) - (b.storyTurn || 0));

        const lines = ['## Relevant Raw Turns'];
        for (const turn of ordered) {
            lines.push(this._formatInjectionEntry(turn));
        }
        return estimateTokens(lines.join('\n'));
    }

    _estimateTurnTokens(turn) {
        return estimateTokens(this._formatInjectionEntry(turn));
    }

    _formatInjectionEntry(turn) {
        const linkedValues = Array.isArray(turn.linkedEntityNames) && turn.linkedEntityNames.length > 0
            ? turn.linkedEntityNames
            : turn.linkedEntities;
        const linked = Array.isArray(linkedValues) && linkedValues.length > 0
            ? ` (${linkedValues.join(', ')})`
            : '';
        const body = this._getTurnText(turn)
            .split('\n')
            .map(line => `  ${line}`)
            .join('\n');
        return `- [Turn ${turn.storyTurn}]${linked}\n${body}`;
    }

    _getTurnText(turn) {
        return String(turn?.displayText || turn?.text || '').trim();
    }

    _selectDisplayText(originalText, compactedText) {
        const original = String(originalText || '').trim();
        const compacted = String(compactedText || '').trim();
        if (!compacted) return original;
        if (!original) return compacted;

        const originalTokens = estimateTokens(original);
        const compactedTokens = estimateTokens(compacted);
        if (compactedTokens > originalTokens + 8) {
            return original;
        }

        return compacted;
    }

    _mergeUsage(...usageEntries) {
        const present = usageEntries.filter(entry => entry && typeof entry === 'object');
        if (present.length === 0) return null;

        const totals = {};
        for (const entry of present) {
            for (const [key, value] of Object.entries(entry)) {
                if (typeof value !== 'number') continue;
                totals[key] = (totals[key] || 0) + value;
            }
        }

        return Object.keys(totals).length > 0 ? totals : null;
    }

    _cleanJsonResponse(responseText) {
        let cleaned = String(responseText || '').trim();
        if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
        else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
        if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
        return cleaned.trim();
    }

    /**
     * Link a transcript turn to current entities using exact-ish name/alias matches.
     * Shared here so extraction and ranking use the same matching rules.
     */
    static resolveLinkedEntities(memoryStore, text) {
        const normalizedText = String(text || '').toLowerCase();
        if (!normalizedText) return [];

        const linked = new Set();
        const categories = ['mainCharacter', 'characters', 'locations', 'goals', 'events'];

        for (const category of categories) {
            const entities = memoryStore.getAllEntities(category);
            for (const entity of Object.values(entities)) {
                const variants = [entity.name, ...(entity.aliases || [])]
                    .map(v => String(v || '').trim())
                    .filter(Boolean)
                    .sort((a, b) => b.length - a.length);

                for (const variant of variants) {
                    if (RawTurnRanker._textContainsVariant(normalizedText, variant)) {
                        linked.add(entity.id);
                        break;
                    }
                }
            }
        }

        return [...linked];
    }

    static _textContainsVariant(normalizedText, variant) {
        const needle = variant.toLowerCase();
        if (!needle) return false;

        // CJK names do not use word boundaries reliably.
        if (/[\u3400-\u9fff]/.test(needle)) {
            return normalizedText.includes(needle);
        }

        if (needle.length < 3) return false;

        const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, 'i');
        return pattern.test(normalizedText);
    }
}
