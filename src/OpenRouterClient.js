export class OpenRouterClient {
    constructor(getSettings) {
        this.getSettings = getSettings;
        this.baseUrl = 'https://openrouter.ai/api/v1';
    }

    /**
     * Send a chat completion request to OpenRouter.
     * Returns the content string from the first choice.
     */
    async chatCompletion(messages) {
        const settings = this.getSettings();
        const apiKey = settings.apiKey;

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
     * Test connectivity with a minimal request.
     */
    async testConnection() {
        const response = await this.chatCompletion([
            { role: 'user', content: 'Respond with exactly: {"status":"ok"}' },
        ]);
        const parsed = JSON.parse(response);
        return parsed.status === 'ok';
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
