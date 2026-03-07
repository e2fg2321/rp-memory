/**
 * Generate a kebab-case ID from a display name.
 * e.g. "Kira Nightshade" -> "kira-nightshade"
 */
export function generateId(name) {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        || `entity-${Date.now()}`;
}

/**
 * Rough token estimate, adjusted for CJK text.
 * English: ~4 chars/token. CJK: ~1.5 chars/token.
 * Uses a weighted average based on CJK character ratio.
 */
export function estimateTokens(text) {
    if (!text) return 0;
    const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const nonCjkCount = text.length - cjkCount;
    return Math.ceil(nonCjkCount / 4 + cjkCount / 1.5);
}

/**
 * Deep clone a plain object via JSON roundtrip.
 */
export function deepClone(obj) {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Unwrap a field value that may be a provenance object or a plain string.
 * Provenance objects have the shape { value, sourceTurns, lastUpdated }.
 */
export function unwrapField(field) {
    if (field && typeof field === 'object' && 'value' in field) return field.value;
    return field ?? '';
}

/**
 * Wrap a plain value into a provenance object.
 */
export function wrapField(value, turn) {
    return { value: String(value), sourceTurns: [turn], lastUpdated: turn };
}

/**
 * Update an existing provenance-wrapped field with a new value,
 * appending the source turn. Keeps last 5 source turns.
 */
export function updateFieldProvenance(existing, newValue, turn) {
    if (existing && typeof existing === 'object' && 'value' in existing) {
        const turns = [...(existing.sourceTurns || []), turn].slice(-5);
        return { value: String(newValue), sourceTurns: turns, lastUpdated: turn };
    }
    return wrapField(newValue, turn);
}

function normalizeChangeValue(value) {
    const unwrapped = unwrapField(value);
    if (unwrapped === null || unwrapped === undefined) return '';

    if (Array.isArray(unwrapped)) {
        return unwrapped.map((item) => {
            if (item === null || item === undefined) return '';
            if (typeof item === 'object') return JSON.stringify(item);
            return String(item);
        }).filter(Boolean).join(', ');
    }

    if (typeof unwrapped === 'object') {
        return JSON.stringify(unwrapped);
    }

    return String(unwrapped);
}

function pushChangeDetail(details, kind, field, oldValue, newValue) {
    const before = oldValue ?? '';
    const after = newValue ?? '';
    if (before === after) return;
    details.push({ kind, field, oldValue: before, newValue: after });
}

/**
 * Diff the user-visible parts of an entity snapshot.
 * Ignores bookkeeping fields such as timestamps, source, and conflicts.
 */
export function diffEntitySnapshots(before, after) {
    const details = [];

    pushChangeDetail(details, 'meta', 'name', before?.name || '', after?.name || '');
    pushChangeDetail(
        details,
        'meta',
        'aliases',
        (before?.aliases || []).join(', '),
        (after?.aliases || []).join(', '),
    );
    pushChangeDetail(
        details,
        'meta',
        'tier',
        before?.tier === undefined ? '' : String(before.tier),
        after?.tier === undefined ? '' : String(after.tier),
    );
    pushChangeDetail(
        details,
        'meta',
        'importance',
        before?.importance === undefined ? '' : String(before.importance),
        after?.importance === undefined ? '' : String(after.importance),
    );

    const fieldKeys = new Set([
        ...Object.keys(before?.fields || {}),
        ...Object.keys(after?.fields || {}),
    ]);

    for (const field of fieldKeys) {
        pushChangeDetail(
            details,
            'field',
            field,
            normalizeChangeValue(before?.fields?.[field]),
            normalizeChangeValue(after?.fields?.[field]),
        );
    }

    return details;
}

/**
 * Create an empty entity with default fields for a given category.
 */
export function createEmptyEntity(category, name, turn = 0) {
    const id = generateId(name);
    const base = {
        id,
        name,
        aliases: [],
        tier: 2,
        importance: 5,
        baseScore: 5,
        lastMentionedTurn: turn,
        createdTurn: turn,
        conflicts: [],
        source: 'manual',
    };

    switch (category) {
        case 'characters':
            base.fields = {
                description: '',
                personality: '',
                mood: '',
                status: '',
                relationships: '',
                backstory: '',
                speechPatterns: '',
                history: '',
                goals: '',
            };
            break;
        case 'locations':
            base.fields = {
                description: '',
                atmosphere: '',
                notableFeatures: '',
                connections: '',
            };
            break;
        case 'mainCharacter':
            base.tier = 1;
            base.importance = 10;
            base.baseScore = 10;
            base.fields = {
                description: '',
                skills: '',
                inventory: '',
                health: '',
                conditions: '',
                buffs: '',
            };
            break;
        case 'goals':
            base.fields = {
                description: '',
                progress: '',
                blockers: '',
                status: 'in_progress',
                timeframe: 'short_term',
            };
            break;
        case 'events':
            base.fields = {
                description: '',
                turn: turn,
                involvedEntities: '',
                consequences: '',
                significance: '',
            };
            break;
        default:
            base.fields = {};
    }

    return base;
}
