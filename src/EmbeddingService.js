export class EmbeddingService {
    constructor(apiClient, getSettings) {
        this.apiClient = apiClient;
        this.getSettings = getSettings;
        this._cache = new Map(); // key = "category:entityId" → number[]
        this._contextCache = null; // { hash, embedding }
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
     * @param {string} category
     * @param {object} entity
     * @returns {Promise<number[]>}
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
     * Context embeddings are never persisted — they change every exchange.
     * @param {string[]} messages - Array of recent message strings
     * @returns {Promise<number[]>}
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
     * Rank all tier 1-2 entities by relevance to recent messages.
     * @param {object} memoryStore
     * @param {string[]} recentMessages
     * @returns {Promise<Array<{category: string, entity: object, score: number}>>}
     */
    async rankEntities(memoryStore, recentMessages) {
        const contextEmbedding = await this.getContextEmbedding(recentMessages);

        const categories = ['mainCharacter', 'characters', 'locations', 'goals', 'events'];
        const entitiesToRank = [];

        for (const category of categories) {
            const entities = memoryStore.getEntitiesByTier(category, [1, 2]);
            for (const entity of entities) {
                entitiesToRank.push({ category, entity });
            }
        }

        if (entitiesToRank.length === 0) {
            return [];
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

        // Score each entity
        const ranked = [];
        for (const { category, entity } of entitiesToRank) {
            const cacheKey = `${category}:${entity.id}`;
            const entityEmbedding = this._cache.get(cacheKey);
            const score = this.cosineSimilarity(contextEmbedding, entityEmbedding);
            ranked.push({ category, entity, score });
        }

        // Sort by score descending
        ranked.sort((a, b) => b.score - a.score);
        return ranked;
    }

    /**
     * Build a natural-language text summary of an entity for embedding.
     * @param {string} category
     * @param {object} entity
     * @returns {string}
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

                const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');

                if (Array.isArray(value)) {
                    if (value.length === 0) continue;
                    if (typeof value[0] === 'object' && value[0] !== null) {
                        // Relationship array
                        const formatted = value.map(v => {
                            if (v.target && v.nature) return `${v.target} (${v.nature})`;
                            return JSON.stringify(v);
                        }).join(', ');
                        parts.push(`${label}: ${formatted}.`);
                    } else {
                        parts.push(`${label}: ${value.join(', ')}.`);
                    }
                } else if (typeof value === 'object') {
                    // Nested object (e.g., status for mainCharacter)
                    for (const [subKey, subVal] of Object.entries(value)) {
                        if (!subVal || (Array.isArray(subVal) && subVal.length === 0)) continue;
                        const subLabel = subKey.charAt(0).toUpperCase() + subKey.slice(1);
                        const displayVal = Array.isArray(subVal) ? subVal.join(', ') : String(subVal);
                        parts.push(`${subLabel}: ${displayVal}.`);
                    }
                } else {
                    parts.push(`${label}: ${value}.`);
                }
            }
        }

        return parts.join(' ');
    }

    /**
     * Compute cosine similarity between two vectors.
     * @param {number[]} a
     * @param {number[]} b
     * @returns {number}
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
     * Call this when an entity's fields change.
     * @param {string} category
     * @param {string} entityId
     */
    invalidateEntity(category, entityId) {
        const cacheKey = `${category}:${entityId}`;
        this._cache.delete(cacheKey);
    }

    /**
     * Clear all cached embeddings (entity + context).
     */
    clearCache() {
        this._cache.clear();
        this._contextCache = null;
    }

    /**
     * Serialize entity embeddings for persistence.
     * Context embeddings are NOT persisted (they change every exchange).
     * Stores the embedding model so we can detect model changes.
     * @returns {object} { model, embeddings: { "category:entityId": number[] } }
     */
    serialize() {
        const embeddings = {};
        for (const [key, vec] of this._cache.entries()) {
            embeddings[key] = vec;
        }
        return {
            model: this.getSettings().embeddingModel,
            embeddings,
        };
    }

    /**
     * Load persisted entity embeddings.
     * If the saved model doesn't match the current setting, discard all
     * (embeddings from a different model are meaningless).
     * @param {object|null} savedState - Output of serialize(), or null
     */
    load(savedState) {
        this._cache.clear();
        this._contextCache = null;

        if (!savedState || !savedState.embeddings) return;

        // Model mismatch → embeddings are stale, discard
        const currentModel = this.getSettings().embeddingModel;
        if (savedState.model && savedState.model !== currentModel) {
            console.debug('[RP Memory] Embedding model changed, discarding persisted embeddings');
            return;
        }

        for (const [key, vec] of Object.entries(savedState.embeddings)) {
            this._cache.set(key, vec);
        }

        console.debug(`[RP Memory] Loaded ${this._cache.size} persisted embeddings`);
    }
}
