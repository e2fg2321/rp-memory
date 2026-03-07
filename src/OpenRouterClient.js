export class OpenRouterClient {
    constructor(getSettings) {
        this.getSettings = getSettings;
        this.baseUrl = 'https://openrouter.ai/api/v1';
        this._keyResolver = null;
    }

    /**
     * Set an async function that returns the API key.
     * When set, this is used instead of getSettings().apiKey.
     */
    setKeyResolver(fn) {
        this._keyResolver = fn;
    }

    /**
     * Resolve the API key — uses the key resolver if set, otherwise falls back to settings.
     */
    async resolveKey() {
        if (this._keyResolver) {
            return await this._keyResolver();
        }
        return this.getSettings().apiKey;
    }

    /**
     * Send a chat completion request to OpenRouter.
     * Returns the content string from the first choice.
     * @param {Array} messages - Chat messages
     * @param {AbortSignal} [signal] - Optional abort signal to cancel the request
     * @param {string} [modelOverride] - Optional model ID to use instead of settings.model
     * @param {object} [opts] - Optional overrides: { temperature }
     */
    async chatCompletion(messages, signal = null, modelOverride = null, opts = {}) {
        const settings = this.getSettings();
        const apiKey = await this.resolveKey();

        if (!apiKey) {
            throw new Error('OpenRouter API key not configured');
        }

        const body = {
            model: modelOverride || settings.model,
            messages,
            temperature: opts.temperature ?? 0.1,
            max_tokens: 2048,
            response_format: { type: 'json_object' },
        };

        let lastError = null;

        for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
            try {
                const response = await fetch(`${this.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                        'HTTP-Referer': 'https://sillytavern.app',
                        'X-Title': 'RP Memory Extension',
                    },
                    body: JSON.stringify(body),
                    signal,
                });

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    const errMsg = errData.error?.message || response.statusText;

                    if (response.status === 429) {
                        const retryAfter = parseInt(response.headers.get('retry-after') || '5');
                        console.warn(`[RP Memory] Rate limited, retrying after ${retryAfter}s`);
                        await this._sleep(retryAfter * 1000);
                        continue;
                    }

                    const err = new Error(`OpenRouter API error (${response.status}): ${errMsg}`);
                    // Don't retry deterministic client errors — auth, bad request, not found, etc.
                    // 429 is handled above; other 4xx that aren't transient should not retry
                    if ([400, 401, 403, 404].includes(response.status)) {
                        err._noRetry = true;
                    }
                    throw err;
                }

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content;
                const finishReason = data.choices?.[0]?.finish_reason;

                if (!content) {
                    // Content filter false positives are common — allow retry
                    throw new Error(
                        finishReason === 'content_filter'
                            ? 'Content filtered by model provider'
                            : 'Empty response from OpenRouter',
                    );
                }

                return content;
            } catch (error) {
                // Abort errors and non-retryable errors propagate immediately
                if (error.name === 'AbortError' || error._noRetry) {
                    throw error;
                }
                lastError = error;
                if (attempt < settings.maxRetries) {
                    const backoff = Math.pow(2, attempt) * 1000;
                    console.warn(`[RP Memory] Attempt ${attempt + 1} failed, retrying in ${backoff}ms:`, error.message);
                    await this._sleep(backoff);
                }
            }
        }

        throw lastError;
    }

    /**
     * Send an embedding request to OpenRouter.
     * Automatically chunks large batches to stay within API limits.
     * @param {string[]} texts - Array of texts to embed
     * @param {string} model - Embedding model ID
     * @returns {Promise<number[][]>} Array of embedding vectors
     */
    async embedText(texts, model) {
        const apiKey = await this.resolveKey();

        if (!apiKey) {
            throw new Error('OpenRouter API key not configured');
        }

        const BATCH_SIZE = 96;

        if (texts.length <= BATCH_SIZE) {
            return await this._embedBatch(texts, model, apiKey);
        }

        // Chunk into batches
        const allEmbeddings = [];
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const batch = texts.slice(i, i + BATCH_SIZE);
            const embeddings = await this._embedBatch(batch, model, apiKey);
            allEmbeddings.push(...embeddings);
        }
        return allEmbeddings;
    }

    async _embedBatch(texts, model, apiKey) {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://sillytavern.app',
                'X-Title': 'RP Memory Extension',
            },
            body: JSON.stringify({ model, input: texts }),
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            const errMsg = errData.error?.message || response.statusText;
            throw new Error(`OpenRouter embeddings error (${response.status}): ${errMsg}`);
        }

        const data = await response.json();
        return data.data.map(d => d.embedding);
    }

    /**
     * Test connectivity with a minimal request.
     */
    async testConnection() {
        const response = await this.chatCompletion([
            { role: 'user', content: 'Respond with exactly: {"status":"ok"}' },
        ]);
        const parsed = JSON.parse(response);
        return parsed.status === 'ok';
    }

    /**
     * Fetch available models from OpenRouter's public /models endpoint.
     * Filters to text-output models, sorted by prompt price (cheapest first).
     */
    async fetchModels() {
        const response = await fetch(`${this.baseUrl}/models`, {
            headers: {
                'HTTP-Referer': 'https://sillytavern.app',
                'X-Title': 'RP Memory Extension',
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.status}`);
        }

        const data = await response.json();

        return data.data
            .filter(m => m.architecture?.output_modalities?.includes('text'))
            .sort((a, b) => {
                const aPrice = parseFloat(a.pricing?.prompt || '999');
                const bPrice = parseFloat(b.pricing?.prompt || '999');
                return aPrice - bPrice;
            })
            .map(m => ({
                id: m.id,
                name: m.name,
                promptPrice: m.pricing?.prompt,
                completionPrice: m.pricing?.completion,
                contextLength: m.context_length,
            }));
    }

    /**
     * Fetch available embedding models from OpenRouter.
     * The /embeddings/models endpoint requires auth, so try it first,
     * fall back to a hardcoded list of known models.
     */
    async fetchEmbeddingModels() {
        // Try the authenticated endpoint first
        if (this.apiKey) {
            try {
                const response = await fetch(`${this.baseUrl}/embeddings/models`, {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'HTTP-Referer': 'https://sillytavern.app',
                        'X-Title': 'RP Memory Extension',
                    },
                });

                if (response.ok) {
                    const data = await response.json();
                    if (data.data?.length > 0) {
                        return data.data
                            .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
                            .map(m => ({
                                id: m.id,
                                name: m.name || m.id,
                                promptPrice: m.pricing?.prompt,
                                contextLength: m.context_length,
                            }));
                    }
                }
            } catch (_) {
                // Fall through to hardcoded list
            }
        }

        // Fallback: known OpenRouter embedding models
        return [
            { id: 'cohere/embed-english-v3.0', name: 'Cohere: Embed English v3.0' },
            { id: 'cohere/embed-multilingual-v3.0', name: 'Cohere: Embed Multilingual v3.0' },
            { id: 'google/gemini-embedding-001', name: 'Google: Gemini Embedding 001' },
            { id: 'mistralai/mistral-embed-2312', name: 'Mistral: Embed' },
            { id: 'openai/text-embedding-3-large', name: 'OpenAI: Text Embedding 3 Large' },
            { id: 'openai/text-embedding-3-small', name: 'OpenAI: Text Embedding 3 Small' },
            { id: 'openai/text-embedding-ada-002', name: 'OpenAI: Text Embedding Ada 002' },
            { id: 'qwen/qwen3-embedding-8b', name: 'Qwen: Qwen3 Embedding 8B' },
        ];
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
