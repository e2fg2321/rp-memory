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
 * Per category, per scene type: ordered list of fields from most to least relevant.
 * Fields not listed are excluded for that scene type.
 */
export const FIELD_RELEVANCE = {
    characters: {
        combat:   ['status', 'present', 'description'],
        social:   ['personality', 'relationships', 'present', 'status'],
        explore:  ['description', 'present', 'status'],
        plot:     ['relationships', 'status', 'present', 'personality'],
        downtime: ['description', 'personality', 'relationships'],
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
