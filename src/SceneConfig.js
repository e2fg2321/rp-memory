/**
 * Scene-aware field-selective memory injection configuration.
 * Pure data module — no dependencies, no logic.
 */

/**
 * Short keyword-rich strings representing each scene type.
 * Embedded once and compared against the context embedding via cosine similarity.
 */
export const SCENE_ANCHORS = {
    combat:   'fighting battle attack defend sword wound blood dodge strike kill combat weapon',
    social:   'conversation talk persuade negotiate flirt argue trust emotion relationship feelings',
    explore:  'travel arrive discover enter look around search investigate new place journey move',
    plot:     'reveal betray plan secret mission quest objective clue mystery conspiracy scheme',
    downtime: 'rest shop craft heal train camp prepare sleep recover trade buy sell',
};

/**
 * Chinese scene anchors — selected based on detected language.
 */
export const SCENE_ANCHORS_ZH = {
    combat:   '战斗 攻击 防御 剑 伤口 鲜血 闪避 打击 杀 武器 格斗 魔法攻击',
    social:   '对话 交谈 说服 谈判 调情 争吵 信任 情感 关系 感情 聊天',
    explore:  '旅行 到达 发现 进入 观察 搜索 调查 新地方 旅程 移动 探索',
    plot:     '揭露 背叛 计划 秘密 任务 目标 线索 谜团 阴谋 诡计 真相',
    downtime: '休息 商店 制作 治疗 训练 营地 准备 睡觉 恢复 交易 买卖',
};

/**
 * Per category, per scene type: ordered list of fields from most to least relevant.
 * Fields not listed are excluded for that scene type.
 */
export const FIELD_RELEVANCE = {
    characters: {
        combat:   ['status', 'mood', 'description'],
        social:   ['personality', 'mood', 'relationships', 'status'],
        explore:  ['description', 'mood', 'status'],
        plot:     ['relationships', 'mood', 'status', 'personality'],
        downtime: ['description', 'personality', 'mood', 'relationships'],
    },
    locations: {
        combat:   ['notableFeatures', 'description'],
        social:   ['atmosphere', 'description'],
        explore:  ['description', 'atmosphere', 'notableFeatures', 'connections'],
        plot:     ['connections', 'notableFeatures', 'description'],
        downtime: ['atmosphere', 'notableFeatures', 'description'],
    },
    mainCharacter: {
        combat:   ['health', 'conditions', 'buffs', 'inventory', 'skills', 'currentLocation'],
        social:   ['description', 'conditions', 'currentLocation', 'currentTime'],
        explore:  ['inventory', 'currentLocation', 'currentTime', 'health', 'skills'],
        plot:     ['currentLocation', 'currentTime', 'conditions', 'inventory'],
        downtime: ['health', 'conditions', 'buffs', 'inventory', 'skills', 'currentLocation', 'currentTime'],
    },
    goals: {
        combat:   ['status', 'description'],
        social:   ['description', 'progress', 'blockers'],
        explore:  ['description', 'progress'],
        plot:     ['description', 'progress', 'blockers', 'status'],
        downtime: ['description', 'progress', 'blockers', 'status'],
    },
    events: {
        combat:   ['description', 'consequences'],
        social:   ['description', 'involvedEntities', 'consequences'],
        explore:  ['description', 'involvedEntities'],
        plot:     ['description', 'consequences', 'significance', 'involvedEntities'],
        downtime: ['description', 'consequences'],
    },
};

/**
 * How many fields to show based on entity relevance score.
 * score >= full   → all relevant fields for scene type
 * score >= medium → top 2 fields
 * below medium    → top 1 field (the "one-liner")
 */
export const DETAIL_THRESHOLDS = {
    full:   0.6,
    medium: 0.4,
};
