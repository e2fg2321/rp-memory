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
 * Rough token estimate (1 token ≈ 4 chars for English text).
 * Not exact, but good enough for budget warnings.
 */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
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
