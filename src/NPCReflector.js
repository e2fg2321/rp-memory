import { unwrapField } from './Utils.js';

/**
 * NPCReflector — per-NPC agenda + inner-state update pass.
 *
 * For each "present" NPC of sufficient importance, runs a single small LLM call
 * that answers: "what does this character want right now, what are they feeling,
 * and what's the most recent thing they noticed about the MC?"
 *
 * Output feeds the PlotDirector. Gives every active NPC an agenda independent of
 * user input, so the world can move when user input is low-info (the Stanford
 * generative-agents pattern, adapted to chat-shaped RP).
 */
export class NPCReflector {
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
     * Pick NPCs worth reflecting on: "present" field true, tier 1-2, not the MC.
     * Caps at maxAgents to keep cost bounded.
     */
    _selectActiveNPCs(maxAgents) {
        const characters = this.memoryStore.getAllEntities('characters');
        const candidates = [];

        for (const character of Object.values(characters)) {
            if (!character || character.tier === 3) continue;
            const present = unwrapField(character.fields?.present);
            const presentBool = present === true || present === 'true' || present === 'yes';
            if (!presentBool) continue;
            candidates.push(character);
        }

        candidates.sort((a, b) => (b.importance || 0) - (a.importance || 0));
        return candidates.slice(0, maxAgents);
    }

    /**
     * Run the reflector for all active NPCs. Returns a map { [characterId]: agendaObject }.
     * Failed individual calls are logged and skipped, never throw.
     */
    async reflect({ recentMessages = [], sceneType = null } = {}) {
        const settings = this.getSettings();
        const maxAgents = settings.directorMaxNPCs || 4;
        const activeNPCs = this._selectActiveNPCs(maxAgents);

        if (activeNPCs.length === 0) {
            if (settings.debugMode) {
                console.debug('[RP Memory] NPCReflector: no present NPCs to reflect on');
            }
            return {};
        }

        const modelOverride = settings.reflectorModel || settings.directorModel || null;
        const lang = this.getLang();
        const currentTurn = this.memoryStore.getTurnCounter();
        const mc = this.memoryStore.getMainCharacter();
        const mcName = mc?.name || 'the main character';

        this._abortController = new AbortController();
        const signal = this._abortController.signal;

        const results = {};

        try {
            const promises = activeNPCs.map(async (npc) => {
                try {
                    const agenda = await this._reflectOne(npc, {
                        mcName,
                        recentMessages,
                        sceneType,
                        lang,
                        currentTurn,
                        modelOverride,
                        signal,
                    });
                    if (agenda) {
                        results[npc.id] = agenda;
                    }
                } catch (err) {
                    if (err?.name === 'AbortError') throw err;
                    console.warn(`[RP Memory] NPCReflector failed for ${npc.name}:`, err.message);
                }
            });

            await Promise.all(promises);
        } catch (err) {
            if (err?.name !== 'AbortError') {
                console.warn('[RP Memory] NPCReflector aborted or failed:', err.message);
            }
        } finally {
            this._abortController = null;
        }

        return results;
    }

    async _reflectOne(npc, { mcName, recentMessages, sceneType, lang, currentTurn, modelOverride, signal }) {
        const existingAgenda = this.memoryStore.getNPCAgenda(npc.id);
        const systemPrompt = this._buildSystemPrompt(lang);
        const userPrompt = this._buildUserPrompt(npc, {
            mcName,
            recentMessages,
            sceneType,
            existingAgenda,
            currentTurn,
            lang,
        });

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        const response = await this.apiClient.chatCompletion(
            messages,
            signal,
            modelOverride,
            { temperature: 0.5 },
        );

        const parsed = this._parseJSON(response);
        if (!parsed || typeof parsed !== 'object') return null;

        return {
            agenda: typeof parsed.agenda === 'string' ? parsed.agenda : '',
            innerState: typeof parsed.innerState === 'string' ? parsed.innerState : '',
            lastObservation: typeof parsed.lastObservation === 'string' ? parsed.lastObservation : '',
            lastUpdatedTurn: currentTurn,
        };
    }

    _buildSystemPrompt(lang) {
        if (lang === 'zh') {
            return `你是一个叙事助手，专门为单个角色生成"内心状态快照"。
对指定角色，基于他们的人物设定、近期事件、以及与主角的互动，回答：
- agenda: 他们此刻最想做什么或追求什么（一句话，出自他们的目标/欲望，不是被动反应）
- innerState: 他们此刻的情绪/心理状态（一句话）
- lastObservation: 他们最近对主角注意到的一件关键事情（一句话）

注意：
- 这个角色有自己独立的目标，不只是响应主角。即使主角没有给出强输入，他们也会依据自己的 agenda 推动场景。
- 使用 JSON 格式返回: { "agenda": "...", "innerState": "...", "lastObservation": "..." }
- 每项不超过 40 字。`;
        }
        return `You are a narrative assistant that writes "inner-state snapshots" for individual characters.
For the given character, based on their personality/goals, recent events, and interactions with the main character, answer:
- agenda: what they most want to do or pursue right now (one sentence, driven by their own goals/desires, not passive reaction)
- innerState: their emotional / mental state right now (one sentence)
- lastObservation: one key thing they've recently noticed about the main character (one sentence)

Key principle: this character has independent goals. They will push the scene forward based on their OWN agenda, even when the user's input is low-information. Do not describe them as merely reacting to the protagonist.

Return JSON: { "agenda": "...", "innerState": "...", "lastObservation": "..." }
Each field ≤ 30 words.`;
    }

    _buildUserPrompt(npc, { mcName, recentMessages, sceneType, existingAgenda, currentTurn, lang }) {
        const lines = [];
        lines.push(`Character: ${npc.name}`);

        const fields = npc.fields || {};
        const personality = unwrapField(fields.personality);
        const mood = unwrapField(fields.mood);
        const status = unwrapField(fields.status);
        const relationships = unwrapField(fields.relationships);
        const goals = unwrapField(fields.goals);
        const backstory = unwrapField(fields.backstory);

        if (personality) lines.push(`Personality: ${personality}`);
        if (mood) lines.push(`Current mood: ${mood}`);
        if (status) lines.push(`Status: ${status}`);
        if (relationships) lines.push(`Relationships: ${relationships}`);
        if (goals) lines.push(`Established goals: ${goals}`);
        if (backstory) lines.push(`Backstory: ${backstory}`);

        if (existingAgenda?.agenda || existingAgenda?.innerState) {
            lines.push('');
            lines.push('Previous snapshot (update if warranted, otherwise refine):');
            if (existingAgenda.agenda) lines.push(`  prior agenda: ${existingAgenda.agenda}`);
            if (existingAgenda.innerState) lines.push(`  prior innerState: ${existingAgenda.innerState}`);
            if (existingAgenda.lastObservation) lines.push(`  prior lastObservation: ${existingAgenda.lastObservation}`);
        }

        if (sceneType) {
            lines.push('');
            lines.push(`Current scene type: ${sceneType}`);
        }

        if (recentMessages.length > 0) {
            lines.push('');
            lines.push(`Recent conversation (MC is "${mcName}"):`);
            for (const msg of recentMessages.slice(-6)) {
                const speaker = msg.speaker || (msg.isUser ? mcName : 'NPC');
                const text = (msg.text || '').slice(0, 280);
                lines.push(`  ${speaker}: ${text}`);
            }
        }

        lines.push('');
        lines.push(`Current story turn: ${currentTurn}`);
        lines.push('');
        lines.push(lang === 'zh'
            ? '以 JSON 返回此角色的最新内心状态快照。'
            : 'Return the updated inner-state JSON for this character.');

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
                console.debug('[RP Memory] NPCReflector parse failed:', e.message, 'raw:', responseText);
            }
            return null;
        }
    }
}
