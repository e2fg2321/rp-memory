import { unwrapField } from './Utils.js';

/**
 * PlotDirector — produces a forward-looking arc-beat plan plus a pacing signal.
 *
 * Consumes: current plan (if any), NPC agendas, MC + goals + recent beats + reflections,
 * scene type, author direction, recent messages.
 *
 * Emits: 3–5 short-horizon arc beats (the next intended story progressions), a pacing
 * signal (advance / hold / complicate), and a short scene assessment.
 *
 * Runs sparser than extraction (default every 3 turns). Intended to be paired with
 * a stronger model than the cheap extraction model — the director is the one call
 * that's expensive to screw up.
 */
export class PlotDirector {
    constructor(apiClient, memoryStore, getSettings, getLang) {
        this.apiClient = apiClient;
        this.memoryStore = memoryStore;
        this.getSettings = getSettings;
        this.getLang = getLang || (() => 'en');
        this._abortController = null;
    }

    abort() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    }

    /**
     * Check whether it's time to run the director.
     */
    shouldRun() {
        const settings = this.getSettings();
        if (!settings.directorEnabled) return false;

        const interval = Math.max(1, settings.directorInterval || 3);
        const last = this.memoryStore.getLastDirectorTurn();
        const current = this.memoryStore.getTurnCounter();
        return current - last >= interval;
    }

    /**
     * Run the director. Updates the MemoryStore's directorPlan in place.
     * Returns the new plan, or null if skipped/failed.
     */
    async run({ recentMessages = [], sceneType = null, npcAgendas = null } = {}) {
        const settings = this.getSettings();
        const lang = this.getLang();
        const currentTurn = this.memoryStore.getTurnCounter();
        const modelOverride = settings.directorModel || null;

        const existingPlan = this.memoryStore.getDirectorPlan();
        const activeNPCAgendas = npcAgendas || this.memoryStore.getNPCAgendas();
        const authorDirection = this.memoryStore.getAuthorDirection();
        const mc = this.memoryStore.getMainCharacter();
        const goals = this._collectActiveGoals();
        const recentBeats = this.memoryStore.getRecentBeats(10);
        const recentReflections = this.memoryStore.getRecentReflections(5);
        const presentCharacters = this._collectPresentCharacters();

        const systemPrompt = this._buildSystemPrompt(lang);
        const userPrompt = this._buildUserPrompt({
            existingPlan,
            npcAgendas: activeNPCAgendas,
            presentCharacters,
            authorDirection,
            mc,
            goals,
            recentBeats,
            recentReflections,
            recentMessages,
            sceneType,
            currentTurn,
            lang,
        });

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        this._abortController = new AbortController();
        const signal = this._abortController.signal;

        try {
            const response = await this.apiClient.chatCompletion(
                messages,
                signal,
                modelOverride,
                { temperature: 0.6 },
            );
            const parsed = this._parseJSON(response);
            if (!parsed || typeof parsed !== 'object') {
                if (settings.debugMode) {
                    console.debug('[RP Memory] PlotDirector: unparseable response');
                }
                return null;
            }

            const newPlan = {
                arcBeats: Array.isArray(parsed.arcBeats) ? parsed.arcBeats : [],
                pacingSignal: typeof parsed.pacingSignal === 'string' ? parsed.pacingSignal : 'advance',
                sceneAssessment: typeof parsed.sceneAssessment === 'string' ? parsed.sceneAssessment : '',
                lastUpdatedTurn: currentTurn,
            };

            this.memoryStore.setDirectorPlan(newPlan);
            this.memoryStore.setLastDirectorTurn(currentTurn);

            if (settings.debugMode) {
                const saved = this.memoryStore.getDirectorPlan();
                console.debug('[RP Memory] PlotDirector updated:', {
                    arcBeats: saved.arcBeats.length,
                    pacingSignal: saved.pacingSignal,
                    sceneAssessment: saved.sceneAssessment,
                });
            }

            return this.memoryStore.getDirectorPlan();
        } catch (err) {
            if (err?.name === 'AbortError') {
                console.debug('[RP Memory] PlotDirector aborted');
                return null;
            }
            console.warn('[RP Memory] PlotDirector failed:', err.message);
            return null;
        } finally {
            this._abortController = null;
        }
    }

    _collectActiveGoals() {
        const raw = this.memoryStore.getAllEntities('goals');
        const active = [];
        for (const goal of Object.values(raw)) {
            if (!goal || goal.tier === 3) continue;
            const status = unwrapField(goal.fields?.status);
            if (status === 'completed' || status === 'failed' || status === 'abandoned') continue;
            active.push(goal);
        }
        active.sort((a, b) => (b.importance || 0) - (a.importance || 0));
        return active.slice(0, 6);
    }

    _collectPresentCharacters() {
        const characters = this.memoryStore.getAllEntities('characters');
        const present = [];
        for (const ch of Object.values(characters)) {
            if (!ch || ch.tier === 3) continue;
            const isPresent = unwrapField(ch.fields?.present);
            if (isPresent === true || isPresent === 'true' || isPresent === 'yes') {
                present.push(ch);
            }
        }
        return present.slice(0, 8);
    }

    _buildSystemPrompt(lang) {
        if (lang === 'zh') {
            return `你是故事导演（Plot Director）。你的任务不是写对话，而是规划未来 3-5 步的叙事走向。

原则：
1. 用户输入是场景的"输入信号"之一，但不是故事的唯一驱动力。当用户输入缺乏方向时，NPC 的 agenda 和世界的逻辑应当推动故事前进。
2. 基于 NPC 的独立目标、既定剧情、未偿还的伏笔，提出 3-5 个"下一步应该发生的节拍" (arcBeats)。每个节拍是一个朝向目标的简短叙事意图。
3. 给出一个 pacingSignal:
   - "advance"：推进主线
   - "hold"：保持当前张力，深化角色/情境
   - "complicate"：引入新的复杂因素（伏笔回收、新冲突、NPC 转向）
4. 不要直接写出要发生的对话；只写"接下来应该发生什么"的叙事意图。
5. 可以复用"Author Direction"和既定 goals 作为长线约束，但短线节拍应由 NPC agenda 和故事逻辑决定。
6. 如果提供了既有 plan，允许修改/替换/延续，但总数保持在 3-5 个。

返回 JSON:
{
  "arcBeats": [
    { "text": "...", "participants": ["char-id-1"], "priority": 7, "status": "pending" }
  ],
  "pacingSignal": "advance" | "hold" | "complicate",
  "sceneAssessment": "一句话描述当前场景状态和下一步意图"
}`;
        }
        return `You are the Plot Director. Your job is NOT to write dialogue — it is to plan the next 3–5 narrative beats.

Principles:
1. User input is ONE signal feeding the scene, not the sole driver of the story. When user input is low-information or passive, NPC agendas and world logic should advance the plot.
2. Based on each NPC's independent agenda, established goals, and unresolved threads, propose 3–5 "arc beats" — short forward-looking narrative intents that the next few turns should move toward.
3. Pick a pacingSignal:
   - "advance": move the main line forward
   - "hold": maintain current tension, deepen character/situation
   - "complicate": introduce a new complication (pay off a planted hook, a fresh conflict, an NPC pivot)
4. DO NOT write dialogue or describe exact phrasing. Only write "what should happen next" as narrative intent.
5. Respect the "Author Direction" (long-range user-set direction) and active goals as constraints, but short-range beats are owned by NPC agendas and plot logic.
6. If an existing plan is provided, you MAY revise / replace / carry forward, but total count stays 3–5.
7. A beat "hit" this round should be marked status=hit in the revision. Abandoned/obsolete beats → status=abandoned. New = pending. Currently-unfolding = active.

Return JSON:
{
  "arcBeats": [
    { "text": "...", "participants": ["char-id-1", "char-id-2"], "priority": 7, "status": "pending" }
  ],
  "pacingSignal": "advance" | "hold" | "complicate",
  "sceneAssessment": "one-line status of the scene and the short-horizon intent"
}

Keep each arcBeat text ≤ 30 words. "participants" uses character IDs from the roster.`;
    }

    _buildUserPrompt(ctx) {
        const {
            existingPlan, npcAgendas, presentCharacters, authorDirection, mc, goals,
            recentBeats, recentReflections, recentMessages, sceneType, currentTurn, lang,
        } = ctx;

        const lines = [];
        lines.push(`Current story turn: ${currentTurn}`);
        if (sceneType) lines.push(`Scene type: ${sceneType}`);
        lines.push('');

        if (authorDirection?.text) {
            lines.push('=== Author Direction (user-set, long-range constraint) ===');
            if (authorDirection.label) lines.push(`Label: ${authorDirection.label}`);
            lines.push(authorDirection.text);
            lines.push('');
        }

        if (mc) {
            const mcName = mc.name || 'MC';
            const mcLocation = unwrapField(mc.fields?.currentLocation);
            const mcConditions = unwrapField(mc.fields?.conditions);
            lines.push(`=== Main Character: ${mcName} ===`);
            if (mcLocation) lines.push(`Location: ${mcLocation}`);
            if (mcConditions) lines.push(`Conditions: ${mcConditions}`);
            lines.push('');
        }

        if (presentCharacters.length > 0) {
            lines.push('=== Present NPCs (id — name) ===');
            for (const ch of presentCharacters) {
                lines.push(`  ${ch.id} — ${ch.name}`);
            }
            lines.push('');
        }

        const agendaEntries = Object.entries(npcAgendas || {});
        if (agendaEntries.length > 0) {
            lines.push('=== NPC agendas (each NPC\'s own intent, independent of user input) ===');
            for (const [charId, agenda] of agendaEntries) {
                const character = this.memoryStore.getEntity('characters', charId);
                const name = character?.name || charId;
                lines.push(`  [${charId}] ${name}`);
                if (agenda.agenda) lines.push(`    agenda: ${agenda.agenda}`);
                if (agenda.innerState) lines.push(`    innerState: ${agenda.innerState}`);
                if (agenda.lastObservation) lines.push(`    noticed: ${agenda.lastObservation}`);
            }
            lines.push('');
        }

        if (goals.length > 0) {
            lines.push('=== Active Goals (long-range) ===');
            for (const goal of goals) {
                const desc = unwrapField(goal.fields?.description);
                const progress = unwrapField(goal.fields?.progress);
                lines.push(`  [${goal.id}] ${goal.name}: ${desc || 'no description'}`);
                if (progress) lines.push(`    progress: ${progress}`);
            }
            lines.push('');
        }

        if (recentBeats.length > 0) {
            lines.push('=== Recent Beats (most recent first) ===');
            for (const beat of recentBeats.slice(0, 10)) {
                lines.push(`  T${beat.storyTurn} [${beat.type || 'beat'}] ${beat.text}`);
            }
            lines.push('');
        }

        if (recentReflections.length > 0) {
            lines.push('=== Recent Reflections (plot threads already surfaced) ===');
            for (const ref of recentReflections.slice(0, 5)) {
                lines.push(`  [${ref.type || 'obs'}] ${ref.text}`);
            }
            lines.push('');
        }

        if (existingPlan && existingPlan.arcBeats && existingPlan.arcBeats.length > 0) {
            lines.push(`=== Existing Plan (last updated turn ${existingPlan.lastUpdatedTurn}) ===`);
            lines.push(`Previous pacingSignal: ${existingPlan.pacingSignal}`);
            if (existingPlan.sceneAssessment) lines.push(`Previous assessment: ${existingPlan.sceneAssessment}`);
            lines.push('Previous arcBeats (revise status + carry forward or replace):');
            for (const beat of existingPlan.arcBeats) {
                const parts = beat.participants?.length ? ` @[${beat.participants.join(',')}]` : '';
                lines.push(`  [${beat.id}] (p${beat.priority}, ${beat.status})${parts} — ${beat.text}`);
            }
            lines.push('');
        }

        if (recentMessages && recentMessages.length > 0) {
            lines.push('=== Recent Conversation (last few turns) ===');
            for (const msg of recentMessages.slice(-6)) {
                const speaker = msg.speaker || (msg.isUser ? 'User' : 'Assistant');
                const text = (msg.text || '').slice(0, 400);
                lines.push(`  ${speaker}: ${text}`);
            }
            lines.push('');
        }

        lines.push(lang === 'zh'
            ? '请给出修订后的 arcBeats 计划 (3-5 条)、pacingSignal 和 sceneAssessment。'
            : 'Produce the revised arcBeats plan (3–5 items), pacingSignal, and sceneAssessment as JSON.');

        return lines.join('\n');
    }

    _parseJSON(responseText) {
        let cleaned = (responseText || '').trim();
        if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
        else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
        if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
        cleaned = cleaned.trim();
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            if (this.getSettings().debugMode) {
                console.debug('[RP Memory] PlotDirector parse failed:', e.message, 'raw:', responseText);
            }
            return null;
        }
    }
}
