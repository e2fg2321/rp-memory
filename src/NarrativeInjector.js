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
        open: '[RP Memory — Director]\n(Forward-looking narrative guidance. Weight: stronger than world-state reference, but may yield to explicit user redirection.)',
        close: '[/RP Memory Director]',
        principle: 'Narrative principle: this story is NOT driven solely by user input. NPCs have independent agendas. When user input is low-information, advance the scene via NPC agendas and the plan below rather than mirroring the user.',
        pacingAdvance: 'Pacing: ADVANCE — push the main line forward this turn.',
        pacingHold: 'Pacing: HOLD — maintain tension, deepen the current moment without shifting the arc.',
        pacingComplicate: 'Pacing: COMPLICATE — introduce a new complication this turn (pay off a planted hook, a fresh conflict, or an NPC pivot).',
        sceneAssessment: 'Scene assessment',
        arcBeats: 'Next-few-turns arc (prioritized):',
        npcAgendas: 'NPC inner states (each character acts on their own agenda):',
        agenda: 'wants',
        innerState: 'feels',
        observation: 'noticed',
        statusPending: 'pending',
        statusActive: 'active',
        statusHit: 'hit',
        statusAbandoned: 'abandoned',
    },
    zh: {
        open: '[RP Memory — 导演]\n(前瞻性叙事指引。权重：强于世界状态参考，但可因用户显式指引而调整。)',
        close: '[/RP Memory Director]',
        principle: '叙事原则：本故事不仅由用户输入驱动。NPC 有独立的 agenda。当用户输入信息量较低时，应依据 NPC agenda 和下面的计划推进场景，而不是仅仅回应用户。',
        pacingAdvance: '节奏：推进 — 本轮推动主线前进。',
        pacingHold: '节奏：保持 — 维持当前张力，深化当下情境，不转移主线。',
        pacingComplicate: '节奏：复杂化 — 本轮引入新的复杂因素（伏笔回收、新冲突、NPC 转向）。',
        sceneAssessment: '场景评估',
        arcBeats: '未来几轮的剧情走向（按优先级）:',
        npcAgendas: 'NPC 内心状态（每个角色依据自己的 agenda 行动）:',
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
        lines.push(L.principle);
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
