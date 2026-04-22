import { estimateTokens } from './Utils.js';

/**
 * NarrativeInjector — formats the director's forward-looking plan + NPC agendas
 * into a prompt block for the main chat model.
 *
 * Separate from PromptInjector (which handles passive world-state memory). This one
 * uses stronger framing — the director block is an instruction-ish layer telling the
 * model how the story should progress, not just what's in the world.
 *
 * Returned string is injected via setExtensionPrompt under a distinct key so it
 * composes cleanly with the existing world-state injection.
 */
const LABELS = {
    en: {
        open: '[RP Memory — DIRECTOR — HIGH PRIORITY]\nThis block is AUTHORIAL DIRECTION for your next response. Apply it, do not merely consider it. It has higher priority than the descriptive world-state block. Only defer when the user\'s most recent message is an explicit redirection (direct action, OOC correction, or high-information narrative steer) — in which case incorporate the redirection AND then resume the plan below.',
        instructions: [
            'HOW TO APPLY THIS BLOCK:',
            '1. Pick ONE active arcBeat below (highest priority that fits this moment) and meaningfully advance it in your next response. Do not gesture at all of them — pick one and move it forward concretely.',
            '2. Every present NPC must speak and act from THEIR OWN agenda (listed below), not as a passive reaction to the user. Even short / low-information user input (e.g. "okay", "I look around", "...") is NOT an instruction to echo — it is an invitation for NPCs to pursue what they want.',
            '3. Do NOT summarize, restate, or mirror the user\'s last message back to them. If the user\'s input is minimal, the scene still advances via NPC agendas and the arc.',
            '4. Apply the pacing signal strictly (see below).',
            '5. Render NPC inner state through dialogue, action, and subtle behaviour — do not narrate their feelings out loud as exposition unless it\'s consistent with the narrative voice.',
        ].join('\n'),
        pacingAdvance: 'PACING: ADVANCE — this turn must push the main line forward. Resolve an ambiguity, escalate a conflict, have an NPC make a decision, or close a beat. Do not write a purely reactive / holding-pattern response.',
        pacingHold: 'PACING: HOLD — this turn stays in this moment. Deepen emotion, interiority, sensory detail, or subtext. Do NOT introduce new plot developments; make the present moment denser.',
        pacingComplicate: 'PACING: COMPLICATE — this turn must introduce a new complication. Pay off a planted hook, surface a new conflict, have an NPC pivot against expectation, or escalate stakes. Something changes this turn that wasn\'t true last turn.',
        sceneAssessment: 'Scene assessment',
        arcBeats: 'ACTIVE ARC BEATS — pick ONE to advance this turn (priority-weighted):',
        npcAgendas: 'NPC inner states — each NPC acts from THEIR OWN agenda, not as a reaction to the user:',
        close: '[/RP Memory Director]',
        agenda: 'wants',
        innerState: 'feels',
        observation: 'noticed',
        statusPending: 'pending',
        statusActive: 'active',
        statusHit: 'hit',
        statusAbandoned: 'abandoned',
    },
    zh: {
        open: '[RP Memory — 导演 — 高优先级]\n本区块是本轮回复的"作者指令"（AUTHORIAL DIRECTION）。要应用它，不只是参考它。其优先级高于世界状态描述区块。仅当用户最新消息是明确的方向调整（直接行动、OOC 修正、或高信息量的剧情引导）时，才允许偏离——此时先吸收用户调整，再回到下方计划。',
        instructions: [
            '如何应用本区块：',
            '1. 从下方"活跃弧线节拍"中挑选 ONE 个（优先级高且贴合当下者），在本回合切实推进它。不要敷衍所有节拍——挑一个具体推进。',
            '2. 每个在场 NPC 必须依据他们自己的 agenda（见下）发声、行动，而非被动回应用户。即便用户输入很短或低信息（例如"好"、"我看看四周"、"……"），那也不是复述回去的指令——是让 NPC 推进自己想要的事情。',
            '3. 不要复述、改写、或镜像用户的上一条消息。当用户输入稀薄时，场景仍需依靠 NPC agenda 和弧线推进。',
            '4. 严格按下方的节奏信号执行。',
            '5. 将 NPC 的内心状态通过对话、行动、微表情体现，而不是直接作为旁白说出来（除非叙事语气本身就允许）。',
        ].join('\n'),
        pacingAdvance: '节奏：推进 —— 本回合必须推动主线前进。解决一个悬念、升级一个冲突、让 NPC 做出决定、或结束一个节拍。不要写纯反应 / 保持原地不动的回复。',
        pacingHold: '节奏：保持 —— 本回合停留在当下。深化情感、内心、感官细节或潜台词。不要引入新的剧情进展；让当下这一刻更有密度。',
        pacingComplicate: '节奏：复杂化 —— 本回合必须引入一个新的复杂因素。回收一个伏笔、浮出一个新冲突、让 NPC 违反预期地转向、或抬升赌注。本回合结束时有一件新的"上一回合不成立"的事情发生。',
        sceneAssessment: '场景评估',
        arcBeats: '活跃弧线节拍 —— 本回合挑 ONE 个推进（按优先级）：',
        npcAgendas: 'NPC 内心状态 —— 每个 NPC 都依据自己的 agenda 行动，不是用户的反应机：',
        close: '[/RP Memory 导演]',
        agenda: '想要',
        innerState: '感受',
        observation: '注意到',
        statusPending: '待推进',
        statusActive: '进行中',
        statusHit: '已达成',
        statusAbandoned: '已弃',
    },
};

export class NarrativeInjector {
    constructor(getSettings, getLang) {
        this.getSettings = getSettings;
        this.getLang = getLang || (() => 'en');
    }

    /**
     * Build the prompt text to inject. Returns empty string when there's nothing
     * meaningful to inject (no plan and no agendas), which caller can use to clear.
     */
    format(memoryStore) {
        const plan = memoryStore.getDirectorPlan();
        const agendas = memoryStore.getNPCAgendas();

        const hasPlan = plan && Array.isArray(plan.arcBeats) && plan.arcBeats.length > 0;
        const hasAgendas = Object.keys(agendas).length > 0;
        if (!hasPlan && !hasAgendas) return '';

        const lang = this.getLang();
        const L = LABELS[lang] || LABELS.en;
        const lines = [];

        lines.push(L.open);
        lines.push('');
        lines.push(L.instructions);
        lines.push('');

        if (hasPlan) {
            if (plan.sceneAssessment) {
                lines.push(`${L.sceneAssessment}: ${plan.sceneAssessment}`);
                lines.push('');
            }

            const pacingLine =
                plan.pacingSignal === 'hold' ? L.pacingHold
                    : plan.pacingSignal === 'complicate' ? L.pacingComplicate
                        : L.pacingAdvance;
            lines.push(pacingLine);
            lines.push('');

            lines.push(L.arcBeats);
            const active = plan.arcBeats
                .filter(b => b.status !== 'hit' && b.status !== 'abandoned')
                .sort((a, b) => (b.priority || 0) - (a.priority || 0));

            for (const beat of active) {
                const statusLabel = {
                    pending: L.statusPending,
                    active: L.statusActive,
                    hit: L.statusHit,
                    abandoned: L.statusAbandoned,
                }[beat.status] || L.statusPending;
                const participantNames = this._resolveParticipantNames(memoryStore, beat.participants);
                const whoStr = participantNames.length > 0 ? ` (${participantNames.join(', ')})` : '';
                lines.push(`  • [p${beat.priority || 5} · ${statusLabel}]${whoStr} ${beat.text}`);
            }
            lines.push('');
        }

        if (hasAgendas) {
            lines.push(L.npcAgendas);
            for (const [charId, agenda] of Object.entries(agendas)) {
                const character = memoryStore.getEntity('characters', charId);
                const name = character?.name || charId;
                const parts = [];
                if (agenda.agenda) parts.push(`${L.agenda}: ${agenda.agenda}`);
                if (agenda.innerState) parts.push(`${L.innerState}: ${agenda.innerState}`);
                if (agenda.lastObservation) parts.push(`${L.observation}: ${agenda.lastObservation}`);
                if (parts.length === 0) continue;
                lines.push(`  • ${name} — ${parts.join(' · ')}`);
            }
            lines.push('');
        }

        lines.push(L.close);
        return lines.join('\n');
    }

    _resolveParticipantNames(memoryStore, participants) {
        if (!Array.isArray(participants) || participants.length === 0) return [];
        const names = [];
        for (const pid of participants) {
            if (typeof pid !== 'string') continue;
            const ch = memoryStore.getEntity('characters', pid);
            if (ch?.name) {
                names.push(ch.name);
            } else if (pid === 'main-character' || pid === 'mc') {
                const mc = memoryStore.getMainCharacter();
                if (mc?.name) names.push(mc.name);
            } else {
                // Unknown id — render the id itself so the director's intent is still legible
                names.push(pid);
            }
        }
        return names;
    }

    estimateTokens(memoryStore) {
        const text = this.format(memoryStore);
        return estimateTokens(text);
    }
}
