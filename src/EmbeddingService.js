import { SCENE_ANCHORS } from './SceneConfig.js';
import { unwrapField } from './Utils.js';

export class EmbeddingService {
    constructor(apiClient, getSettings) {
        this.apiClient = apiClient;
        this.getSettings = getSettings;
        this._cache = new Map(); // key = "category:entityId" → number[]
        this._beatCache = new Map(); // key = beatId → number[]
        this._contextCache = null; // { hash, embedding }
        this._sceneAnchors = null; // Map<string, number[]> — scene type → embedding
    }

    /**
     * Embed an array of texts using the configured embedding model.
     * @param {string[]} texts
     * @returns {Promise<number[][]>}
     */
    async embedTexts(texts) {
        const model = this.getSettings().embeddingModel;
        return await this.apiClient.embedText(texts, model);
    }

    /**
     * Get the embedding for an entity, using cache when available.
     */
    async getEntityEmbedding(category, entity) {
        const cacheKey = `${category}:${entity.id}`;
        if (this._cache.has(cacheKey)) {
            return this._cache.get(cacheKey);
        }

        const text = this.buildEntityText(category, entity);
        const [embedding] = await this.embedTexts([text]);
        this._cache.set(cacheKey, embedding);
        return embedding;
    }

    /**
     * Get the embedding for recent chat context.
     */
    async getContextEmbedding(messages) {
        const hash = messages.length + ':' + messages.join('|').slice(-200);
        if (this._contextCache && this._contextCache.hash === hash) {
            return this._contextCache.embedding;
        }

        const text = messages.join('\n');
        const [embedding] = await this.embedTexts([text]);
        this._contextCache = { hash, embedding };
        return embedding;
    }

    /**
     * Ensure scene anchor embeddings are cached.
     */
    async _ensureSceneAnchors() {
        if (this._sceneAnchors) return;

        const types = Object.keys(SCENE_ANCHORS);
        const texts = types.map(t => SCENE_ANCHORS[t]);
        const embeddings = await this.embedTexts(texts);

        this._sceneAnchors = new Map();
        for (let i = 0; i < types.length; i++) {
            this._sceneAnchors.set(types[i], embeddings[i]);
        }
    }

    /**
     * Detect the current scene type by comparing a context embedding
     * against cached scene anchor embeddings.
     */
    detectSceneType(contextEmbedding) {
        if (!this._sceneAnchors) {
            return { type: 'downtime', scores: {} };
        }

        const scores = {};
        let bestType = 'downtime';
        let bestScore = -Infinity;

        for (const [type, anchorEmb] of this._sceneAnchors.entries()) {
            const score = this.cosineSimilarity(contextEmbedding, anchorEmb);
            scores[type] = score;
            if (score > bestScore) {
                bestScore = score;
                bestType = type;
            }
        }

        return { type: bestType, scores };
    }

    /**
     * Tri-score: weighted combination of recency, importance, and relevance.
     */
    _triScore(entity, cosineSim, currentTurn) {
        const turnsSince = currentTurn - (entity.lastMentionedTurn || entity.createdTurn || 0);
        const recency = 1 / (1 + turnsSince * 0.1);
        const importance = (entity.importance || 5) / 10;
        const relevance = cosineSim;
        return 0.25 * recency + 0.25 * importance + 0.5 * relevance;
    }

    /**
     * Rank ALL entities (all tiers) by tri-score against recent messages.
     * Also detects the current scene type using the same context embedding.
     * @param {object} memoryStore
     * @param {string[]} recentMessages
     * @param {number} currentTurn - Current story turn for recency scoring
     * @returns {Promise<{ranked, sceneType}>}
     */
    async rankEntities(memoryStore, recentMessages, currentTurn = 0) {
        const contextEmbedding = await this.getContextEmbedding(recentMessages);

        await this._ensureSceneAnchors();
        const sceneInfo = this.detectSceneType(contextEmbedding);

        const categories = ['mainCharacter', 'characters', 'locations', 'goals', 'events'];
        const entitiesToRank = [];

        for (const category of categories) {
            // Include ALL entities (all tiers), not just Tier 1-2
            const allEntities = memoryStore.getAllEntities(category);
            for (const entity of Object.values(allEntities)) {
                entitiesToRank.push({ category, entity });
            }
        }

        if (entitiesToRank.length === 0) {
            return { ranked: [], sceneType: sceneInfo.type };
        }

        // Batch-compute any missing embeddings
        const missingIndices = [];
        const missingTexts = [];
        for (let i = 0; i < entitiesToRank.length; i++) {
            const { category, entity } = entitiesToRank[i];
            const cacheKey = `${category}:${entity.id}`;
            if (!this._cache.has(cacheKey)) {
                missingIndices.push(i);
                missingTexts.push(this.buildEntityText(category, entity));
            }
        }

        if (missingTexts.length > 0) {
            const embeddings = await this.embedTexts(missingTexts);
            for (let j = 0; j < missingIndices.length; j++) {
                const idx = missingIndices[j];
                const { category, entity } = entitiesToRank[idx];
                const cacheKey = `${category}:${entity.id}`;
                this._cache.set(cacheKey, embeddings[j]);
            }
        }

        // Score each entity using tri-score
        const ranked = [];
        for (const { category, entity } of entitiesToRank) {
            const cacheKey = `${category}:${entity.id}`;
            const entityEmbedding = this._cache.get(cacheKey);
            const cosineSim = this.cosineSimilarity(contextEmbedding, entityEmbedding);
            const score = this._triScore(entity, cosineSim, currentTurn);
            ranked.push({ category, entity, score });
        }

        // Sort by score descending
        ranked.sort((a, b) => b.score - a.score);
        return { ranked, sceneType: sceneInfo.type };
    }

    /**
     * Rank beats by tri-score against recent messages.
     * @param {object} memoryStore
     * @param {string[]} recentMessages
     * @param {number} currentTurn
     * @returns {Promise<Array<{beat, score}>>}
     */
    async rankBeats(memoryStore, recentMessages, currentTurn = 0) {
        const beats = memoryStore.getBeats();
        if (beats.length === 0) return [];

        const contextEmbedding = await this.getContextEmbedding(recentMessages);

        // Batch-compute any missing beat embeddings
        const missingIndices = [];
        const missingTexts = [];
        for (let i = 0; i < beats.length; i++) {
            const beat = beats[i];
            if (!this._beatCache.has(beat.id)) {
                missingIndices.push(i);
                missingTexts.push(beat.text);
            }
        }

        if (missingTexts.length > 0) {
            const embeddings = await this.embedTexts(missingTexts);
            for (let j = 0; j < missingIndices.length; j++) {
                const idx = missingIndices[j];
                this._beatCache.set(beats[idx].id, embeddings[j]);
            }
        }

        // Score each beat
        const ranked = [];
        for (const beat of beats) {
            const beatEmbedding = this._beatCache.get(beat.id);
            const cosineSim = this.cosineSimilarity(contextEmbedding, beatEmbedding);

            const turnsSince = currentTurn - (beat.storyTurn || 0);
            const recency = 1 / (1 + turnsSince * 0.1);
            const importance = (beat.importance || 5) / 10;
            const score = 0.25 * recency + 0.25 * importance + 0.5 * cosineSim;

            ranked.push({ beat, score });
        }

        ranked.sort((a, b) => b.score - a.score);
        return ranked;
    }

    /**
     * Build a natural-language text summary of an entity for embedding.
     * Handles provenance-wrapped fields by unwrapping them.
     */
    buildEntityText(category, entity) {
        const parts = [];
        const categoryLabels = {
            mainCharacter: 'Main Character',
            characters: 'Character',
            locations: 'Location',
            goals: 'Goal',
            events: 'Event',
        };

        parts.push(`${categoryLabels[category] || category}: ${entity.name}.`);

        if (entity.fields) {
            for (const [key, value] of Object.entries(entity.fields)) {
                if (value === null || value === undefined || value === '') continue;

                // Unwrap provenance objects
                const plainValue = unwrapField(value);
                if (!plainValue || plainValue === '') continue;

                const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');

                if (Array.isArray(plainValue)) {
                    if (plainValue.length === 0) continue;
                    if (typeof plainValue[0] === 'object' && plainValue[0] !== null) {
                        const formatted = plainValue.map(v => {
                            if (v.target && v.nature) return `${v.target} (${v.nature})`;
                            return JSON.stringify(v);
                        }).join(', ');
                        parts.push(`${label}: ${formatted}.`);
                    } else {
                        parts.push(`${label}: ${plainValue.join(', ')}.`);
                    }
                } else if (typeof plainValue === 'object') {
                    for (const [subKey, subVal] of Object.entries(plainValue)) {
                        if (!subVal || (Array.isArray(subVal) && subVal.length === 0)) continue;
                        const subLabel = subKey.charAt(0).toUpperCase() + subKey.slice(1);
                        const displayVal = Array.isArray(subVal) ? subVal.join(', ') : String(subVal);
                        parts.push(`${subLabel}: ${displayVal}.`);
                    }
                } else {
                    parts.push(`${label}: ${plainValue}.`);
                }
            }
        }

        return parts.join(' ');
    }

    /**
     * Compute cosine similarity between two vectors.
     */
    cosineSimilarity(a, b) {
        if (!a || !b || a.length !== b.length) return 0;

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        if (denominator === 0) return 0;

        return dotProduct / denominator;
    }

    /**
     * Invalidate the cached embedding for a specific entity.
     */
    invalidateEntity(category, entityId) {
        const cacheKey = `${category}:${entityId}`;
        this._cache.delete(cacheKey);
    }

    /**
     * Invalidate a cached beat embedding.
     */
    invalidateBeat(beatId) {
        this._beatCache.delete(beatId);
    }

    /**
     * Clear all cached embeddings.
     */
    clearCache() {
        this._cache.clear();
        this._beatCache.clear();
        this._contextCache = null;
        this._sceneAnchors = null;
    }

    /**
     * Serialize entity embeddings and scene anchors for persistence.
     */
    serialize() {
        const embeddings = {};
        for (const [key, vec] of this._cache.entries()) {
            embeddings[key] = vec;
        }

        const result = {
            model: this.getSettings().embeddingModel,
            embeddings,
        };

        // Persist beat embeddings
        if (this._beatCache.size > 0) {
            const beatEmbeddings = {};
            for (const [key, vec] of this._beatCache.entries()) {
                beatEmbeddings[key] = vec;
            }
            result.beatEmbeddings = beatEmbeddings;
        }

        if (this._sceneAnchors) {
            const sceneAnchors = {};
            for (const [type, vec] of this._sceneAnchors.entries()) {
                sceneAnchors[type] = vec;
            }
            result.sceneAnchors = sceneAnchors;
        }

        return result;
    }

    /**
     * Load persisted embeddings.
     */
    load(savedState) {
        this._cache.clear();
        this._beatCache.clear();
        this._contextCache = null;
        this._sceneAnchors = null;

        if (!savedState || !savedState.embeddings) return;

        const currentModel = this.getSettings().embeddingModel;
        if (savedState.model && savedState.model !== currentModel) {
            console.debug('[RP Memory] Embedding model changed, discarding persisted embeddings');
            return;
        }

        for (const [key, vec] of Object.entries(savedState.embeddings)) {
            this._cache.set(key, vec);
        }

        // Restore beat embeddings
        if (savedState.beatEmbeddings) {
            for (const [key, vec] of Object.entries(savedState.beatEmbeddings)) {
                this._beatCache.set(key, vec);
            }
            console.debug(`[RP Memory] Loaded ${this._beatCache.size} persisted beat embeddings`);
        }

        if (savedState.sceneAnchors) {
            this._sceneAnchors = new Map();
            for (const [type, vec] of Object.entries(savedState.sceneAnchors)) {
                this._sceneAnchors.set(type, vec);
            }
            console.debug(`[RP Memory] Loaded ${this._sceneAnchors.size} persisted scene anchors`);
        }

        console.debug(`[RP Memory] Loaded ${this._cache.size} persisted embeddings`);
    }
}
