import { eventSource, event_types, extension_prompt_types, extension_prompt_roles,
    getMaxContextSize, saveSettingsDebounced, setExtensionPrompt } from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync,
    saveMetadataDebounced } from '../../../extensions.js';
import { Popup, POPUP_RESULT } from '../../../popup.js';
import { SECRET_KEYS, secret_state, findSecret } from '../../../secrets.js';
import { getCurrentLocale } from '../../../i18n.js';
import { MemoryStore } from './src/MemoryStore.js';
import { PromptInjector } from './src/PromptInjector.js';
import { ExtractionPipeline } from './src/ExtractionPipeline.js';
import { DecayEngine } from './src/DecayEngine.js';
import { OpenRouterClient } from './src/OpenRouterClient.js';
import { EmbeddingService } from './src/EmbeddingService.js';
import { LanguageDetector } from './src/LanguageDetector.js';
import { ReflectionEngine } from './src/ReflectionEngine.js';
import { GoalsManager } from './src/GoalsManager.js';
import { RawTurnRanker } from './src/RawTurnRanker.js';
import { createEmptyEntity, diffEntitySnapshots, estimateTokens, unwrapField, wrapField } from './src/Utils.js';

const MODULE_NAME = 'rp_memory';
const EXTENSION_KEY = 'rp_memory';

const defaultSettings = {
    enabled: true,
    apiKey: '',
    useSTKey: false,
    model: 'google/gemini-2.0-flash-001',
    extractionInterval: 2,
    decayFactor: 0.95,
    demotionThreshold: 5.0,
    tokenBudget: 0,
    injectionPosition: extension_prompt_types.IN_PROMPT,
    injectionDepth: 2,
    injectionRole: extension_prompt_roles.SYSTEM,
    userMessageWeight: 'high',
    messagesPerExtraction: 5,
    manualExtractionExchanges: 0,
    maxRetries: 2,
    debugMode: true,
    embeddingsEnabled: false,
    embeddingModel: 'openai/text-embedding-3-small',
    episodicMemoryMode: 'beats',
    rawTurnCompactionEnabled: true,
    chatHistoryReserveTokens: 0,
    language: 'auto',
    reflectionEnabled: true,
    reflectionThreshold: 30,
    maxBeats: 200,
    maxReflections: 30,
    beatBudgetPercent: 25,
    reflectionBudgetPercent: 15,
    beatContextRadius: 2,
    goalsIntentEnabled: false,
    goalsIntentModel: '',
    goalsIntentAsync: false,
};

// Singletons
let memoryStore = null;
let injector = null;
let apiClient = null;
let pipeline = null;
let decayEngine = null;
let embeddingService = null;
let rawTurnRanker = null;
let reflectionEngine = null;
let goalsManager = null;
let lastProcessedLength = 0;
let cachedModelList = null;
let cachedEmbeddingModelList = null;
let cachedSTKey = null; // Cached SillyTavern API key for the session
let activePanelCategory = null; // Currently shown category in floating data panel
let extensionLocaleData = null; // Our own locale data (loaded from locales/*.json)
const directionNudgeDismissals = new Map(); // chatId -> dismissed turn

// ===================== Translation (own layer) =====================

/**
 * Resolve the UI language. For 'auto', follows SillyTavern's browser locale.
 * For explicit 'en'/'zh', uses that directly.
 */
function getUILanguage() {
    const lang = getSettings().language;
    if (lang === 'en' || lang === 'zh') return lang;
    // auto: check ST locale
    const stLocale = getCurrentLocale();
    if (stLocale && stLocale.startsWith('zh')) return 'zh';
    return 'en';
}

/**
 * Tagged template translation: tt`Hello ${name}`
 * Builds key like "Hello ${0}", looks up in our locale data, replaces placeholders.
 */
function tt(strings, ...values) {
    const key = strings.reduce((result, string, i) =>
        result + string + (values[i] !== undefined ? `\${${i}}` : ''), '');
    if (getUILanguage() === 'en' || !extensionLocaleData) {
        return key.replace(/\$\{(\d+)\}/g, (_, index) => values[index]);
    }
    const translated = extensionLocaleData[key] || key;
    return translated.replace(/\$\{(\d+)\}/g, (_, index) => values[index]);
}

/**
 * Simple key lookup translation: tl('Pinned') → '置顶'
 */
function tl(key) {
    if (getUILanguage() === 'en' || !extensionLocaleData) return key;
    return extensionLocaleData[key] || key;
}

/**
 * Apply our own locale to data-i18n elements within #rp_memory_settings and .rp-mem-wrapper.
 */
function applyOwnLocale() {
    const roots = ['#rp_memory_settings', '.rp-mem-wrapper'];
    for (const sel of roots) {
        $(sel).find('[data-i18n]').each(function () {
            const key = $(this).attr('data-i18n');
            if (!key) return;

            if (key.startsWith('[title]')) {
                $(this).attr('title', tl(key.slice(7)));
            } else if (key.startsWith('[placeholder]')) {
                $(this).attr('placeholder', tl(key.slice(13)));
            } else {
                // Preserve child elements (like <b>, <span>) — only replace text if no HTML children
                if (this.children.length === 0) {
                    $(this).text(tl(key));
                }
            }
        });
    }
}

// ===================== Settings =====================

function initSettings() {
    if (!extension_settings[EXTENSION_KEY]) {
        extension_settings[EXTENSION_KEY] = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[EXTENSION_KEY][key] === undefined) {
            extension_settings[EXTENSION_KEY][key] = value;
        }
    }
    // Migrate old promptLanguage → language
    if (extension_settings[EXTENSION_KEY].promptLanguage !== undefined) {
        extension_settings[EXTENSION_KEY].language = extension_settings[EXTENSION_KEY].promptLanguage;
        delete extension_settings[EXTENSION_KEY].promptLanguage;
    }
}

function getSettings() {
    return extension_settings[EXTENSION_KEY];
}

function isRawTurnRetrievalMode() {
    return getSettings().episodicMemoryMode === 'raw_turns_experimental';
}

function getEffectiveMemoryBudget() {
    const s = getSettings();
    const configuredBudget = Number(s.tokenBudget) > 0 ? Number(s.tokenBudget) : Infinity;
    const chatReserve = Math.max(0, parseInt(s.chatHistoryReserveTokens, 10) || 0);
    let effectiveBudget = configuredBudget;
    let isCapped = Number.isFinite(configuredBudget);
    let reserveApplied = false;
    let stPromptBudget = null;

    if (chatReserve > 0) {
        try {
            const stBudget = Number(getMaxContextSize?.());
            if (Number.isFinite(stBudget) && stBudget > 0) {
                stPromptBudget = Math.floor(stBudget);
                const reserveLimitedBudget = Math.max(0, Math.floor(stBudget - chatReserve));
                effectiveBudget = Math.min(effectiveBudget, reserveLimitedBudget);
                isCapped = true;
                reserveApplied = true;
            }
        } catch (err) {
            console.debug('[RP Memory] Failed to read ST prompt budget for chat reserve:', err?.message || err);
        }
    }

    return {
        totalBudget: isCapped ? Math.max(0, Math.floor(effectiveBudget)) : Infinity,
        isCapped,
        configuredBudget: Number.isFinite(configuredBudget) ? Math.floor(configuredBudget) : 0,
        chatReserve,
        reserveApplied,
        stPromptBudget,
    };
}

function getEffectiveEpisodicBudget(totalBudget) {
    if (!Number.isFinite(totalBudget)) return Infinity;
    if (totalBudget <= 0) return 0;

    const s = getSettings();
    const beatBudgetPercent = s.beatBudgetPercent || 25;
    const reflectionBudgetPercent = s.reflectionBudgetPercent || 15;
    const totalPercent = beatBudgetPercent + reflectionBudgetPercent;
    const combinedPercent = Math.min(totalPercent, 60);
    const adjustedReflectionPercent = totalPercent > 60
        ? Math.floor(reflectionBudgetPercent * 60 / totalPercent)
        : reflectionBudgetPercent;
    const adjustedBeatPercent = totalPercent > 60
        ? 60 - adjustedReflectionPercent
        : combinedPercent - adjustedReflectionPercent;

    return Math.max(0, Math.floor(totalBudget * adjustedBeatPercent / 100));
}

/**
 * Resolve the API key. If useSTKey is enabled, tries to use SillyTavern's
 * OpenRouter key (cached for the session). Otherwise uses the extension's own key.
 */
async function resolveApiKey() {
    const s = getSettings();
    if (s.useSTKey) {
        // Check if ST has an OpenRouter key configured
        if (!secret_state[SECRET_KEYS.OPENROUTER]) {
            return null;
        }
        // Return cached key if available
        if (cachedSTKey) {
            return cachedSTKey;
        }
        // Fetch the actual key via findSecret (requires allowKeysExposure)
        const key = await findSecret(SECRET_KEYS.OPENROUTER);
        if (key) {
            cachedSTKey = key;
        }
        return key;
    }
    return s.apiKey;
}

/**
 * Update the ST key status indicator in the UI.
 */
function updateSTKeyStatus() {
    const s = getSettings();
    const $status = $('#rp_memory_st_key_status');

    if (!s.useSTKey) {
        $status.hide();
        return;
    }

    $status.show();

    if (!secret_state[SECRET_KEYS.OPENROUTER]) {
        $status.text(tt`No OpenRouter key found — configure in ST API settings`)
            .removeClass('rp-mem-key-ok').addClass('rp-mem-key-error');
        return;
    }

    // Key exists in ST — try to resolve it
    resolveApiKey().then(key => {
        if (key) {
            $status.text(tt`Key available from SillyTavern`)
                .removeClass('rp-mem-key-error').addClass('rp-mem-key-ok');
        } else {
            $status.text(tt`Enable "allowKeysExposure" in config.yaml, or enter key manually`)
                .removeClass('rp-mem-key-ok').addClass('rp-mem-key-error');
        }
    });
}

function syncUIFromSettings() {
    const s = getSettings();
    $('#rp_memory_enabled').prop('checked', s.enabled);
    $('#rp_memory_use_st_key').prop('checked', s.useSTKey);
    $('#rp_memory_api_key').val(s.apiKey);
    $('#rp_memory_api_key_container').toggle(!s.useSTKey);
    updateSTKeyStatus();
    $('#rp_memory_model').val(s.model);
    $('#rp_memory_model_search').val(s.model);
    $('#rp_memory_interval').val(s.extractionInterval);
    $('#rp_memory_interval_val').text(s.extractionInterval);
    $('#rp_memory_msg_count').val(s.messagesPerExtraction);
    $('#rp_memory_msg_count_val').text(s.messagesPerExtraction);
    $('#rp_memory_decay').val(s.decayFactor);
    $('#rp_memory_decay_val').text(s.decayFactor);
    $('#rp_memory_demote').val(s.demotionThreshold);
    $('#rp_memory_demote_val').text(s.demotionThreshold);
    $('#rp_memory_budget').val(s.tokenBudget);
    $('#rp_memory_budget_val').text(s.tokenBudget);
    $(`input[name="rp_memory_position"][value="${s.injectionPosition}"]`).prop('checked', true);
    $('#rp_memory_depth').val(s.injectionDepth);
    $('#rp_memory_depth_container').toggle(s.injectionPosition === extension_prompt_types.IN_CHAT);
    $('#rp_memory_extract_depth').val(s.manualExtractionExchanges);
    $('#rp_memory_debug').prop('checked', s.debugMode);
    $('#rp_memory_embeddings_enabled').prop('checked', s.embeddingsEnabled);
    $('#rp_memory_embedding_model_container').toggle(s.embeddingsEnabled);
    $('#rp_memory_embedding_model').val(s.embeddingModel);
    $('#rp_memory_episodic_mode').val(s.episodicMemoryMode);
    $('#rp_memory_chat_history_reserve_tokens').val(s.chatHistoryReserveTokens);
    $('#rp_memory_raw_turn_compaction_enabled').prop('checked', s.rawTurnCompactionEnabled);
    $('#rp_memory_raw_turn_compaction_container').toggle(s.episodicMemoryMode === 'raw_turns_experimental');
    $('#rp_memory_goals_intent_enabled').prop('checked', s.goalsIntentEnabled);
    $('#rp_memory_goals_intent_model_container').toggle(s.goalsIntentEnabled);
    $('#rp_memory_goals_intent_async').prop('checked', s.goalsIntentAsync);
    $('#rp_memory_goals_intent_model').val(s.goalsIntentModel);
    $('#rp_memory_language').val(s.language);
}

function bindSettingsListeners() {
    $('#rp_memory_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
        injectMemoryPrompt();
    });

    $('#rp_memory_use_st_key').on('change', function () {
        const checked = $(this).prop('checked');
        getSettings().useSTKey = checked;
        $('#rp_memory_api_key_container').toggle(!checked);
        cachedSTKey = null; // Clear cached key on toggle
        updateSTKeyStatus();
        saveSettingsDebounced();
    });

    $('#rp_memory_api_key').on('input', function () {
        getSettings().apiKey = $(this).val();
        saveSettingsDebounced();
    });

    // Model selection is handled by the searchable model picker (see bindModelPicker)

    // Range sliders
    const rangeMap = {
        'rp_memory_interval': { key: 'extractionInterval', display: 'rp_memory_interval_val' },
        'rp_memory_msg_count': { key: 'messagesPerExtraction', display: 'rp_memory_msg_count_val' },
        'rp_memory_decay': { key: 'decayFactor', display: 'rp_memory_decay_val', parse: parseFloat },
        'rp_memory_demote': { key: 'demotionThreshold', display: 'rp_memory_demote_val', parse: parseFloat },
        'rp_memory_budget': { key: 'tokenBudget', display: 'rp_memory_budget_val' },
    };

    for (const [id, config] of Object.entries(rangeMap)) {
        $(`#${id}`).on('input', function () {
            const parse = config.parse || parseInt;
            const val = parse($(this).val());
            getSettings()[config.key] = val;
            $(`#${config.display}`).text(val);
            saveSettingsDebounced();
            if (config.key === 'tokenBudget') {
                injectMemoryPrompt();
            }
        });
    }

    // Injection position
    $('input[name="rp_memory_position"]').on('change', function () {
        const val = parseInt($(this).val());
        getSettings().injectionPosition = val;
        $('#rp_memory_depth_container').toggle(val === extension_prompt_types.IN_CHAT);
        saveSettingsDebounced();
        injectMemoryPrompt();
    });

    $('#rp_memory_depth').on('input', function () {
        getSettings().injectionDepth = parseInt($(this).val()) || 0;
        saveSettingsDebounced();
        injectMemoryPrompt();
    });

    $('#rp_memory_debug').on('change', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#rp_memory_download_log').on('click', downloadLog);

    // Embeddings toggle
    $('#rp_memory_embeddings_enabled').on('change', function () {
        const checked = $(this).prop('checked');
        getSettings().embeddingsEnabled = checked;
        $('#rp_memory_embedding_model_container').toggle(checked);
        saveSettingsDebounced();
        if (checked) {
            loadEmbeddingModelList();
        }
    });

    // Embedding model selection
    $('#rp_memory_embedding_model').on('change', function () {
        getSettings().embeddingModel = $(this).val();
        // Clear embedding cache when model changes
        if (embeddingService) {
            embeddingService.clearCache();
        }
        saveSettingsDebounced();
    });

    $('#rp_memory_episodic_mode').on('change', function () {
        getSettings().episodicMemoryMode = $(this).val() || 'beats';
        $('#rp_memory_raw_turn_compaction_container').toggle(getSettings().episodicMemoryMode === 'raw_turns_experimental');
        saveSettingsDebounced();
        injectMemoryPrompt();
    });

    $('#rp_memory_chat_history_reserve_tokens').on('input', function () {
        getSettings().chatHistoryReserveTokens = Math.max(0, parseInt($(this).val(), 10) || 0);
        saveSettingsDebounced();
        injectMemoryPrompt();
    });

    $('#rp_memory_raw_turn_compaction_enabled').on('change', function () {
        getSettings().rawTurnCompactionEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        injectMemoryPrompt();
    });

    // Refresh embedding models button
    $('#rp_memory_refresh_embedding_models').on('click', () => loadEmbeddingModelList(true));

    // Goals intent toggle
    $('#rp_memory_goals_intent_enabled').on('change', function () {
        const checked = $(this).prop('checked');
        getSettings().goalsIntentEnabled = checked;
        $('#rp_memory_goals_intent_model_container').toggle(checked);
        saveSettingsDebounced();
        if (checked) {
            populateGoalsIntentModelDropdown();
        }
    });

    // Goals intent async toggle
    $('#rp_memory_goals_intent_async').on('change', function () {
        getSettings().goalsIntentAsync = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Goals intent model selection
    $('#rp_memory_goals_intent_model').on('change', function () {
        getSettings().goalsIntentModel = $(this).val();
        saveSettingsDebounced();
    });

    // Language
    $('#rp_memory_language').on('change', function () {
        getSettings().language = $(this).val();
        saveSettingsDebounced();
        applyOwnLocale();
        renderMemoryUI();
        injectMemoryPrompt();
    });

    // Manual extraction depth
    $('#rp_memory_extract_depth').on('input', function () {
        getSettings().manualExtractionExchanges = parseInt($(this).val()) || 0;
        saveSettingsDebounced();
    });

    // Test connection
    $('#rp_memory_test_connection').on('click', testConnection);

    // Open floating panel
    $('#rp_memory_open_panel').on('click', () => {
        // Ensure floating UI exists
        if (!$('.rp-mem-wrapper').length) initFloatingUI();
        // Expand nav if collapsed
        const $nav = $('.rp-mem-nav');
        if ($nav.hasClass('collapsed')) $nav.removeClass('collapsed');
        // Show first category that has entities, or mainCharacter by default
        const counts = memoryStore ? memoryStore.getCounts() : {};
        const firstPopulated = ['mainCharacter', 'characters', 'locations', 'goals', 'events']
            .find(key => (counts[key] || 0) > 0);
        showCategoryPanel(firstPopulated || 'mainCharacter');
        // Close the sidebar so user can see the floating panel
        const $sidebar = $('#extensions_settings2');
        if ($sidebar.is(':visible')) {
            $('#extensionsMenuButton').trigger('click');
        }
    });

    // Force extract
    $('#rp_memory_force_extract').on('click', forceExtract);

    // Clear all
    $('#rp_memory_clear_all').on('click', clearAllMemory);

    // Refresh models button
    $('#rp_memory_refresh_models').on('click', () => loadModelList(true));

    // Reload model list when API key changes (debounced)
    let modelLoadTimer = null;
    $('#rp_memory_api_key').on('input', function () {
        clearTimeout(modelLoadTimer);
        modelLoadTimer = setTimeout(() => loadModelList(true), 1000);
    });
}

// ===================== Tab Navigation =====================

function bindTabListeners() {
    $('.rp-mem-tab').on('click', function () {
        const tab = $(this).data('tab');
        $('.rp-mem-tab').removeClass('active');
        $(this).addClass('active');
        $('.rp-mem-tab-content').hide();
        $(`#rp_memory_tab_${tab}`).show();
    });
}

// ===================== Category Toggle =====================

function bindCategoryListeners() {
    $(document).on('click', '.rp-mem-category-header', function (e) {
        // Don't toggle if clicking the add button
        if ($(e.target).closest('.rp-mem-add-btn').length) return;
        const body = $(this).closest('.rp-mem-category').find('.rp-mem-category-body');
        body.toggleClass('open');
    });

    // Add entity buttons
    $(document).on('click', '.rp-mem-add-btn', function () {
        const category = $(this).data('category');
        openAddEntityDialog(category);
    });

    // Entity header click (expand/collapse fields) — skip if in edit mode
    $(document).on('click', '.rp-mem-entity-header', function (e) {
        if ($(e.target).closest('.rp-mem-entity-actions').length) return;
        if ($(this).closest('.rp-mem-editing').length) return;
        $(this).siblings('.rp-mem-entity-fields').toggle();
    });

    // Edit button — inline edit mode
    $(document).on('click', '.rp-mem-edit-btn', function (e) {
        e.stopPropagation();
        const card = $(this).closest('.rp-mem-entity');
        enterEditMode(card.data('category'), card.data('id'));
    });

    // Save button (inline edit)
    $(document).on('click', '.rp-mem-save-btn', function (e) {
        e.stopPropagation();
        exitEditMode(true);
    });

    // Cancel button (inline edit)
    $(document).on('click', '.rp-mem-cancel-btn', function (e) {
        e.stopPropagation();
        exitEditMode(false);
    });

    // Escape key cancels inline edit
    $(document).on('keydown', '.rp-mem-editing', function (e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            exitEditMode(false);
        }
    });

    // Pin/unpin button
    $(document).on('click', '.rp-mem-pin-btn', function (e) {
        e.stopPropagation();
        const card = $(this).closest('.rp-mem-entity');
        togglePin(card.data('category'), card.data('id'));
    });

    // Delete button
    $(document).on('click', '.rp-mem-delete-btn', function (e) {
        e.stopPropagation();
        const card = $(this).closest('.rp-mem-entity');
        deleteEntity(card.data('category'), card.data('id'));
    });
}

// ===================== Memory Persistence =====================

function saveMemoryState() {
    const context = getContext();
    if (!context.chatMetadata) return;

    const state = memoryStore.serialize();

    // Persist entity embeddings alongside memory state
    if (embeddingService) {
        state._embeddings = embeddingService.serialize();
    }

    context.chatMetadata[EXTENSION_KEY] = state;
    saveMetadataDebounced();
    debugLog('Memory state saved');
}

function onChatChanged() {
    const context = getContext();
    goalsManager?.clearAnalysis?.();
    dismissDirectionNudge();
    $('.rp-mem-direction-overlay, .rp-mem-ooc-overlay').remove();

    if (!context.chat || !context.chatId) {
        memoryStore.clear();
        if (embeddingService) {
            embeddingService.clearCache();
        }
        injectMemoryPrompt();
        renderMemoryUI();
        renderDirectionButton();
        return;
    }

    const savedState = context.chatMetadata?.[EXTENSION_KEY] || null;
    memoryStore.load(savedState);

    // Load persisted embeddings (strips _embeddings from state so MemoryStore ignores it)
    if (embeddingService) {
        embeddingService.load(savedState?._embeddings || null);
    }

    injectMemoryPrompt();
    renderMemoryUI();
    renderDirectionButton();
    debugLog('Chat changed, memory loaded', savedState ? 'from saved state' : 'fresh');
}

// ===================== Prompt Injection =====================

async function injectMemoryPrompt() {
    const s = getSettings();
    if (!s.enabled) {
        setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    const budgetInfo = getEffectiveMemoryBudget();
    const effectiveMemoryBudget = budgetInfo.totalBudget;
    const effectiveEpisodicBudget = getEffectiveEpisodicBudget(effectiveMemoryBudget);
    const tokenBudgetOverride = budgetInfo.isCapped ? effectiveMemoryBudget : undefined;
    let promptText = '';
    const apiKey = await resolveApiKey();
    const currentTurn = memoryStore.getTurnCounter();
    const narrativeDirection = goalsManager ? goalsManager.getNarrativeDirection(currentTurn) : null;

    if (budgetInfo.isCapped && effectiveMemoryBudget <= 0) {
        promptText = '';
    } else if (s.embeddingsEnabled && apiKey && embeddingService) {
        try {
            const context = getContext();
            const recentMessages = getRecentMessageTexts(context, s.messagesPerExtraction * 2);

            if (recentMessages.length > 0) {
                const { ranked, sceneType } = await embeddingService.rankEntities(memoryStore, recentMessages, currentTurn);

                // Auto-promote: if a Tier 3 entity is in the top-K selected, promote to Tier 2
                const topK = ranked.slice(0, Math.min(ranked.length, 20));
                for (const item of topK) {
                    if (item.entity.tier === 3) {
                        memoryStore.updateEntity(item.category, item.entity.id, { tier: 2 });
                        debugLog(`Auto-promoted "${item.entity.name}" from Tier 3 to Tier 2 (score: ${item.score.toFixed(3)})`);
                    }
                }

                const rankedForTurnRetrieval = ranked.filter(item => item.entity.tier !== 3);
                // Exclude generic goal entities from the base injector list — GoalsManager replaces them below.
                const injectionRanked = rankedForTurnRetrieval.filter(item => item.category !== 'goals');

                // Rank beats or raw turns
                let rankedBeats = null;
                let rankedRawTurns = null;
                if (isRawTurnRetrievalMode() && rawTurnRanker) {
                    const rawTurnResult = await rawTurnRanker.rank(memoryStore, recentMessages, rankedForTurnRetrieval, currentTurn, {
                        rawTurnBudget: effectiveEpisodicBudget,
                        compactionEnabled: s.rawTurnCompactionEnabled,
                    });
                    rankedRawTurns = rawTurnResult.ranked;
                    if (s.debugMode) {
                        debugLog('Raw-turn ranking stats:', rawTurnResult.stats);
                    }
                } else {
                    try {
                        rankedBeats = await embeddingService.rankBeats(memoryStore, recentMessages, currentTurn);
                    } catch (beatErr) {
                        debugLog('Beat ranking failed:', beatErr.message);
                    }
                }

                // Rank reflections by relevance (not just recency)
                let rankedReflections = null;
                try {
                    const rankedRefResults = await embeddingService.rankReflections(memoryStore, recentMessages, currentTurn);
                    rankedReflections = rankedRefResults.slice(0, 8).map(r => r.reflection);
                } catch (refErr) {
                    debugLog('Reflection ranking failed, falling back to recency:', refErr.message);
                    rankedReflections = memoryStore.getRecentReflections(5);
                }

                const rankedGoals = goalsManager.getRankedGoals(currentTurn);
                const goalBeats = goalsManager.getGoalBeats(rankedGoals.map(g => g.entity.id));
                promptText = injector.format(memoryStore, {
                    relevantEntities: injectionRanked,
                    sceneType,
                    currentTurn,
                    rankedBeats,
                    rankedRawTurns,
                    reflections: rankedReflections,
                    rankedGoals,
                    goalBeats,
                    narrativeDirection,
                    tokenBudgetOverride,
                });
                debugLog(
                    'Embedding-based injection:',
                    injectionRanked.length,
                    '/',
                    ranked.length,
                    'entities (excluded',
                    ranked.length - injectionRanked.length,
                    'tier-3), scene:',
                    sceneType,
                    ', goals:',
                    rankedGoals.length,
                    isRawTurnRetrievalMode() ? `, raw turns: ${rankedRawTurns?.length || 0}` : '',
                );
            } else {
                const reflections = memoryStore.getRecentReflections(5);
                const rankedGoals = goalsManager.getRankedGoals(currentTurn);
                const goalBeats = goalsManager.getGoalBeats(rankedGoals.map(g => g.entity.id));
                const rankedRawTurns = isRawTurnRetrievalMode()
                    ? memoryStore.getRecentRawTurns(6).map(turn => ({ turn, score: 0 }))
                    : null;
                promptText = injector.format(memoryStore, {
                    currentTurn,
                    reflections,
                    rankedGoals,
                    goalBeats,
                    rankedRawTurns,
                    narrativeDirection,
                    tokenBudgetOverride,
                });
            }
        } catch (err) {
            console.warn('[RP Memory] Embedding ranking failed, falling back to full injection:', err.message);
            const reflections = memoryStore.getRecentReflections(5);
            const rankedGoals = goalsManager.getRankedGoals(currentTurn);
            const goalBeats = goalsManager.getGoalBeats(rankedGoals.map(g => g.entity.id));
            const rankedRawTurns = isRawTurnRetrievalMode()
                ? memoryStore.getRecentRawTurns(6).map(turn => ({ turn, score: 0 }))
                : null;
            promptText = injector.format(memoryStore, {
                currentTurn,
                reflections,
                rankedGoals,
                goalBeats,
                rankedRawTurns,
                narrativeDirection,
                tokenBudgetOverride,
            });
        }
    } else {
        const reflections = memoryStore.getRecentReflections(5);
        const rankedGoals = goalsManager.getRankedGoals(currentTurn);
        const goalBeats = goalsManager.getGoalBeats(rankedGoals.map(g => g.entity.id));
        const rankedRawTurns = isRawTurnRetrievalMode()
            ? memoryStore.getRecentRawTurns(6).map(turn => ({ turn, score: 0 }))
            : null;
        promptText = injector.format(memoryStore, {
            currentTurn,
            reflections,
            rankedGoals,
            goalBeats,
            rankedRawTurns,
            narrativeDirection,
            tokenBudgetOverride,
        });
    }

    if (s.debugMode && promptText) {
        debugLog('Injection prompt:\n', promptText);
    }

    setExtensionPrompt(
        MODULE_NAME,
        promptText,
        s.injectionPosition,
        s.injectionDepth,
        false,
        s.injectionRole,
    );

    // Update token count display
    const tokens = estimateTokens(promptText || '');
    const totalStored = injector.getTotalStoredTokens(memoryStore);
    let countText = `~${tokens} injected / ~${totalStored} stored`;
    if (budgetInfo.isCapped) {
        const budgetLabel = budgetInfo.reserveApplied
            ? `effective budget: ${effectiveMemoryBudget}`
            : `budget: ${effectiveMemoryBudget}`;
        countText += ` (${budgetLabel})`;
        if (tokens > effectiveMemoryBudget) {
            countText += ' OVER';
        }
    } else if (budgetInfo.chatReserve > 0) {
        countText += ` (chat reserve requested: ${budgetInfo.chatReserve})`;
    }
    $('#rp_memory_token_count').text(countText);

    debugLog('Prompt injected', `${tokens} tokens`);
}

/**
 * Extract recent message texts from the chat context.
 */
function getRecentMessageTexts(context, count) {
    if (!context.chat?.length) return [];

    const messages = context.chat
        .filter(m => !m.is_system)
        .slice(-count)
        .map(m => m.mes || '')
        .filter(Boolean);

    return messages;
}

function getRecentMessagesForGoalAnalysis(context, count) {
    if (!context.chat?.length) return [];

    const prioritizeUser = getSettings().userMessageWeight === 'high';

    return context.chat
        .filter(m => !m.is_system)
        .slice(-count)
        .map(m => ({
            speaker: m.name || (m.is_user ? 'User' : 'Assistant'),
            role: m.is_user ? 'user' : 'assistant',
            priority: m.is_user && prioritizeUser ? 'high' : 'normal',
            text: m.mes || '',
            isUser: Boolean(m.is_user),
        }))
        .filter(m => m.text);
}

// ===================== Prompt Language =====================

/**
 * Resolve the current prompt language (en/zh).
 * Uses LanguageDetector with the user's setting + auto-detection from recent messages.
 */
function getPromptLanguage() {
    const s = getSettings();
    const context = getContext();
    const recentTexts = getRecentMessageTexts(context, 10);
    return LanguageDetector.resolve(s.language, recentTexts);
}

function clearDerivedAnalysis() {
    goalsManager?.clearAnalysis?.();
}

function recordMemoryChange(change) {
    if (!memoryStore) return;
    memoryStore.recordChange({
        turn: memoryStore.getTurnCounter(),
        source: 'manual',
        ...change,
    });
}

function recordEntityChangeFromSnapshots(category, beforeEntity, afterEntity, source = 'manual', action = 'updated') {
    const subject = afterEntity || beforeEntity;
    if (!subject || !memoryStore) return;

    const details = diffEntitySnapshots(beforeEntity, afterEntity);
    if (action === 'updated' && details.length === 0) return;

    memoryStore.recordChange({
        turn: memoryStore.getTurnCounter(),
        source,
        action,
        category,
        entityId: subject.id,
        entityName: subject.name,
        details,
    });
}

// ===================== Render UI =====================

function renderMemoryUI() {
    // If a card is being edited, defer full re-render to avoid destroying edit state.
    // Counts will still update; full re-render happens when edit completes.
    if (currentEditCard) {
        const counts = memoryStore.getCounts();
        for (const [cat, count] of Object.entries(counts)) {
            $(`.rp-mem-category-count[data-category="${cat}"]`).text(count);
        }
        updateRecentChangeCount(counts.changes || 0);
        return;
    }

    const counts = memoryStore.getCounts();

    // Update counts in sidebar
    for (const [cat, count] of Object.entries(counts)) {
        $(`#rp_memory_settings .rp-mem-category-count[data-category="${cat}"]`).text(count);
    }

    // Render each category in sidebar
    renderCategoryEntities('mainCharacter');
    renderCategoryEntities('characters');
    renderCategoryEntities('locations');
    renderCategoryEntities('goals');
    renderCategoryEntities('events');

    // Update conflict count
    const conflictCount = memoryStore.getConflictCount();
    if (conflictCount > 0) {
        $('#rp_memory_conflict_count').text(conflictCount).show();
    } else {
        $('#rp_memory_conflict_count').hide();
    }

    updateRecentChangeCount(counts.changes || 0);
    renderConflicts();
    renderRecentChanges();

    // Also update floating nav counts + active panel
    updateFloatingNavCounts();
    if (activePanelCategory) {
        renderPanelCards(activePanelCategory);
    }
}

function renderCategoryEntities(category) {
    const container = $(`#rp_memory_cat_${category}`);
    container.empty();

    const entities = memoryStore.getAllEntities(category);
    const entityList = Object.values(entities);

    if (entityList.length === 0) {
        container.append(`<div class="rp-mem-empty-state">${escapeHtml(tt`No entries yet`)}</div>`);
        return;
    }

    // Sort: Tier 1 first, then by importance descending
    entityList.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));

    for (const entity of entityList) {
        container.append(renderEntityCard(category, entity));
    }
}

function renderEntityCard(category, entity) {
    const tierLabel = { 1: tt`Pinned`, 2: tt`Active`, 3: tt`Archived` };
    const tierClass = { 1: 'tier-pinned', 2: 'tier-active', 3: 'tier-archived' };
    const hasConflicts = (entity.conflicts || []).some(c => !c.resolved);

    let fieldsHtml = '';
    if (entity.fields) {
        fieldsHtml = renderEntityFields(category, entity.fields);
    }

    return `
    <div class="rp-mem-entity ${tierClass[entity.tier] || ''}" data-category="${category}" data-id="${entity.id}">
        <div class="rp-mem-entity-header">
            <span class="rp-mem-entity-name" data-field="name">${escapeHtml(entity.name)}</span>
            <span class="rp-mem-tier-badge" data-field="tier" data-value="${entity.tier}">${tierLabel[entity.tier] || '?'}</span>
            <span class="rp-mem-importance" data-field="importance" data-value="${entity.importance}">${entity.importance}</span>
            ${hasConflicts ? `<i class="fa-solid fa-triangle-exclamation rp-mem-conflict-icon" title="${escapeHtml(tt`Has unresolved conflicts`)}"></i>` : ''}
            <div class="rp-mem-entity-actions">
                <i class="fa-solid fa-pen rp-mem-edit-btn" title="${escapeHtml(tt`Edit`)}"></i>
                <i class="fa-solid fa-thumbtack rp-mem-pin-btn" title="${escapeHtml(tt`Toggle pin`)}"></i>
                <i class="fa-solid fa-trash rp-mem-delete-btn" title="${escapeHtml(tt`Delete`)}"></i>
            </div>
        </div>
        <div class="rp-mem-entity-fields" style="display:none;">
            ${fieldsHtml}
        </div>
    </div>`;
}

function renderEntityFields(category, fields) {
    const lines = [];

    for (const [key, value] of Object.entries(fields)) {
        if (value === null || value === undefined || value === '') continue;
        // Skip empty arrays (legacy data)
        if (Array.isArray(value) && value.length === 0) continue;
        // Skip empty objects (legacy data) — but NOT provenance objects
        if (typeof value === 'object' && !Array.isArray(value) && !('value' in value) && Object.keys(value).length === 0) continue;

        const rawLabel = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
        const label = tl(rawLabel);
        const displayVal = displayStr(value);
        if (!displayVal) continue;

        lines.push(`<div class="rp-mem-field" data-field="${escapeHtml(key)}" data-type="string"><span class="rp-mem-field-label">${escapeHtml(label)}:</span> <span class="rp-mem-field-value">${escapeHtml(displayVal)}</span></div>`);
    }

    return lines.join('');
}

// ===================== Conflict UI =====================

function renderConflicts() {
    const container = $('#rp_memory_conflict_list');
    container.empty();

    const allConflicts = memoryStore.getConflicts();

    if (allConflicts.length === 0) {
        container.append(`<div class="rp-mem-empty-state">${escapeHtml(tt`No conflicts detected`)}</div>`);
        return;
    }

    for (const { category, entity, conflicts } of allConflicts) {
        for (const conflict of conflicts) {
            container.append(renderConflictCard(category, entity, conflict));
        }
    }
}

function updateRecentChangeCount(count) {
    if (count > 0) {
        $('#rp_memory_change_count').text(count).show();
    } else {
        $('#rp_memory_change_count').hide();
    }
}

function renderRecentChanges(limit = 24) {
    const container = $('#rp_memory_change_list');
    if (!container.length) return;
    container.empty();

    const changes = memoryStore.getRecentChanges(limit);
    if (changes.length === 0) {
        container.append(`<div class="rp-mem-empty-state">${escapeHtml(tt`No recent changes`)}</div>`);
        return;
    }

    for (const [index, change] of changes.entries()) {
        container.append(buildRecentChangeCardHtml(change, index === 0));
    }
}

function getChangeActionLabel(change) {
    const labels = {
        created: tt`Added`,
        updated: tt`Updated`,
        deleted: tt`Removed`,
        pinned: tt`Pinned`,
        unpinned: tt`Unpinned`,
        conflict_accepted: tt`Accepted change`,
        conflict_reverted: tt`Kept previous value`,
        cleared_all: tt`Cleared memory`,
    };
    return labels[change.action] || tt`Updated`;
}

function getChangeSourceLabel(change) {
    const labels = {
        extraction: tt`Extraction`,
        ooc: tt`Author correction`,
        manual: tt`Manual edit`,
        system: tt`System`,
    };
    return labels[change.source] || tt`System`;
}

function getChangeTargetLabel(change) {
    if (change.action === 'cleared_all') {
        return tt`All memory`;
    }

    const categoryLabel = change.category ? getCategoryLabel(change.category) : '';
    if (change.entityName && categoryLabel) {
        return `${change.entityName} • ${categoryLabel}`;
    }
    return change.entityName || categoryLabel || tt`Memory`;
}

function getChangeFieldLabel(field) {
    const metaLabels = {
        name: tt`Name`,
        aliases: tt`Aliases`,
        tier: tt`Tier`,
        importance: tt`Importance`,
    };
    if (metaLabels[field]) return metaLabels[field];

    const rawLabel = field.charAt(0).toUpperCase() + field.slice(1).replace(/([A-Z])/g, ' $1');
    return tl(rawLabel);
}

function buildChangeDetailRows(details, limit = 4) {
    const rows = [];
    const visible = details.slice(0, limit);

    for (const detail of visible) {
        const label = getChangeFieldLabel(detail.field);
        const before = detail.oldValue || '';
        const after = detail.newValue || '';

        rows.push(`
            <div class="rp-mem-change-detail">
                <div class="rp-mem-change-detail-label">${escapeHtml(label)}</div>
                <div class="rp-mem-change-detail-values">
                    ${before ? `<div class="rp-mem-change-detail-before" title="${escapeHtml(before)}">${escapeHtml(before)}</div>` : ''}
                    ${after ? `<div class="rp-mem-change-detail-after" title="${escapeHtml(after)}">${escapeHtml(after)}</div>` : ''}
                </div>
            </div>
        `);
    }

    if (details.length > limit) {
        rows.push(`<div class="rp-mem-change-more">${escapeHtml(tt`${details.length - limit} more changes`)}</div>`);
    }

    return rows.join('');
}

function buildRecentChangeCardHtml(change, expanded = false) {
    const actionLabel = getChangeActionLabel(change);
    const sourceLabel = getChangeSourceLabel(change);
    const targetLabel = getChangeTargetLabel(change);
    const details = Array.isArray(change.details) ? change.details : [];
    const detailRows = buildChangeDetailRows(details);
    const noteMap = {
        cleared_all: tt`All stored memory entries were removed for this chat.`,
        deleted: tt`This entry was removed from memory.`,
        pinned: tt`This entry was pinned for stronger injection priority.`,
        unpinned: tt`This entry returned to normal priority.`,
        conflict_accepted: tt`The newer extracted value was kept.`,
        conflict_reverted: tt`The previous value was restored.`,
    };
    const note = !detailRows ? (noteMap[change.action] || tt`No field-level details recorded.`) : '';

    return `
    <details class="rp-mem-change-card"${expanded ? ' open' : ''}>
        <summary class="rp-mem-change-summary">
            <div class="rp-mem-change-summary-main">
                <div class="rp-mem-change-title">${escapeHtml(actionLabel)}</div>
                <div class="rp-mem-change-target">${escapeHtml(targetLabel)}</div>
            </div>
            <div class="rp-mem-change-summary-meta">
                <span class="rp-mem-change-source rp-mem-change-source-${escapeHtml(change.source || 'system')}">${escapeHtml(sourceLabel)}</span>
                <span class="rp-mem-change-turn">${escapeHtml(tt`Turn`)} ${change.turn ?? 0}</span>
            </div>
        </summary>
        <div class="rp-mem-change-body">
            ${detailRows || `<div class="rp-mem-change-note">${escapeHtml(note)}</div>`}
        </div>
    </details>`;
}

function renderConflictCard(category, entity, conflict) {
    return `
    <div class="rp-mem-conflict-card" data-category="${category}" data-id="${entity.id}" data-field="${escapeHtml(conflict.field)}">
        <div class="rp-mem-conflict-header">
            ${escapeHtml(entity.name)} &gt; ${escapeHtml(conflict.field)} (${tt`Turn`} ${conflict.detectedTurn})
        </div>
        <div class="rp-mem-conflict-diff">
            <div class="rp-mem-conflict-old">
                <span class="rp-mem-field-label">${tt`Old:`}</span> ${escapeHtml(JSON.stringify(conflict.oldValue))}
            </div>
            <div class="rp-mem-conflict-new">
                <span class="rp-mem-field-label">${tt`New:`}</span> ${escapeHtml(JSON.stringify(conflict.newValue))}
            </div>
        </div>
        <div class="rp-mem-conflict-actions">
            <div class="menu_button rp-mem-conflict-accept" data-category="${category}" data-id="${entity.id}" data-field="${escapeHtml(conflict.field)}">${tt`Accept New`}</div>
            <div class="menu_button rp-mem-conflict-revert" data-category="${category}" data-id="${entity.id}" data-field="${escapeHtml(conflict.field)}">${tt`Keep Old`}</div>
        </div>
    </div>`;
}

function bindConflictListeners() {
    $(document).on('click', '.rp-mem-conflict-accept', function () {
        const { category, id, field } = $(this).data();
        resolveConflict(category, id, field, true);
    });

    $(document).on('click', '.rp-mem-conflict-revert', function () {
        const { category, id, field } = $(this).data();
        resolveConflict(category, id, field, false);
    });
}

function resolveConflict(category, entityId, field, acceptNew) {
    const entity = memoryStore.getEntity(category, entityId);
    if (!entity) return;

    const conflict = entity.conflicts.find(c => c.field === field && !c.resolved);
    if (!conflict) return;

    if (!acceptNew) {
        // Revert: restore old value (wrap with provenance)
        if (entity.fields && conflict.oldValue !== undefined) {
            const currentTurn = memoryStore.getTurnCounter();
            entity.fields[field] = wrapField(conflict.oldValue, currentTurn);
        }
    }

    conflict.resolved = true;
    clearDerivedAnalysis();
    recordMemoryChange({
        action: acceptNew ? 'conflict_accepted' : 'conflict_reverted',
        category,
        entityId,
        entityName: entity.name,
        details: [{
            kind: 'field',
            field,
            oldValue: conflict.oldValue ?? '',
            newValue: acceptNew ? (conflict.newValue ?? '') : (conflict.oldValue ?? ''),
        }],
    });
    saveMemoryState();
    injectMemoryPrompt();
    renderMemoryUI();
}

// ===================== Entity CRUD =====================

async function openAddEntityDialog(category) {
    const categoryLabels = {
        mainCharacter: tt`Main Character`,
        characters: tt`Character (NPC)`,
        locations: tt`Location`,
        goals: tt`Goal / Task`,
        events: tt`Event`,
    };

    // For mainCharacter, check if one already exists
    if (category === 'mainCharacter' && memoryStore.getMainCharacter()) {
        enterEditMode('mainCharacter', 'main_character');
        return;
    }

    try {
        const defaultName = category === 'mainCharacter' ? '{{user}}' : '';
        const catLabel = categoryLabels[category] || category;
        const name = await Popup.show.input(
            tt`Add ${catLabel}`,
            tt`Enter a name:`,
            defaultName,
        );

        debugLog('Add entity result:', name);

        if (!name || !name.trim()) return;

        const turn = memoryStore.getTurnCounter();
        const entity = createEmptyEntity(category, name.trim(), turn);
        memoryStore.addEntity(category, entity);
        clearDerivedAnalysis();
        recordEntityChangeFromSnapshots(category, null, entity, 'manual', 'created');
        saveMemoryState();
        injectMemoryPrompt();
        renderMemoryUI();
        debugLog('Entity added:', category, entity.id);

        const panelOpenForCategory = activePanelCategory === category && $('.rp-mem-data-panel').not('.hidden').length;
        if (panelOpenForCategory) {
            openCardEditOverlay(category, entity.id);
        } else {
            enterEditMode(category, entity.id);
        }
    } catch (err) {
        console.error('[RP Memory] Error adding entity:', err);
    }
}

/**
 * Field definitions for inline editing per category.
 * Each entry: { key, label, type, options? }
 * type: 'text' | 'textarea' | 'number' | 'select'
 * All string fields stored as plain strings — no CSV parsing or dot-notation.
 */
const FIELD_DEFS = {
    characters: [
        { key: 'description', label: 'Description', type: 'textarea' },
        { key: 'personality', label: 'Personality', type: 'textarea' },
        { key: 'mood', label: 'Mood', type: 'text' },
        { key: 'status', label: 'Status', type: 'text' },
        { key: 'relationships', label: 'Relationships', type: 'textarea' },
        { key: 'backstory', label: 'Backstory', type: 'textarea' },
        { key: 'speechPatterns', label: 'Speech Patterns', type: 'textarea' },
        { key: 'history', label: 'History', type: 'textarea' },
        { key: 'goals', label: 'Goals', type: 'textarea' },
        { key: '_aliases', label: 'Aliases', type: 'text', meta: true },
    ],
    locations: [
        { key: 'description', label: 'Description', type: 'textarea' },
        { key: 'atmosphere', label: 'Atmosphere', type: 'text' },
        { key: 'notableFeatures', label: 'Notable Features', type: 'textarea' },
        { key: 'connections', label: 'Connections', type: 'textarea' },
    ],
    mainCharacter: [
        { key: 'description', label: 'Description', type: 'textarea' },
        { key: 'skills', label: 'Skills', type: 'textarea' },
        { key: 'inventory', label: 'Inventory', type: 'textarea' },
        { key: 'health', label: 'Health', type: 'text' },
        { key: 'conditions', label: 'Conditions', type: 'text' },
        { key: 'buffs', label: 'Buffs', type: 'text' },
    ],
    goals: [
        { key: 'description', label: 'Description', type: 'textarea' },
        { key: 'progress', label: 'Progress', type: 'textarea' },
        { key: 'blockers', label: 'Blockers', type: 'text' },
        { key: 'status', label: 'Status', type: 'select', options: [
            { value: 'in_progress', label: 'In Progress' },
            { value: 'completed', label: 'Completed' },
            { value: 'failed', label: 'Failed' },
            { value: 'abandoned', label: 'Abandoned' },
        ] },
        { key: 'timeframe', label: 'Timeframe', type: 'select', options: [
            { value: 'immediate', label: 'Immediate' },
            { value: 'short_term', label: 'Short-Term' },
            { value: 'long_term', label: 'Long-Term' },
        ] },
    ],
    events: [
        { key: 'description', label: 'Description', type: 'textarea' },
        { key: 'turn', label: 'Turn', type: 'number' },
        { key: 'involvedEntities', label: 'Involved Entities', type: 'textarea' },
        { key: 'consequences', label: 'Consequences', type: 'textarea' },
        { key: 'significance', label: 'Significance', type: 'text' },
    ],
};

/**
 * Backward-compatible string coercion for display.
 * Handles legacy arrays/objects from old data, returns a plain string.
 */
function displayStr(value) {
    if (!value) return '';
    // Handle provenance-wrapped objects
    const unwrapped = unwrapField(value);
    if (!unwrapped && unwrapped !== 0) return '';
    if (Array.isArray(unwrapped)) {
        if (unwrapped.length && typeof unwrapped[0] === 'object') {
            return unwrapped.map(v => v.target ? `${v.target}: ${v.nature || ''}` : JSON.stringify(v)).join(', ');
        }
        return unwrapped.join(', ');
    }
    if (typeof unwrapped === 'object') {
        return Object.entries(unwrapped)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .filter(([, v]) => v)
            .join('; ');
    }
    return String(unwrapped);
}

let currentEditCard = null; // Track the currently editing card

function enterEditMode(category, entityId) {
    const entity = memoryStore.getEntity(category, entityId);
    if (!entity) {
        debugLog('Edit: entity not found', category, entityId);
        return;
    }

    // Cancel any existing edit first
    if (currentEditCard) {
        exitEditMode(false);
    }

    // Find the card (could be in sidebar or panel)
    const $cards = $(`.rp-mem-entity[data-category="${category}"][data-id="${entityId}"]`);
    const $card = $cards.filter(':visible').first().length
        ? $cards.filter(':visible').first()
        : $cards.first();
    if (!$card.length) {
        debugLog('Edit: card element not found');
        return;
    }

    currentEditCard = { category, entityId, $card };
    $card.addClass('rp-mem-editing');

    // Show the fields section
    $card.find('.rp-mem-entity-fields').show();

    // Replace name with input
    const $name = $card.find('.rp-mem-entity-name');
    $name.html(`<input type="text" class="rp-mem-inline-input rp-mem-edit-name-input" value="${escapeHtml(entity.name)}" />`);

    // Replace tier badge with dropdown
    const $tier = $card.find('.rp-mem-tier-badge');
    $tier.html(`
        <select class="rp-mem-inline-select rp-mem-edit-tier-select">
            <option value="1" ${entity.tier === 1 ? 'selected' : ''}>${tt`Pinned`}</option>
            <option value="2" ${entity.tier === 2 ? 'selected' : ''}>${tt`Active`}</option>
            <option value="3" ${entity.tier === 3 ? 'selected' : ''}>${tt`Archived`}</option>
        </select>
    `);

    // Replace importance with number input
    const $imp = $card.find('.rp-mem-importance');
    $imp.html(`<input type="number" class="rp-mem-inline-input rp-mem-edit-importance-input" min="1" max="10" step="0.5" value="${entity.importance}" />`);

    // Replace field values with appropriate inputs
    const $fields = $card.find('.rp-mem-entity-fields');
    const defs = FIELD_DEFS[category] || [];
    const fields = entity.fields || {};

    // Clear and rebuild fields section with editable inputs
    $fields.empty();

    for (const def of defs) {
        let inputHtml = '';

        // Handle meta fields (like aliases) that aren't in entity.fields
        if (def.meta && def.key === '_aliases') {
            const aliasVal = (entity.aliases || []).join(', ');
            inputHtml = `<input type="text" class="rp-mem-inline-input" data-edit-field="${def.key}" value="${escapeHtml(aliasVal)}" />`;
        } else {
            const rawValue = fields[def.key];

            switch (def.type) {
                case 'textarea': {
                    const val = displayStr(rawValue);
                    inputHtml = `<textarea class="rp-mem-inline-textarea" data-edit-field="${def.key}">${escapeHtml(val)}</textarea>`;
                    break;
                }
                case 'text': {
                    const val = displayStr(rawValue);
                    inputHtml = `<input type="text" class="rp-mem-inline-input" data-edit-field="${def.key}" value="${escapeHtml(val)}" />`;
                    break;
                }
                case 'number': {
                    const val = displayStr(rawValue) || 0;
                    inputHtml = `<input type="number" class="rp-mem-inline-input" data-edit-field="${def.key}" value="${val}" />`;
                    break;
                }
                case 'select': {
                    const displayVal = displayStr(rawValue);
                    const opts = (def.options || []).map(o =>
                        `<option value="${o.value}" ${displayVal === o.value ? 'selected' : ''}>${escapeHtml(tl(o.label))}</option>`,
                    ).join('');
                    inputHtml = `<select class="rp-mem-inline-select" data-edit-field="${def.key}">${opts}</select>`;
                    break;
                }
            }
        }

        $fields.append(`
            <div class="rp-mem-edit-field-row">
                <label class="rp-mem-edit-field-label">${escapeHtml(tl(def.label))}</label>
                ${inputHtml}
            </div>
        `);
    }

    // Add save/cancel bar
    $fields.append(`
        <div class="rp-mem-edit-actions">
            <div class="menu_button rp-mem-save-btn"><i class="fa-solid fa-check"></i> ${tt`Save`}</div>
            <div class="menu_button rp-mem-cancel-btn"><i class="fa-solid fa-xmark"></i> ${tt`Cancel`}</div>
        </div>
    `);

    // Focus the first input
    $card.find('.rp-mem-edit-name-input').focus().select();
}

function exitEditMode(save) {
    if (!currentEditCard) return;

    const { category, entityId, $card } = currentEditCard;

    if (save) {
        const entity = memoryStore.getEntity(category, entityId);
        if (entity) {
            const beforeSnapshot = JSON.parse(JSON.stringify(entity));
            const updatedName = $card.find('.rp-mem-edit-name-input').val()?.trim() || entity.name;
            const updatedTier = parseInt($card.find('.rp-mem-edit-tier-select').val()) || entity.tier;
            const updatedImportance = parseFloat($card.find('.rp-mem-edit-importance-input').val()) || entity.importance;
            const updatedFields = readInlineFields($card, category, entity.fields);

            // Read aliases from meta field
            const $aliasInput = $card.find('[data-edit-field="_aliases"]');
            let updatedAliases = entity.aliases || [];
            if ($aliasInput.length) {
                const aliasStr = $aliasInput.val() || '';
                updatedAliases = aliasStr.split(',').map(a => a.trim()).filter(Boolean);
            }

            memoryStore.updateEntity(category, entityId, {
                name: updatedName,
                aliases: updatedAliases,
                tier: updatedTier,
                importance: updatedImportance,
                baseScore: updatedImportance,
                fields: updatedFields,
                source: 'manual',
            });

            // Invalidate embedding cache for this entity
            if (embeddingService) {
                embeddingService.invalidateEntity(category, entityId);
            }

            clearDerivedAnalysis();
            recordEntityChangeFromSnapshots(category, beforeSnapshot, memoryStore.getEntity(category, entityId), 'manual', 'updated');
            saveMemoryState();
            injectMemoryPrompt();
            debugLog('Entity updated via inline edit:', category, entityId);
        }
    }

    currentEditCard = null;
    renderMemoryUI();
}

function readInlineFields($card, category, existingFields) {
    const defs = FIELD_DEFS[category] || [];
    const currentTurn = memoryStore.getTurnCounter();
    // Start from a clone of existing fields to preserve any fields we don't have defs for
    const fields = JSON.parse(JSON.stringify(existingFields || {}));

    for (const def of defs) {
        // Skip meta fields (handled separately)
        if (def.meta) continue;

        const $input = $card.find(`[data-edit-field="${def.key}"]`);
        if (!$input.length) continue;

        let value;
        switch (def.type) {
            case 'number':
                value = parseInt($input.val()) || 0;
                break;
            default:
                value = $input.val() || '';
        }

        // Wrap string values with provenance
        if (typeof value === 'string') {
            fields[def.key] = wrapField(value, currentTurn);
        } else {
            fields[def.key] = value;
        }
    }

    return fields;
}

// ===================== Entity Actions =====================

function togglePin(category, entityId) {
    const entity = memoryStore.getEntity(category, entityId);
    if (!entity) return;

    const beforeSnapshot = JSON.parse(JSON.stringify(entity));
    const newTier = entity.tier === 1 ? 2 : 1;
    memoryStore.updateEntity(category, entityId, { tier: newTier });
    clearDerivedAnalysis();
    recordEntityChangeFromSnapshots(
        category,
        beforeSnapshot,
        memoryStore.getEntity(category, entityId),
        'manual',
        newTier === 1 ? 'pinned' : 'unpinned',
    );
    saveMemoryState();
    injectMemoryPrompt();
    renderMemoryUI();
}

async function deleteEntity(category, entityId) {
    const entity = memoryStore.getEntity(category, entityId);
    if (!entity) return;

    const result = await Popup.show.confirm(
        tt`Delete "${escapeHtml(entity.name)}"?`,
        tt`This will remove the entity from memory.`,
    );

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        const beforeSnapshot = JSON.parse(JSON.stringify(entity));
        memoryStore.deleteEntity(category, entityId);
        clearDerivedAnalysis();
        recordEntityChangeFromSnapshots(category, beforeSnapshot, null, 'manual', 'deleted');
        saveMemoryState();
        injectMemoryPrompt();
        renderMemoryUI();
    }
}

async function clearAllMemory() {
    const result = await Popup.show.confirm(
        tt`Clear ALL memory?`,
        tt`This will remove all memory for this chat. This cannot be undone.`,
    );

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        const clearedTurn = memoryStore.getTurnCounter();
        memoryStore.clear();
        clearDerivedAnalysis();
        recordMemoryChange({
            turn: clearedTurn,
            action: 'cleared_all',
            source: 'manual',
            meta: { clearedAtTurn: clearedTurn },
        });
        saveMemoryState();
        injectMemoryPrompt();
        renderMemoryUI();
    }
}

// ===================== Extraction & Events =====================

/**
 * Called after AI responds. Checks interval, runs decay, triggers async extraction.
 * @param {number} _chatId - chat message index (from ST event)
 * @param {string} type - 'normal' | 'regenerate' | 'swipe' | 'continue' | 'append'
 */
async function onNewMessage(_chatId, type) {
    const settings = getSettings();
    if (!settings.enabled) return;

    // Clean up OOC injection after regeneration completes
    if (pendingOOCCleanup && type === 'regenerate') {
        setExtensionPrompt('rp_memory_ooc', '', extension_prompt_types.IN_CHAT, 0);
        pendingOOCCleanup = false;
        debugLog('OOC injection cleared after regeneration');
    }

    // Regeneration / swipe = not a real new turn — just re-inject with current memory
    if (type === 'regenerate' || type === 'swipe') {
        debugLog(`Skipping turn increment (type: ${type})`);
        injectMemoryPrompt();
        return;
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) return;

    const context = getContext();
    if (!context.chat?.length) return;

    // Skip if nothing new
    if (context.chat.length <= lastProcessedLength) return;
    lastProcessedLength = context.chat.length;

    // Increment turn counter
    memoryStore.incrementTurn();

    // Check extraction interval
    const turnsSinceExtraction = memoryStore.getTurnCounter() - memoryStore.getLastExtractionTurn();
    if (turnsSinceExtraction < settings.extractionInterval) {
        injectMemoryPrompt();
        return;
    }

    // Run decay (synchronous, pure math)
    decayEngine.applyDecay(memoryStore, memoryStore.getTurnCounter());
    goalsManager.applyDecay(memoryStore.getTurnCounter());

    // Kick off async extraction — does NOT block chat
    triggerExtraction(context).catch(err => {
        if (err?.name === 'AbortError') return; // User stopped — already handled
        console.error('[RP Memory] Extraction failed:', err);
        toastr.error(tt`Memory extraction failed. Check console for details.`);
    });
}

/**
 * Pre-generation hook for sync-mode goal intent analysis.
 * Fires on GENERATION_STARTED — before the main model sees the prompt.
 * Analyzes current goals against recent messages, ranks them, and
 * updates the injection prompt so the model gets fresh goal context.
 *
 * @param {object} data - { type, contextSize, abort }
 */
async function onPreGeneration(data) {
    const s = getSettings();
    if (!s.enabled || !s.goalsIntentEnabled || s.goalsIntentAsync) return;

    // Skip non-normal generation types (quiet prompts, impersonate, etc.)
    if (data?.type && data.type !== 'normal' && data.type !== 'continue') return;

    const goals = memoryStore.getAllEntities('goals');
    if (Object.keys(goals).length === 0) return;

    try {
        const context = getContext();
        const recentMsgs = getRecentMessagesForGoalAnalysis(context, s.messagesPerExtraction * 2);
        if (recentMsgs.length === 0) return;

        const currentTurn = memoryStore.getTurnCounter();
        const direction = memoryStore.getAuthorDirection();
        await goalsManager.analyze(recentMsgs, currentTurn, direction);
        await injectMemoryPrompt();
        checkDirectionNudge();
        debugLog('Pre-generation goal analysis complete, prompt updated');
    } catch (err) {
        console.warn('[RP Memory] Pre-generation goal analysis failed:', err.message);
    }
}

/**
 * Async extraction orchestrator. Non-blocking.
 */
async function triggerExtraction(context) {
    if (memoryStore.isExtractionInProgress()) {
        debugLog('Extraction already in progress, skipping');
        return;
    }

    memoryStore.setExtractionInProgress(true);
    showExtractionIndicator(true);

    try {
        const { chatId, characterId } = context;

        await pipeline.extract(context);
        clearDerivedAnalysis();

        // Verify context hasn't changed during extraction
        const newContext = getContext();
        if (newContext.chatId !== chatId || newContext.characterId !== characterId) {
            debugLog('Context changed during extraction, discarding');
            return;
        }

        memoryStore.setLastExtractionTurn(memoryStore.getTurnCounter());

        // Enforce beat cap
        if (!isRawTurnRetrievalMode()) {
            const maxBeats = getSettings().maxBeats || 200;
            memoryStore.enforceMaxBeats(maxBeats);
        }

        // Prune low-importance events and completed/stale goals
        memoryStore.pruneEvents(6, 10);
        goalsManager.prune(memoryStore.getTurnCounter());

        // Async-mode goal analysis: fire in background post-extraction.
        // Sync-mode analysis runs pre-generation via GENERATION_STARTED hook instead.
        if (getSettings().goalsIntentEnabled && getSettings().goalsIntentAsync) {
            const turnAtStart = memoryStore.getTurnCounter();
            const recentMsgs = getRecentMessagesForGoalAnalysis(context, getSettings().messagesPerExtraction * 2);
            const direction = memoryStore.getAuthorDirection();

            goalsManager.analyze(recentMsgs, turnAtStart, direction).then(() => {
                if (memoryStore.getTurnCounter() !== turnAtStart) {
                    goalsManager.clearAnalysis();
                    debugLog('Goal intent analysis discarded (turn advanced)');
                    return;
                }
                injectMemoryPrompt();
                checkDirectionNudge();
                debugLog('Goal intent analysis complete (async), prompt re-injected');
            }).catch(err => {
                console.warn('[RP Memory] Goal intent analysis failed (async):', err.message);
            });
        }

        debugLog('Extraction complete');
        toastr.success(tt`Memory updated`, 'RP Memory', { timeOut: 2000 });

        // Post-extraction: compress beats first, then optionally reflect (async, non-blocking)
        // Defer save/inject/render until after reflection completes to avoid double-inject
        if (reflectionEngine && !isRawTurnRetrievalMode()) {
            // Abort any previous reflection still running
            reflectionEngine.abort();

            reflectionEngine.compress().then(() => {
                if (reflectionEngine.shouldReflect()) {
                    return reflectionEngine.reflect();
                }
            }).then(() => {
                saveMemoryState();
                injectMemoryPrompt();
                renderMemoryUI();
                debugLog('Post-extraction tasks complete');
            }).catch(err => {
                console.warn('[RP Memory] Post-extraction tasks failed:', err.message);
                // Still save/inject/render even if reflection failed
                saveMemoryState();
                injectMemoryPrompt();
                renderMemoryUI();
            });
        } else {
            saveMemoryState();
            injectMemoryPrompt();
            renderMemoryUI();
        }
    } catch (err) {
        if (err?.name === 'AbortError') {
            debugLog('Extraction aborted by user');
            return;
        }
        throw err;
    } finally {
        memoryStore.setExtractionInProgress(false);
        showExtractionIndicator(false);
    }
}

async function testConnection() {
    const apiKey = await resolveApiKey();
    if (!apiKey) {
        toastr.warning(tt`Please configure an OpenRouter API key`);
        return;
    }

    toastr.info(tt`Testing connection...`);
    try {
        const ok = await apiClient.testConnection();
        if (ok) {
            toastr.success(tt`Connection successful!`);
        } else {
            toastr.error(tt`Connection test returned unexpected response`);
        }
    } catch (err) {
        toastr.error(tt`Connection failed: ${err.message}`);
        console.error('[RP Memory] Connection test failed:', err);
    }
}

async function forceExtract() {
    const s = getSettings();
    if (!s.enabled) {
        toastr.warning(tt`RP Memory is disabled`);
        return;
    }
    const apiKey = await resolveApiKey();
    if (!apiKey) {
        toastr.warning(tt`Please configure an OpenRouter API key in Settings`);
        return;
    }

    const context = getContext();
    if (!context.chat?.length) {
        toastr.warning(tt`No chat messages to extract from`);
        return;
    }

    if (memoryStore.isExtractionInProgress()) {
        debugLog('Extraction already in progress, skipping');
        return;
    }

    memoryStore.setExtractionInProgress(true);
    showExtractionIndicator(true);

    try {
        const { chatId, characterId } = context;
        const depth = s.manualExtractionExchanges;

        let extractedCount = depth;
        if (depth > 0) {
            // Extract specific number of exchanges
            await pipeline.extractRange(context, depth);
        } else {
            // depth=0: extract unextracted exchanges (since last extraction)
            const unextracted = memoryStore.getTurnCounter() - memoryStore.getLastExtractionTurn();
            if (unextracted > 0 && memoryStore.getLastExtractionTurn() > 0) {
                // Extract only what's new since last extraction
                extractedCount = unextracted;
                await pipeline.extractRange(context, unextracted);
            } else {
                // Never extracted before — full history, chunked
                extractedCount = 0;
                await pipeline.extractFullHistory(context, (chunk, total) => {
                    showExtractionProgress(chunk, total);
                });
            }
        }
        clearDerivedAnalysis();

        // Verify context hasn't changed during extraction
        const newContext = getContext();
        if (newContext.chatId !== chatId || newContext.characterId !== characterId) {
            debugLog('Context changed during extraction, discarding');
            return;
        }

        memoryStore.setLastExtractionTurn(memoryStore.getTurnCounter());

        // Apply decay so retrospectively extracted entities get correct importance
        decayEngine.applyDecay(memoryStore, memoryStore.getTurnCounter());
        goalsManager.applyDecay(memoryStore.getTurnCounter());

        // Enforce beat cap
        if (!isRawTurnRetrievalMode()) {
            const maxBeats = s.maxBeats || 200;
            memoryStore.enforceMaxBeats(maxBeats);
        }

        // Prune low-importance events and completed/stale goals
        memoryStore.pruneEvents(6, 10);
        goalsManager.prune(memoryStore.getTurnCounter());

        // Async-mode goal analysis post-extraction (sync mode uses GENERATION_STARTED hook)
        if (s.goalsIntentEnabled && s.goalsIntentAsync) {
            const turnAtStart = memoryStore.getTurnCounter();
            const recentMsgs = getRecentMessagesForGoalAnalysis(context, s.messagesPerExtraction * 2);
            const direction = memoryStore.getAuthorDirection();

            goalsManager.analyze(recentMsgs, turnAtStart, direction).then(() => {
                if (memoryStore.getTurnCounter() !== turnAtStart) {
                    goalsManager.clearAnalysis();
                    debugLog('Goal intent analysis discarded (turn advanced)');
                    return;
                }
                injectMemoryPrompt();
                checkDirectionNudge();
                debugLog('Goal intent analysis complete (async), prompt re-injected');
            }).catch(err => {
                console.warn('[RP Memory] Goal intent analysis failed (async):', err.message);
            });
        }

        const label = extractedCount > 0 ? tt`Last ${extractedCount} exchanges extracted` : tt`Full history extracted`;
        debugLog('Manual extraction complete');
        toastr.success(label, 'RP Memory', { timeOut: 3000 });

        // Post-extraction: compress beats first, then optionally reflect (async, non-blocking)
        // Defer save/inject/render until after reflection completes to avoid double-inject
        if (reflectionEngine && !isRawTurnRetrievalMode()) {
            reflectionEngine.abort();

            reflectionEngine.compress().then(() => {
                if (reflectionEngine.shouldReflect()) {
                    return reflectionEngine.reflect();
                }
            }).then(() => {
                saveMemoryState();
                injectMemoryPrompt();
                renderMemoryUI();
                debugLog('Post-extraction tasks complete (manual)');
            }).catch(err => {
                console.warn('[RP Memory] Post-extraction tasks failed:', err.message);
                saveMemoryState();
                injectMemoryPrompt();
                renderMemoryUI();
            });
        } else {
            saveMemoryState();
            injectMemoryPrompt();
            renderMemoryUI();
        }
    } catch (err) {
        if (err?.name === 'AbortError') {
            debugLog('Manual extraction aborted by user');
            return;
        }
        console.error('[RP Memory] Manual extraction failed:', err);
        toastr.error(tt`Memory extraction failed. Check console for details.`);
    } finally {
        memoryStore.setExtractionInProgress(false);
        showExtractionIndicator(false);
    }
}

function showExtractionIndicator(visible) {
    const $status = $('#rp_memory_status');
    const $navBtn = $('.rp-mem-nav-extract-btn');

    if (visible) {
        $status.show();
        // Transform extract button into stop button
        $navBtn
            .addClass('extracting')
            .attr('title', tt`Stop Extraction`)
            .html(`<i class="fa-solid fa-spinner fa-spin"></i><span>${tt`Stop`}</span>`);
    } else {
        $status.hide();
        // Restore extract button
        $navBtn
            .removeClass('extracting')
            .attr('title', tt`Extract Now`)
            .html(`<i class="fa-solid fa-wand-magic-sparkles"></i><span>${tt`Extract`}</span>`);
    }
}

function showExtractionProgress(chunk, total) {
    const $navBtn = $('.rp-mem-nav-extract-btn');
    $navBtn.html(`<i class="fa-solid fa-spinner fa-spin"></i><span>${chunk}/${total}</span>`);
    const $status = $('#rp_memory_status');
    $status.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${tt`Extracting`} ${chunk}/${total}...`);
}

// ===================== Dynamic Model List =====================

async function loadModelList(forceRefresh = false) {
    if (cachedModelList && !forceRefresh) {
        renderModelList(cachedModelList);
        return;
    }

    const $search = $('#rp_memory_model_search');
    $search.attr('placeholder', tt`Loading models...`);

    try {
        const models = await apiClient.fetchModels();
        // Sort alphabetically by name
        models.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
        cachedModelList = models;
        renderModelList(models);
        $search.attr('placeholder', tt`Search models...`);
        // Show friendly name for current selection
        const currentVal = $('#rp_memory_model').val() || getSettings().model;
        if (currentVal) {
            const match = models.find(m => m.id === currentVal);
            $search.val(match ? match.name : currentVal);
        }
        debugLog(`Loaded ${models.length} models from OpenRouter`);
    } catch (err) {
        console.error('[RP Memory] Failed to fetch models:', err);
        $search.attr('placeholder', tt`Failed to load models`);
        toastr.warning(tt`Could not load model list from OpenRouter`);
    }
}

function renderModelList(models, filter = '') {
    const $list = $('#rp_memory_model_list');
    const currentVal = $('#rp_memory_model').val() || getSettings().model;
    const query = filter.toLowerCase().trim();

    const filtered = query
        ? models.filter(m => (m.name || '').toLowerCase().includes(query) || (m.id || '').toLowerCase().includes(query))
        : models;

    $list.empty();

    if (filtered.length === 0) {
        $list.append(`<div class="rp-mem-model-item" style="opacity:0.5;cursor:default;">${escapeHtml(tt`No models found`)}</div>`);
        return;
    }

    for (const model of filtered) {
        const pricePerMillion = parseFloat(model.promptPrice || 0) * 1_000_000;
        const priceStr = pricePerMillion < 0.01 ? 'free' : `$${pricePerMillion.toFixed(2)}/1M`;
        const isSelected = model.id === currentVal ? ' selected' : '';
        $list.append(
            `<div class="rp-mem-model-item${isSelected}" data-model-id="${escapeHtml(model.id)}">` +
            `<span class="model-name">${escapeHtml(model.name || model.id)}</span>` +
            `<span class="model-price">${escapeHtml(model.id)} &mdash; ${priceStr}</span>` +
            `</div>`,
        );
    }
}

function selectModel(modelId, modelName) {
    $('#rp_memory_model').val(modelId);
    $('#rp_memory_model_search').val(modelName || modelId);
    $('#rp_memory_model_list').removeClass('open');
    getSettings().model = modelId;
    saveSettingsDebounced();
}

function bindModelPicker() {
    const $search = $('#rp_memory_model_search');
    const $list = $('#rp_memory_model_list');

    // Open on focus — show full list if displaying current selection, otherwise filter
    $search.on('focus', function () {
        if (cachedModelList) {
            const currentId = $('#rp_memory_model').val();
            const currentModel = cachedModelList.find(m => m.id === currentId);
            const searchVal = $search.val();
            const isShowingSelection = searchVal === currentId || (currentModel && searchVal === currentModel.name);
            renderModelList(cachedModelList, isShowingSelection ? '' : searchVal);
        }
        $list.addClass('open');
    });

    // Filter as user types
    $search.on('input', function () {
        if (cachedModelList) {
            renderModelList(cachedModelList, $(this).val());
        }
        $list.addClass('open');
    });

    // Select on click
    $list.on('click', '.rp-mem-model-item[data-model-id]', function () {
        const id = $(this).data('model-id');
        const name = $(this).find('.model-name').text();
        selectModel(id, name);
    });

    // Close on click outside
    $(document).on('mousedown', function (e) {
        if (!$(e.target).closest('.rp-mem-model-search-wrapper').length) {
            $list.removeClass('open');
            // Restore display to current selection if user didn't pick
            const currentVal = $('#rp_memory_model').val();
            if (currentVal && $search.val() !== currentVal) {
                const model = cachedModelList?.find(m => m.id === currentVal);
                $search.val(model ? model.name : currentVal);
            }
        }
    });

    // Allow typing a model ID directly and pressing Enter
    $search.on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            const $first = $list.find('.rp-mem-model-item[data-model-id]').first();
            if ($first.length) {
                const id = $first.data('model-id');
                const name = $first.find('.model-name').text();
                selectModel(id, name);
            }
        } else if (e.key === 'Escape') {
            $list.removeClass('open');
            $search.blur();
        }
    });
}

// ===================== Embedding Model List =====================

async function loadEmbeddingModelList(forceRefresh = false) {
    if (cachedEmbeddingModelList && !forceRefresh) {
        populateEmbeddingModelDropdown(cachedEmbeddingModelList);
        return;
    }

    const $select = $('#rp_memory_embedding_model');
    const currentVal = $select.val() || getSettings().embeddingModel;
    $select.html('<option value="">-- Loading embedding models... --</option>');

    try {
        const models = await apiClient.fetchEmbeddingModels();
        cachedEmbeddingModelList = models;
        populateEmbeddingModelDropdown(models, currentVal);
        debugLog(`Loaded ${models.length} embedding models from OpenRouter`);
    } catch (err) {
        console.error('[RP Memory] Failed to fetch embedding models:', err);
        $select.html(`<option value="${escapeHtml(currentVal)}">${escapeHtml(currentVal)}</option>`);
        toastr.warning(tt`Could not load embedding model list from OpenRouter`);
    }
}

function populateEmbeddingModelDropdown(models, preserveValue) {
    const $select = $('#rp_memory_embedding_model');
    const currentVal = preserveValue || $select.val() || getSettings().embeddingModel;
    $select.empty();

    for (const model of models) {
        let label = model.name || model.id;
        if (model.promptPrice) {
            const pricePerMillion = parseFloat(model.promptPrice) * 1_000_000;
            const priceStr = pricePerMillion < 0.01 ? 'free' : `$${pricePerMillion.toFixed(2)}/1M`;
            label += ` (${priceStr})`;
        }
        $select.append(`<option value="${escapeHtml(model.id)}">${escapeHtml(label)}</option>`);
    }

    if (currentVal && $select.find(`option[value="${CSS.escape(currentVal)}"]`).length) {
        $select.val(currentVal);
    } else if (models.length > 0) {
        if (currentVal) {
            $select.prepend(`<option value="${escapeHtml(currentVal)}">${escapeHtml(currentVal)} (saved)</option>`);
            $select.val(currentVal);
        }
    }
}

/**
 * Populate the goals intent model dropdown, reusing the cached model list.
 */
function populateGoalsIntentModelDropdown() {
    const $select = $('#rp_memory_goals_intent_model');
    const currentVal = $select.val() || getSettings().goalsIntentModel || '';
    $select.empty();

    // First option: use extraction model (empty value)
    $select.append(`<option value="">${escapeHtml(tt`Use extraction model`)}</option>`);

    const models = cachedModelList;
    if (!models || models.length === 0) {
        // Try to load models if not cached
        loadModelList().then(() => populateGoalsIntentModelDropdown());
        return;
    }

    for (const model of models) {
        const pricePerMillion = parseFloat(model.promptPrice || 0) * 1_000_000;
        const priceStr = pricePerMillion < 0.01 ? 'free' : `$${pricePerMillion.toFixed(2)}/1M`;
        const label = `${model.name || model.id} — ${priceStr}`;
        $select.append(`<option value="${escapeHtml(model.id)}">${escapeHtml(label)}</option>`);
    }

    if (currentVal) {
        if ($select.find(`option[value="${CSS.escape(currentVal)}"]`).length) {
            $select.val(currentVal);
        } else {
            $select.prepend(`<option value="${escapeHtml(currentVal)}">${escapeHtml(currentVal)} (saved)</option>`);
            $select.val(currentVal);
        }
    }
}

function truncateDirectionText(text, maxLength = 96) {
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function getFallbackDirectionSuggestions() {
    return [
        {
            id: 'raise-stakes',
            label: tt`Raise stakes`,
            text: tt`Escalate tension and push the scene toward sharper consequences or confrontation.`,
        },
        {
            id: 'slow-for-emotion',
            label: tt`Slow for emotion`,
            text: tt`Slow the pace and focus on emotional reactions, subtext, and character vulnerability.`,
        },
        {
            id: 'let-npc-lead',
            label: tt`Let NPC lead`,
            text: tt`Give the other character more initiative so the next turn changes the scene instead of only reacting.`,
        },
        {
            id: 'more-texture',
            label: tt`More texture`,
            text: tt`Lean into sensory detail and atmosphere so the scene feels more embodied and vivid.`,
        },
    ];
}

function getDirectionSuggestionsForUI() {
    const currentTurn = memoryStore?.getTurnCounter?.() || 0;
    const suggestions = goalsManager?.getDirectionSuggestions?.(currentTurn) || [];
    return suggestions.length > 0 ? suggestions : getFallbackDirectionSuggestions();
}

function persistAuthorDirection(direction) {
    if (!memoryStore) return;

    if (!direction?.text?.trim()) {
        clearAuthorDirection();
        return;
    }

    memoryStore.setAuthorDirection({
        ...direction,
        updatedTurn: memoryStore.getTurnCounter(),
    });
    saveMemoryState();
    injectMemoryPrompt();
    renderDirectionButton();
    dismissDirectionNudge();
    debugLog('Author direction updated:', memoryStore.getAuthorDirection());
}

function clearAuthorDirection() {
    if (!memoryStore) return;
    memoryStore.clearAuthorDirection();
    saveMemoryState();
    injectMemoryPrompt();
    renderDirectionButton();
    debugLog('Author direction cleared');
}

function renderDirectionButton() {
    const $btn = $('.rp-mem-nav-direction-btn');
    if (!$btn.length || !memoryStore?.getAuthorDirection) return;

    const direction = memoryStore.getAuthorDirection();
    const isActive = Boolean(direction?.mode !== 'auto' && direction?.text?.trim());
    const summary = direction?.label || truncateDirectionText(direction?.text || '', 72);

    const currentTurn = memoryStore.getTurnCounter();
    const directionUpdatedTurn = Number.isFinite(direction?.updatedTurn) ? direction.updatedTurn : -1;
    const shouldPivot = isActive
        && directionUpdatedTurn < currentTurn
        && goalsManager?.shouldNudgeDirection?.(currentTurn);

    $btn.toggleClass('active', isActive);
    $btn.toggleClass('stale', shouldPivot);
    $btn.attr('title', shouldPivot
        ? tt`Scene direction (stale): ${summary}`
        : isActive
            ? tt`Scene direction: ${summary}`
            : tt`Scene direction`);
}

// ===================== Direction Staleness Nudge =====================

/**
 * Check whether the current author direction is stale and fresh suggestions
 * are available. If so, surface a compact nudge bar above the nav.
 */
function checkDirectionNudge() {
    if (!memoryStore || !goalsManager) return;

    const currentTurn = memoryStore.getTurnCounter();
    const direction = memoryStore.getAuthorDirection();
    const directionUpdatedTurn = Number.isFinite(direction?.updatedTurn) ? direction.updatedTurn : -1;
    if (direction?.mode !== 'auto' && directionUpdatedTurn >= currentTurn) return;
    if (!goalsManager.shouldNudgeDirection(currentTurn)) return;

    const chatId = getContext()?.chatId;
    const dismissedTurn = chatId ? (directionNudgeDismissals.get(chatId) ?? -1) : -1;
    if (dismissedTurn >= currentTurn) return;

    const suggestions = goalsManager.getDirectionSuggestions(currentTurn);
    if (suggestions.length === 0) return;

    renderDirectionNudge(suggestions);
}

function renderDirectionNudge(suggestions) {
    // Don't stack nudges
    if ($('.rp-mem-direction-nudge').length) return;
    // Don't nudge while overlays are open
    if ($('.rp-mem-direction-overlay').length) return;

    const chipsHtml = suggestions.slice(0, 4).map(s => `
        <div class="rp-mem-nudge-chip"
             data-direction-id="${escapeHtml(s.id)}"
             data-direction-label="${escapeHtml(s.label)}"
             data-direction-text="${escapeHtml(s.text)}"
             title="${escapeHtml(s.text)}">
            ${escapeHtml(s.label)}
        </div>`).join('');

    const html = `
    <div class="rp-mem-direction-nudge">
        <div class="rp-mem-nudge-text">${tt`Scene has evolved — consider a new direction:`}</div>
        <div class="rp-mem-nudge-chips">${chipsHtml}</div>
        <div class="rp-mem-nudge-dismiss" title="${escapeHtml(tt`Dismiss`)}"><i class="fa-solid fa-xmark"></i></div>
    </div>`;

    const $wrapper = $('.rp-mem-wrapper');
    if (!$wrapper.length) return;
    $wrapper.find('.rp-mem-nav').before(html);

    const $nudge = $wrapper.find('.rp-mem-direction-nudge');

    $nudge.on('click', '.rp-mem-nudge-chip', function () {
        const suggestion = {
            mode: 'suggested',
            source: 'suggested',
            suggestionId: $(this).data('direction-id'),
            label: $(this).data('direction-label'),
            text: $(this).data('direction-text'),
        };
        persistAuthorDirection(suggestion);
        $nudge.remove();
        debugLog('Direction nudge accepted:', suggestion.label);
    });

    $nudge.on('click', '.rp-mem-nudge-dismiss', function () {
        const chatId = getContext()?.chatId;
        if (chatId) {
            directionNudgeDismissals.set(chatId, memoryStore.getTurnCounter());
        }
        $nudge.remove();
        debugLog('Direction nudge dismissed');
    });
}

function dismissDirectionNudge() {
    $('.rp-mem-direction-nudge').remove();
}

// ===================== Floating Nav + Data Panel =====================

const CATEGORY_DEFS = [
    { key: 'mainCharacter', icon: 'fa-user', labelKey: 'MC' },
    { key: 'characters', icon: 'fa-users', labelKey: 'NPCs' },
    { key: 'locations', icon: 'fa-map-location-dot', labelKey: 'Loc' },
    { key: 'goals', icon: 'fa-bullseye', labelKey: 'Goals' },
    { key: 'events', icon: 'fa-timeline', labelKey: 'Events' },
    { key: 'changes', icon: 'fa-clock-rotate-left', labelKey: 'Changes' },
    { key: 'beats', icon: 'fa-bolt', labelKey: 'Beats' },
    { key: 'reflections', icon: 'fa-lightbulb', labelKey: 'Reflect' },
];

function getCategoryLabel(key) {
    const labels = {
        mainCharacter: tt`Main Character`,
        characters: tt`Characters (NPCs)`,
        locations: tt`Locations`,
        goals: tt`Goals / Tasks`,
        events: tt`Events`,
        changes: tt`Recent Changes`,
        beats: tt`Story Beats`,
        reflections: tt`Reflections`,
    };
    return labels[key] || key;
}

/**
 * Initialize the bottom-docked floating UI (nav bar + data panel).
 * Inserted into #sheld before #form_sheld.
 */
function initFloatingUI() {
    // Don't double-init
    if ($('.rp-mem-wrapper').length) return;

    const counts = memoryStore ? memoryStore.getCounts() : {};

    // Build category buttons
    const catButtons = CATEGORY_DEFS.map(cat => {
        const count = counts[cat.key] || 0;
        return `<div class="rp-mem-nav-btn" data-category="${cat.key}" title="${escapeHtml(getCategoryLabel(cat.key))}">
            <i class="fa-solid ${cat.icon}"></i>
            <span>${escapeHtml(tl(cat.labelKey))}</span>
            <span class="rp-mem-nav-count" data-nav-count="${cat.key}">${count}</span>
        </div>`;
    }).join('');

    const html = `
    <div class="rp-mem-wrapper">
        <div class="rp-mem-data-panel hidden"></div>
        <div class="rp-mem-nav collapsed">
            <i class="fa-solid fa-chevron-up rp-mem-nav-collapse-btn" title="${escapeHtml(tt`Expand / Collapse`)}"></i>
            <span class="rp-mem-nav-pill-label">${tt`RP Memory`}</span>
            <div class="rp-mem-nav-buttons">${catButtons}</div>
            <div class="rp-mem-nav-sep"></div>
            <div class="rp-mem-nav-actions">
                <div class="rp-mem-nav-btn rp-mem-nav-direction-btn" title="${escapeHtml(tt`Scene direction`)}">
                    <i class="fa-solid fa-compass"></i>
                    <span>${tt`Guide`}</span>
                </div>
                <div class="rp-mem-nav-btn rp-mem-nav-ooc-btn" title="${escapeHtml(tt`Author correction`)}">
                    <i class="fa-solid fa-pen-to-square"></i>
                    <span>OOC</span>
                </div>
                <div class="rp-mem-nav-btn rp-mem-nav-extract-btn" title="${escapeHtml(tt`Extract Now`)}">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>${tt`Extract`}</span>
                </div>
                <div class="rp-mem-nav-btn rp-mem-nav-settings-btn" title="${escapeHtml(tt`Open Settings`)}">
                    <i class="fa-solid fa-gear"></i>
                </div>
            </div>
        </div>
    </div>`;

    const $sheld = $('#sheld');
    const $formSheld = $('#form_sheld');

    if ($formSheld.length) {
        $formSheld.before(html);
    } else {
        $sheld.append(html);
    }

    // Bind nav events
    bindFloatingNavListeners();
    renderDirectionButton();

    debugLog('Floating UI initialized (collapsed)');
}

function bindFloatingNavListeners() {
    const $wrapper = $('.rp-mem-wrapper');

    // Collapse/expand toggle — clicking pill label or collapse button
    $wrapper.on('click', '.rp-mem-nav.collapsed', function (e) {
        // Clicking anywhere on the collapsed pill expands it
        toggleNavCollapse();
    });

    $wrapper.on('click', '.rp-mem-nav-collapse-btn', function (e) {
        e.stopPropagation();
        toggleNavCollapse();
    });

    // Category button click
    $wrapper.on('click', '.rp-mem-nav-btn[data-category]', function (e) {
        e.stopPropagation();
        const category = $(this).data('category');
        showCategoryPanel(category);
    });

    // Extract / Stop button
    $wrapper.on('click', '.rp-mem-nav-extract-btn', function (e) {
        e.stopPropagation();
        if (memoryStore.isExtractionInProgress()) {
            pipeline.abort();
            toastr.info(tt`Extraction stopped`, 'RP Memory', { timeOut: 2000 });
        } else {
            forceExtract();
        }
    });

    // Direction button — toggle direction input overlay
    $wrapper.on('click', '.rp-mem-nav-direction-btn', function (e) {
        e.stopPropagation();
        toggleDirectionOverlay();
    });

    // OOC button — toggle OOC input overlay
    $wrapper.on('click', '.rp-mem-nav-ooc-btn', function (e) {
        e.stopPropagation();
        toggleOOCOverlay();
    });

    // Settings button — open sidebar drawer
    $wrapper.on('click', '.rp-mem-nav-settings-btn', function (e) {
        e.stopPropagation();
        // Open the extensions panel and scroll to our section
        const $drawer = $('#rp_memory_settings .inline-drawer-toggle');
        if ($drawer.length) {
            // Open extensions panel if not already open
            if (!$('#extensions_settings2').is(':visible')) {
                $('#extensionsMenuButton').trigger('click');
            }
            // Expand our drawer
            setTimeout(() => {
                if (!$drawer.parent().find('.inline-drawer-content').is(':visible')) {
                    $drawer.trigger('click');
                }
                $drawer[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 200);
        }
    });

    // Card click (in data panel) → open edit overlay
    $wrapper.on('click', '.rp-mem-card', function () {
        const category = $(this).data('category');
        const entityId = $(this).data('id');
        openCardEditOverlay(category, entityId);
    });

    // Add button in data panel
    $wrapper.on('click', '.rp-mem-panel-add-btn', function (e) {
        e.stopPropagation();
        const category = $(this).data('category');
        openAddEntityDialog(category);
    });
}

function toggleNavCollapse() {
    const $nav = $('.rp-mem-nav');
    const isCollapsed = $nav.hasClass('collapsed');

    if (isCollapsed) {
        $nav.removeClass('collapsed');
    } else {
        $nav.addClass('collapsed');
        // Also hide the data panel
        hideDataPanel();
    }
}

function showCategoryPanel(category) {
    const $panel = $('.rp-mem-data-panel');

    if (activePanelCategory === category) {
        // Toggle off
        hideDataPanel();
        return;
    }

    // Deactivate previous button, activate new one
    $('.rp-mem-nav-btn[data-category]').removeClass('active');
    $(`.rp-mem-nav-btn[data-category="${category}"]`).addClass('active');

    activePanelCategory = category;
    renderPanelCards(category);
    $panel.removeClass('hidden');
}

function hideDataPanel() {
    $('.rp-mem-data-panel').addClass('hidden');
    $('.rp-mem-nav-btn[data-category]').removeClass('active');
    activePanelCategory = null;
}

function renderPanelCards(category) {
    const $panel = $('.rp-mem-data-panel');
    $panel.empty();

    const title = getCategoryLabel(category);
    $panel.append(`<div class="rp-mem-data-panel-title">${escapeHtml(title)}</div>`);

    if (category === 'changes') {
        const changes = memoryStore.getRecentChanges(40);
        if (changes.length === 0) {
            $panel.append(`<div class="rp-mem-empty-state">${escapeHtml(tt`No recent changes`)}</div>`);
        } else {
            const $stack = $('<div class="rp-mem-change-stack"></div>');
            for (const [index, change] of changes.entries()) {
                $stack.append(buildRecentChangeCardHtml(change, index === 0));
            }
            $panel.append($stack);
        }
        return;
    }

    // Special handling for beats (read-only timeline)
    if (category === 'beats') {
        const beats = memoryStore.getRecentBeats(50);
        if (beats.length === 0) {
            $panel.append(`<div class="rp-mem-empty-state">${escapeHtml(tt`No beats recorded yet`)}</div>`);
        } else {
            const $grid = $('<div class="rp-mem-card-grid"></div>');
            for (const beat of beats) {
                $grid.append(buildBeatCardHtml(beat));
            }
            $panel.append($grid);
        }
        return;
    }

    // Special handling for reflections (read-only)
    if (category === 'reflections') {
        const reflections = memoryStore.getRecentReflections(20);
        if (reflections.length === 0) {
            $panel.append(`<div class="rp-mem-empty-state">${escapeHtml(tt`No reflections yet`)}</div>`);
        } else {
            const $grid = $('<div class="rp-mem-card-grid"></div>');
            for (const ref of reflections) {
                $grid.append(buildReflectionCardHtml(ref));
            }
            $panel.append($grid);
        }
        return;
    }

    const entities = memoryStore.getAllEntities(category);
    const entityList = Object.values(entities);

    if (entityList.length === 0) {
        $panel.append(`<div class="rp-mem-empty-state">${escapeHtml(tt`No entries yet`)}</div>`);
    } else {
        // Sort: pinned (tier 1) first, then by importance descending
        entityList.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));

        const $grid = $('<div class="rp-mem-card-grid"></div>');
        for (const entity of entityList) {
            $grid.append(buildCardHtml(category, entity));
        }
        $panel.append($grid);
    }

    // Add button
    $panel.append(`
        <div class="rp-mem-panel-add-btn" data-category="${category}">
            <i class="fa-solid fa-plus"></i>
            <span>${tt`Add`} ${escapeHtml(title)}</span>
        </div>
    `);
}

function buildCardHtml(category, entity) {
    const tierLabel = { 1: tt`Pinned`, 2: tt`Active`, 3: tt`Archived` };
    const tierClass = entity.tier === 1 ? 'tier-pinned' : (entity.tier === 3 ? 'tier-archived' : '');

    // Build grid items from fields
    let gridItems = '';
    if (entity.fields) {
        for (const [key, value] of Object.entries(entity.fields)) {
            if (value === null || value === undefined || value === '') continue;
            if (Array.isArray(value) && value.length === 0) continue;
            if (typeof value === 'object' && !Array.isArray(value) && !('value' in value) && Object.keys(value).length === 0) continue;

            const rawLabel = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
            const label = tl(rawLabel);
            const displayVal = displayStr(value);
            if (!displayVal) continue;

            gridItems += `
                <div class="rp-mem-grid-item">
                    <div class="rp-mem-grid-item-label">${escapeHtml(label)}</div>
                    <div class="rp-mem-grid-item-value" title="${escapeHtml(displayVal)}">${escapeHtml(displayVal)}</div>
                </div>`;
        }
    }

    return `
    <div class="rp-mem-card ${tierClass}" data-category="${category}" data-id="${entity.id}">
        <div class="rp-mem-card-header">
            <span class="rp-mem-card-name">${escapeHtml(entity.name)}</span>
            <span class="rp-mem-card-tier">${tierLabel[entity.tier] || '?'}</span>
            <span class="rp-mem-card-importance">${entity.importance}</span>
        </div>
        <div class="rp-mem-card-body">
            ${gridItems || `<span class="rp-mem-empty-state" style="padding:4px;font-size:0.8em;">${escapeHtml(tt`No details`)}</span>`}
        </div>
    </div>`;
}

function buildBeatCardHtml(beat) {
    const typeLabels = {
        conflict: '⚔️', discovery: '🔍', relationship: '💬',
        decision: '⚖️', transition: '➡️', revelation: '💡', consequence: '🔗',
    };
    const typeIcon = typeLabels[beat.type] || '📝';
    const participants = (beat.participants || []).join(', ');
    const compressed = beat.compressed ? ' <span style="opacity:0.5">[summarized]</span>' : '';

    return `
    <div class="rp-mem-card" style="cursor:default;">
        <div class="rp-mem-card-header">
            <span class="rp-mem-card-name">${typeIcon} ${escapeHtml(tt`Turn`)} ${beat.storyTurn}${compressed}</span>
            <span class="rp-mem-card-importance">${beat.importance}</span>
        </div>
        <div class="rp-mem-card-body">
            <div class="rp-mem-grid-item">
                <div class="rp-mem-grid-item-value" title="${escapeHtml(beat.text)}">${escapeHtml(beat.text)}</div>
            </div>
            ${participants ? `<div class="rp-mem-grid-item"><div class="rp-mem-grid-item-label">${escapeHtml(tt`Participants`)}</div><div class="rp-mem-grid-item-value">${escapeHtml(participants)}</div></div>` : ''}
        </div>
    </div>`;
}

function buildReflectionCardHtml(ref) {
    const typeLabels = {
        relationship: '💬', plot_thread: '📖',
        character_arc: '🎭', world_state: '🌍',
    };
    const typeIcon = typeLabels[ref.type] || '💡';
    const participants = (ref.participants || []).join(', ');

    // Show horizon/branch tags if present
    const horizonTag = ref.horizon ? `[${ref.horizon}]` : '';
    const branchTag = ref.branch ? `${ref.branch}` : '';
    const metaInfo = [horizonTag, branchTag].filter(Boolean).join(' ');

    return `
    <div class="rp-mem-card" style="cursor:default;">
        <div class="rp-mem-card-header">
            <span class="rp-mem-card-name">${typeIcon} ${escapeHtml(ref.type || 'observation')}${metaInfo ? ` <span style="opacity:0.6;font-size:0.85em">${escapeHtml(metaInfo)}</span>` : ''}</span>
            <span class="rp-mem-card-tier">${escapeHtml(tt`Turn`)} ${ref.storyTurn}</span>
            <span class="rp-mem-card-importance">${ref.importance}</span>
        </div>
        <div class="rp-mem-card-body">
            <div class="rp-mem-grid-item">
                <div class="rp-mem-grid-item-value" title="${escapeHtml(ref.text)}">${escapeHtml(ref.text)}</div>
            </div>
            ${participants ? `<div class="rp-mem-grid-item"><div class="rp-mem-grid-item-label">${escapeHtml(tt`Participants`)}</div><div class="rp-mem-grid-item-value">${escapeHtml(participants)}</div></div>` : ''}
        </div>
    </div>`;
}

function updateFloatingNavCounts() {
    if (!memoryStore) return;
    const counts = memoryStore.getCounts();
    for (const [cat, count] of Object.entries(counts)) {
        $(`.rp-mem-nav-count[data-nav-count="${cat}"]`).text(count);
    }
}

/**
 * Open a fullscreen edit overlay for an entity.
 */
function openCardEditOverlay(category, entityId) {
    const entity = memoryStore.getEntity(category, entityId);
    if (!entity) {
        debugLog('Edit overlay: entity not found', category, entityId);
        return;
    }

    // Remove existing overlay if any
    $('.rp-mem-edit-overlay').remove();

    const defs = FIELD_DEFS[category] || [];
    const fields = entity.fields || {};

    // Build field inputs
    let fieldInputs = '';
    for (const def of defs) {
        let inputHtml = '';

        // Handle meta fields (like aliases) that aren't in entity.fields
        if (def.meta && def.key === '_aliases') {
            const aliasVal = (entity.aliases || []).join(', ');
            inputHtml = `<input type="text" data-edit-field="${def.key}" value="${escapeHtml(aliasVal)}" />`;
        } else {
            const rawValue = fields[def.key];

            switch (def.type) {
                case 'textarea': {
                    const val = displayStr(rawValue);
                    inputHtml = `<textarea data-edit-field="${def.key}">${escapeHtml(val)}</textarea>`;
                    break;
                }
                case 'text': {
                    const val = displayStr(rawValue);
                    inputHtml = `<input type="text" data-edit-field="${def.key}" value="${escapeHtml(val)}" />`;
                    break;
                }
                case 'number': {
                    const val = displayStr(rawValue) || 0;
                    inputHtml = `<input type="number" data-edit-field="${def.key}" value="${val}" />`;
                    break;
                }
                case 'select': {
                    const displayVal = displayStr(rawValue);
                    const opts = (def.options || []).map(o =>
                        `<option value="${o.value}" ${displayVal === o.value ? 'selected' : ''}>${escapeHtml(tl(o.label))}</option>`,
                    ).join('');
                    inputHtml = `<select data-edit-field="${def.key}">${opts}</select>`;
                    break;
                }
            }
        }

        fieldInputs += `
            <div class="rp-mem-edit-dialog-row">
                <label>${escapeHtml(tl(def.label))}</label>
                ${inputHtml}
            </div>`;
    }

    const overlayHtml = `
    <div class="rp-mem-edit-overlay">
        <div class="rp-mem-edit-dialog" data-category="${category}" data-id="${entityId}">
            <div class="rp-mem-edit-dialog-title">${escapeHtml(entity.name)}</div>

            <div class="rp-mem-edit-dialog-meta">
                <div class="rp-mem-edit-dialog-row">
                    <label>${tt`Name`}</label>
                    <input type="text" class="rp-mem-overlay-name" value="${escapeHtml(entity.name)}" />
                </div>
                <div class="rp-mem-edit-dialog-row">
                    <label>${tt`Tier`}</label>
                    <select class="rp-mem-overlay-tier">
                        <option value="1" ${entity.tier === 1 ? 'selected' : ''}>${tt`Pinned`}</option>
                        <option value="2" ${entity.tier === 2 ? 'selected' : ''}>${tt`Active`}</option>
                        <option value="3" ${entity.tier === 3 ? 'selected' : ''}>${tt`Archived`}</option>
                    </select>
                </div>
                <div class="rp-mem-edit-dialog-row">
                    <label>${tt`Importance`}</label>
                    <input type="number" class="rp-mem-overlay-importance" min="1" max="10" step="0.5" value="${entity.importance}" />
                </div>
            </div>

            ${fieldInputs}

            <div class="rp-mem-edit-dialog-actions">
                <div class="menu_button rp-mem-dialog-save"><i class="fa-solid fa-check"></i> ${tt`Save`}</div>
                <div class="menu_button rp-mem-dialog-cancel"><i class="fa-solid fa-xmark"></i> ${tt`Cancel`}</div>
                <div class="menu_button rp-mem-dialog-delete"><i class="fa-solid fa-trash"></i> ${tt`Delete`}</div>
            </div>
        </div>
    </div>`;

    $('body').append(overlayHtml);

    // Focus name input
    $('.rp-mem-overlay-name').focus().select();

    // Bind overlay events
    bindEditOverlayListeners();
}

function bindEditOverlayListeners() {
    const $overlay = $('.rp-mem-edit-overlay');

    // Save
    $overlay.on('click', '.rp-mem-dialog-save', function () {
        saveOverlayEdits();
    });

    // Cancel
    $overlay.on('click', '.rp-mem-dialog-cancel', function () {
        closeEditOverlay();
    });

    // Delete
    $overlay.on('click', '.rp-mem-dialog-delete', async function () {
        const $dialog = $('.rp-mem-edit-dialog');
        const category = $dialog.data('category');
        const entityId = $dialog.data('id');
        const entity = memoryStore.getEntity(category, entityId);
        if (!entity) return;

        const entityName = escapeHtml(entity.name);
        const result = await Popup.show.confirm(
            tt`Delete "${entityName}"?`,
            tt`This will remove the entity from memory.`,
        );

        if (result === POPUP_RESULT.AFFIRMATIVE) {
            const beforeSnapshot = JSON.parse(JSON.stringify(entity));
            memoryStore.deleteEntity(category, entityId);
            clearDerivedAnalysis();
            recordEntityChangeFromSnapshots(category, beforeSnapshot, null, 'manual', 'deleted');
            saveMemoryState();
            injectMemoryPrompt();
            renderMemoryUI();
            closeEditOverlay();
        }
    });

    // Backdrop click
    $overlay.on('click', function (e) {
        if ($(e.target).is('.rp-mem-edit-overlay')) {
            closeEditOverlay();
        }
    });

    // Escape key
    $(document).on('keydown.rpMemOverlay', function (e) {
        if (e.key === 'Escape' && $('.rp-mem-edit-overlay').length) {
            closeEditOverlay();
        }
    });
}

function saveOverlayEdits() {
    const $dialog = $('.rp-mem-edit-dialog');
    const category = $dialog.data('category');
    const entityId = $dialog.data('id');
    const entity = memoryStore.getEntity(category, entityId);
    if (!entity) return;

    const updatedName = $dialog.find('.rp-mem-overlay-name').val()?.trim() || entity.name;
    const updatedTier = parseInt($dialog.find('.rp-mem-overlay-tier').val()) || entity.tier;
    const updatedImportance = parseFloat($dialog.find('.rp-mem-overlay-importance').val()) || entity.importance;
    const updatedFields = readOverlayFields($dialog, category, entity.fields);
    const beforeSnapshot = JSON.parse(JSON.stringify(entity));

    // Read aliases from meta field
    const $aliasInput = $dialog.find('[data-edit-field="_aliases"]');
    let updatedAliases = entity.aliases || [];
    if ($aliasInput.length) {
        const aliasStr = $aliasInput.val() || '';
        updatedAliases = aliasStr.split(',').map(a => a.trim()).filter(Boolean);
    }

    memoryStore.updateEntity(category, entityId, {
        name: updatedName,
        aliases: updatedAliases,
        tier: updatedTier,
        importance: updatedImportance,
        baseScore: updatedImportance,
        fields: updatedFields,
        source: 'manual',
    });

    // Invalidate embedding cache
    if (embeddingService) {
        embeddingService.invalidateEntity(category, entityId);
    }

    clearDerivedAnalysis();
    recordEntityChangeFromSnapshots(category, beforeSnapshot, memoryStore.getEntity(category, entityId), 'manual', 'updated');
    saveMemoryState();
    injectMemoryPrompt();
    renderMemoryUI();
    closeEditOverlay();
    debugLog('Entity updated via overlay edit:', category, entityId);
}

function readOverlayFields($dialog, category, existingFields) {
    const defs = FIELD_DEFS[category] || [];
    const currentTurn = memoryStore.getTurnCounter();
    const fields = JSON.parse(JSON.stringify(existingFields || {}));

    for (const def of defs) {
        // Skip meta fields (handled separately)
        if (def.meta) continue;

        const $input = $dialog.find(`[data-edit-field="${def.key}"]`);
        if (!$input.length) continue;

        let value;
        switch (def.type) {
            case 'number':
                value = parseInt($input.val()) || 0;
                break;
            default:
                value = $input.val() || '';
        }

        // Wrap string values with provenance
        if (typeof value === 'string') {
            fields[def.key] = wrapField(value, currentTurn);
        } else {
            fields[def.key] = value;
        }
    }

    return fields;
}

function closeEditOverlay() {
    $('.rp-mem-edit-overlay').remove();
    $(document).off('keydown.rpMemOverlay');
}

// ===================== Direction Control =====================

function toggleDirectionOverlay() {
    const $existing = $('.rp-mem-direction-overlay');
    if ($existing.length) {
        $existing.remove();
        return;
    }

    $('.rp-mem-ooc-overlay').remove();
    dismissDirectionNudge();

    const current = memoryStore?.getAuthorDirection?.() || {};
    const suggestions = getDirectionSuggestionsForUI();
    const activeSuggestionId = current.mode === 'suggested' ? current.suggestionId : '';
    const suggestionHtml = suggestions.map((suggestion) => {
        const activeClass = activeSuggestionId === suggestion.id ? ' active' : '';
        return `
        <div class="rp-mem-direction-suggestion${activeClass}"
             data-direction-id="${escapeHtml(suggestion.id)}"
             data-direction-label="${escapeHtml(suggestion.label)}"
             data-direction-text="${escapeHtml(suggestion.text)}">
            <div class="rp-mem-direction-suggestion-label">${escapeHtml(suggestion.label)}</div>
            <div class="rp-mem-direction-suggestion-text">${escapeHtml(suggestion.text)}</div>
        </div>`;
    }).join('');

    const sourceLabel = current.mode === 'suggested'
        ? tt`Suggested`
        : current.mode === 'custom'
            ? tt`Custom`
            : tt`Auto`;
    const summary = current.text ? truncateDirectionText(current.text, 120) : tt`No active direction`;

    const overlayHtml = `
    <div class="rp-mem-direction-overlay" data-selected-suggestion-id="${escapeHtml(activeSuggestionId)}">
        <div class="rp-mem-direction-header">
            <div>
                <div class="rp-mem-direction-title">${tt`Scene direction`}</div>
                <div class="rp-mem-direction-subtitle">${tt`Steers future turns only — not canon memory`}</div>
            </div>
            <div class="rp-mem-direction-status">
                <span class="rp-mem-direction-status-label">${escapeHtml(sourceLabel)}</span>
                <span class="rp-mem-direction-status-text">${escapeHtml(summary)}</span>
            </div>
        </div>

        <div class="rp-mem-direction-suggestions-label">${tt`Suggested directions`}</div>
        <div class="rp-mem-direction-suggestions">${suggestionHtml}</div>

        <textarea class="rp-mem-direction-input" placeholder="${escapeHtml(tt`e.g., keep it slow-burn, let Kira take the lead, and make the tension feel dangerous`)}" rows="3">${escapeHtml(current.text || '')}</textarea>
        <div class="rp-mem-direction-hint">${tt`Click a suggestion to apply it immediately, or write your own direction and save it.`}</div>

        <div class="rp-mem-direction-actions">
            <div class="menu_button rp-mem-direction-save"><i class="fa-solid fa-check"></i> ${tt`Apply`}</div>
            <div class="menu_button rp-mem-direction-clear"><i class="fa-solid fa-eraser"></i> ${tt`Clear`}</div>
            <div class="menu_button rp-mem-direction-cancel"><i class="fa-solid fa-xmark"></i> ${tt`Cancel`}</div>
        </div>
    </div>`;

    const $wrapper = $('.rp-mem-wrapper');
    $wrapper.find('.rp-mem-nav').before(overlayHtml);

    const $overlay = $wrapper.find('.rp-mem-direction-overlay');
    $overlay.find('.rp-mem-direction-input').focus().select();

    $overlay.on('click', '.rp-mem-direction-suggestion', function () {
        const suggestion = {
            mode: 'suggested',
            source: 'suggested',
            suggestionId: $(this).data('direction-id'),
            label: $(this).data('direction-label'),
            text: $(this).data('direction-text'),
        };

        persistAuthorDirection(suggestion);
        $overlay.attr('data-selected-suggestion-id', suggestion.suggestionId);
        $overlay.find('.rp-mem-direction-input').val(suggestion.text);
        $overlay.find('.rp-mem-direction-suggestion').removeClass('active');
        $(this).addClass('active');
        $overlay.find('.rp-mem-direction-status-label').text(tt`Suggested`);
        $overlay.find('.rp-mem-direction-status-text').text(truncateDirectionText(suggestion.text, 120));
    });

    $overlay.on('click', '.rp-mem-direction-save', function () {
        const text = $overlay.find('.rp-mem-direction-input').val().trim();
        if (!text) {
            clearAuthorDirection();
            $overlay.remove();
            return;
        }

        const selectedSuggestionId = $overlay.attr('data-selected-suggestion-id') || '';
        const selectedSuggestion = suggestions.find(suggestion => suggestion.id === selectedSuggestionId);
        if (selectedSuggestion && selectedSuggestion.text === text) {
            persistAuthorDirection({
                mode: 'suggested',
                source: 'suggested',
                text: selectedSuggestion.text,
                label: selectedSuggestion.label,
                suggestionId: selectedSuggestion.id,
            });
        } else {
            persistAuthorDirection({
                mode: 'custom',
                source: 'custom',
                text,
                label: '',
                suggestionId: '',
            });
        }
        $overlay.remove();
    });

    $overlay.on('click', '.rp-mem-direction-clear', function () {
        clearAuthorDirection();
        $overlay.remove();
    });

    $overlay.on('click', '.rp-mem-direction-cancel', function () {
        $overlay.remove();
    });

    $overlay.on('keydown', '.rp-mem-direction-input', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            $overlay.find('.rp-mem-direction-save').trigger('click');
        }
        if (e.key === 'Escape') {
            $overlay.remove();
        }
    });
}

// ===================== OOC Correction =====================

let pendingOOCCleanup = false;

function toggleOOCOverlay() {
    const $existing = $('.rp-mem-ooc-overlay');
    if ($existing.length) {
        $existing.remove();
        return;
    }

    $('.rp-mem-direction-overlay').remove();

    const overlayHtml = `
    <div class="rp-mem-ooc-overlay">
        <textarea class="rp-mem-ooc-input" placeholder="${escapeHtml(tt`e.g., Kira's hair should be green, rewrite this`)}" rows="2"></textarea>
        <div class="rp-mem-ooc-actions">
            <div class="menu_button rp-mem-ooc-submit"><i class="fa-solid fa-check"></i> ${tt`Submit`}</div>
            <div class="menu_button rp-mem-ooc-cancel"><i class="fa-solid fa-xmark"></i> ${tt`Cancel`}</div>
        </div>
    </div>`;

    const $wrapper = $('.rp-mem-wrapper');
    $wrapper.find('.rp-mem-nav').before(overlayHtml);

    const $overlay = $wrapper.find('.rp-mem-ooc-overlay');
    $overlay.find('.rp-mem-ooc-input').focus();

    $overlay.on('click', '.rp-mem-ooc-submit', function () {
        const text = $overlay.find('.rp-mem-ooc-input').val().trim();
        $overlay.remove();
        if (text) handleOOCSubmit(text);
    });

    $overlay.on('click', '.rp-mem-ooc-cancel', function () {
        $overlay.remove();
    });

    $overlay.on('keydown', '.rp-mem-ooc-input', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const text = $(this).val().trim();
            $overlay.remove();
            if (text) handleOOCSubmit(text);
        }
        if (e.key === 'Escape') {
            $overlay.remove();
        }
    });
}

async function handleOOCSubmit(text) {
    const s = getSettings();
    if (!s.enabled) {
        toastr.warning(tt`RP Memory is disabled`);
        return;
    }

    debugLog('OOC directive submitted:', text);

    // 1. Inject OOC as temporary system prompt at depth 0
    const oocPrompt = `Author Correction: ${text}. Rewrite the last response incorporating this change.`;
    setExtensionPrompt(
        'rp_memory_ooc',
        oocPrompt,
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.USER,
    );

    // 2. Set cleanup flag
    pendingOOCCleanup = true;

    // 3. Trigger regeneration
    $('#option_regenerate').trigger('click');

    // 4. Fire background memory update (non-blocking)
    const context = getContext();
    const apiKey = await resolveApiKey();
    if (apiKey && context.chat?.length) {
        pipeline.applyOOCDirective(text, context).then(updated => {
            if (updated) {
                clearDerivedAnalysis();
                saveMemoryState();
                injectMemoryPrompt();
                renderMemoryUI();
                debugLog('OOC memory update applied');
                toastr.success(tt`Memory updated from OOC directive`, 'RP Memory', { timeOut: 2000 });
            } else {
                debugLog('OOC memory update: no changes');
            }
        }).catch(err => {
            console.warn('[RP Memory] OOC memory update failed:', err.message);
            toastr.warning(tt`OOC memory update failed — regeneration still works`, 'RP Memory', { timeOut: 3000 });
        });
    }
}

// ===================== Utilities =====================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

const _logBuffer = [];
const LOG_BUFFER_MAX = 500;

function debugLog(...args) {
    if (getSettings().debugMode) {
        console.debug('[RP Memory]', ...args);
        const timestamp = new Date().toISOString().slice(11, 23);
        const line = `[${timestamp}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ')}`;
        _logBuffer.push(line);
        if (_logBuffer.length > LOG_BUFFER_MAX) _logBuffer.shift();
    }
}

function downloadLog() {
    if (_logBuffer.length === 0) {
        toastr.info('Log buffer is empty — enable debug mode and interact first.');
        return;
    }
    const blob = new Blob([_logBuffer.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rp-memory-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
}

// ===================== Init =====================

jQuery(async function () {
    try {
        console.log('[RP Memory] Initializing...');

        initSettings();

        // Load Chinese locale data for our own translation layer
        try {
            const localeUrl = new URL('./locales/zh-cn.json', import.meta.url);
            const resp = await fetch(localeUrl);
            if (resp.ok) {
                extensionLocaleData = await resp.json();
                console.log('[RP Memory] Locale data loaded');
            }
        } catch (err) {
            console.debug('[RP Memory] Failed to load locale data:', err);
        }

        console.log('[RP Memory] Loading template...');
        const html = await renderExtensionTemplateAsync('third-party/rp-memory', 'settings');
        $('#extensions_settings2').append(html);
        console.log('[RP Memory] Template loaded');

        // Apply our locale to static HTML (data-i18n attributes)
        applyOwnLocale();

        // Construct singletons
        memoryStore = new MemoryStore();
        injector = new PromptInjector(() => getSettings(), getPromptLanguage);
        apiClient = new OpenRouterClient(() => getSettings());
        apiClient.setKeyResolver(resolveApiKey);
        decayEngine = new DecayEngine(() => getSettings());
        embeddingService = new EmbeddingService(apiClient, () => getSettings(), getPromptLanguage);
        rawTurnRanker = new RawTurnRanker(apiClient, () => getSettings(), getPromptLanguage);
        pipeline = new ExtractionPipeline(apiClient, memoryStore, () => getSettings(), decayEngine, getPromptLanguage, embeddingService);
        reflectionEngine = new ReflectionEngine(apiClient, memoryStore, () => getSettings(), getPromptLanguage);
        goalsManager = new GoalsManager(memoryStore, embeddingService, apiClient, () => getSettings(), getPromptLanguage);
        pipeline.goalsManager = goalsManager;

        // Sync UI
        syncUIFromSettings();

        // Bind all listeners
        bindSettingsListeners();
        bindTabListeners();
        bindCategoryListeners();
        bindConflictListeners();

        // Register event listeners
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onNewMessage);
        eventSource.on(event_types.MESSAGE_DELETED, () => { lastProcessedLength = getContext().chat?.length || 0; });
        eventSource.on(event_types.MESSAGE_UPDATED, () => { injectMemoryPrompt(); });

        // Sync-mode goal analysis: runs before each generation so the
        // injection prompt has fresh goal rankings when the model sees it
        eventSource.on(event_types.GENERATION_STARTED, onPreGeneration);

        // Init searchable model picker + load model lists (non-blocking)
        bindModelPicker();
        loadModelList().catch(err => console.warn('[RP Memory] Initial model load failed:', err));
        if (getSettings().embeddingsEnabled) {
            loadEmbeddingModelList().catch(err => console.warn('[RP Memory] Initial embedding model load failed:', err));
        }
        if (getSettings().goalsIntentEnabled) {
            // Populate after model list loads (populateGoalsIntentModelDropdown chains off cachedModelList)
            loadModelList().then(() => populateGoalsIntentModelDropdown()).catch(() => {});
        }

        // Load initial state
        onChatChanged();

        // Initialize floating nav bar
        initFloatingUI();

        console.log('[RP Memory] Extension loaded successfully');
    } catch (err) {
        console.error('[RP Memory] Failed to initialize:', err);
    }
});
