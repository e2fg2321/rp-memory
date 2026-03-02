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
     */
    async chatCompletion(messages) {
        const settings = this.getSettings();
        const apiKey = await this.resolveKey();

        if (!apiKey) {
            throw new Error('OpenRouter API key not configured');
        }

        const body = {
            model: settings.model,
            messages,
            temperature: 0.1,
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

                    throw new Error(`OpenRouter API error (${response.status}): ${errMsg}`);
                }

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content;

                if (!content) {
                    throw new Error('Empty response from OpenRouter');
                }

                return content;
            } catch (error) {
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
     * @param {string[]} texts - Array of texts to embed
     * @param {string} model - Embedding model ID
     * @returns {Promise<number[][]>} Array of embedding vectors
     */
    async embedText(texts, model) {
        const apiKey = await this.resolveKey();

        if (!apiKey) {
            throw new Error('OpenRouter API key not configured');
        }

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
     * Filters to models with modality:embedding architecture.
     */
    async fetchEmbeddingModels() {
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
            .filter(m => {
                const modalities = m.architecture?.output_modalities || [];
                return modalities.includes('embedding') || modalities.includes('embeddings');
            })
            .sort((a, b) => {
                const aPrice = parseFloat(a.pricing?.prompt || '999');
                const bPrice = parseFloat(b.pricing?.prompt || '999');
                return aPrice - bPrice;
            })
            .map(m => ({
                id: m.id,
                name: m.name,
                promptPrice: m.pricing?.prompt,
                contextLength: m.context_length,
            }));
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
