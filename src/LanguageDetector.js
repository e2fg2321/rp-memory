/**
 * Detect chat language (CJK vs Latin) for prompt language selection.
 *
 * CJK character ratio threshold is 30% — even 30% CJK strongly indicates
 * Chinese (English RP with occasional Chinese names would be <5%).
 */
export class LanguageDetector {
    // Unicode ranges for CJK Unified Ideographs + common extensions
    static CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}]/gu;

    /**
     * Detect language from message texts by CJK character ratio.
     * @param {string[]} messageTexts - Array of message strings
     * @param {number} [threshold=0.3] - CJK ratio above which returns 'zh'
     * @returns {'en'|'zh'}
     */
    static detect(messageTexts, threshold = 0.3) {
        if (!messageTexts || messageTexts.length === 0) return 'en';

        const combined = messageTexts.join(' ');

        // Strip whitespace and punctuation for a cleaner character count
        const chars = combined.replace(/[\s\p{P}\p{S}\d]/gu, '');
        if (chars.length === 0) return 'en';

        const cjkMatches = chars.match(this.CJK_REGEX);
        const cjkCount = cjkMatches ? cjkMatches.length : 0;
        const ratio = cjkCount / chars.length;

        return ratio >= threshold ? 'zh' : 'en';
    }

    /**
     * Resolve prompt language from user setting + auto-detection fallback.
     * @param {string} settingValue - 'auto' | 'en' | 'zh'
     * @param {string[]} messageTexts - Recent message texts for auto-detection
     * @returns {'en'|'zh'}
     */
    static resolve(settingValue, messageTexts) {
        if (settingValue === 'en' || settingValue === 'zh') {
            return settingValue;
        }
        // 'auto' or any unexpected value → detect from messages
        return this.detect(messageTexts);
    }
}
