import { eventSource, event_types, extension_prompt_types, extension_prompt_roles,
    saveSettingsDebounced, setExtensionPrompt } from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync,
    saveMetadataDebounced } from '../../../extensions.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { MemoryStore } from './src/MemoryStore.js';
import { PromptInjector } from './src/PromptInjector.js';
import { ExtractionPipeline } from './src/ExtractionPipeline.js';
import { DecayEngine } from './src/DecayEngine.js';
import { OpenRouterClient } from './src/OpenRouterClient.js';
import { createEmptyEntity, generateId } from './src/Utils.js';

const MODULE_NAME = 'rp_memory';
const EXTENSION_KEY = 'rp_memory';

const defaultSettings = {
    enabled: true,
    apiKey: '',
    model: 'google/gemini-2.0-flash-001',
    extractionInterval: 2,
    decayFactor: 0.95,
    demotionThreshold: 5.0,
    tokenBudget: 0,
    injectionPosition: extension_prompt_types.IN_PROMPT,
    injectionDepth: 2,
    injectionRole: extension_prompt_roles.SYSTEM,
    userMessageWeight: 'high',
    messagesPerExtraction: 10,
    maxRetries: 2,
    debugMode: false,
};

// Singletons
let memoryStore = null;
let injector = null;
let apiClient = null;
let pipeline = null;
let decayEngine = null;
let lastProcessedLength = 0;

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
}

function getSettings() {
    return extension_settings[EXTENSION_KEY];
}

function syncUIFromSettings() {
    const s = getSettings();
    $('#rp_memory_enabled').prop('checked', s.enabled);
    $('#rp_memory_api_key').val(s.apiKey);
    $('#rp_memory_model').val(s.model);
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
    $('#rp_memory_debug').prop('checked', s.debugMode);
}

function bindSettingsListeners() {
    $('#rp_memory_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
        injectMemoryPrompt();
    });

    $('#rp_memory_api_key').on('input', function () {
        getSettings().apiKey = $(this).val();
        saveSettingsDebounced();
    });

    $('#rp_memory_model').on('change', function () {
        getSettings().model = $(this).val();
        saveSettingsDebounced();
    });

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

    // Test connection
    $('#rp_memory_test_connection').on('click', testConnection);

    // Force extract
    $('#rp_memory_force_extract').on('click', forceExtract);

    // Clear all
    $('#rp_memory_clear_all').on('click', clearAllMemory);
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

    // Entity header click (expand/collapse fields)
    $(document).on('click', '.rp-mem-entity-header', function (e) {
        if ($(e.target).closest('.rp-mem-entity-actions').length) return;
        $(this).siblings('.rp-mem-entity-fields').toggle();
    });

    // Edit button
    $(document).on('click', '.rp-mem-edit-btn', function (e) {
        e.stopPropagation();
        const card = $(this).closest('.rp-mem-entity');
        openEditEntityDialog(card.data('category'), card.data('id'));
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
    context.chatMetadata[EXTENSION_KEY] = memoryStore.serialize();
    saveMetadataDebounced();
    debugLog('Memory state saved');
}

function onChatChanged() {
    const context = getContext();
    if (!context.chat || !context.chatId) {
        memoryStore.clear();
        injectMemoryPrompt();
        renderMemoryUI();
        return;
    }

    const savedState = context.chatMetadata?.[EXTENSION_KEY] || null;
    memoryStore.load(savedState);
    injectMemoryPrompt();
    renderMemoryUI();
    debugLog('Chat changed, memory loaded', savedState ? 'from saved state' : 'fresh');
}

// ===================== Prompt Injection =====================

function injectMemoryPrompt() {
    const s = getSettings();
    if (!s.enabled) {
        setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    const promptText = injector.format(memoryStore);
    setExtensionPrompt(
        MODULE_NAME,
        promptText,
        s.injectionPosition,
        s.injectionDepth,
        false,
        s.injectionRole,
    );

    // Update token count display
    const tokens = injector.getTokenCount(memoryStore);
    const budget = s.tokenBudget;
    let countText = `~${tokens} tokens`;
    if (budget > 0) {
        countText += ` / ${budget}`;
        if (tokens > budget) {
            countText += ' (OVER BUDGET)';
        }
    }
    $('#rp_memory_token_count').text(countText);

    debugLog('Prompt injected', `${tokens} tokens`);
}

// ===================== Render UI =====================

function renderMemoryUI() {
    const counts = memoryStore.getCounts();

    // Update counts
    for (const [cat, count] of Object.entries(counts)) {
        $(`.rp-mem-category-count[data-category="${cat}"]`).text(count);
    }

    // Render each category
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

    renderConflicts();
}

function renderCategoryEntities(category) {
    const container = $(`#rp_memory_cat_${category}`);
    container.empty();

    const entities = memoryStore.getAllEntities(category);
    const entityList = Object.values(entities);

    if (entityList.length === 0) {
        container.append('<div class="rp-mem-empty-state">No entries yet</div>');
        return;
    }

    // Sort: Tier 1 first, then by importance descending
    entityList.sort((a, b) => (a.tier - b.tier) || (b.importance - a.importance));

    for (const entity of entityList) {
        container.append(renderEntityCard(category, entity));
    }
}

function renderEntityCard(category, entity) {
    const tierLabel = { 1: 'Pinned', 2: 'Active', 3: 'Archived' };
    const tierClass = { 1: 'tier-pinned', 2: 'tier-active', 3: 'tier-archived' };
    const hasConflicts = (entity.conflicts || []).some(c => !c.resolved);

    let fieldsHtml = '';
    if (entity.fields) {
        fieldsHtml = renderEntityFields(category, entity.fields);
    }

    return `
    <div class="rp-mem-entity ${tierClass[entity.tier] || ''}" data-category="${category}" data-id="${entity.id}">
        <div class="rp-mem-entity-header">
            <span class="rp-mem-entity-name">${escapeHtml(entity.name)}</span>
            <span class="rp-mem-tier-badge">${tierLabel[entity.tier] || '?'}</span>
            <span class="rp-mem-importance">${entity.importance}</span>
            ${hasConflicts ? '<i class="fa-solid fa-triangle-exclamation rp-mem-conflict-icon" title="Has unresolved conflicts"></i>' : ''}
            <div class="rp-mem-entity-actions">
                <i class="fa-solid fa-pen rp-mem-edit-btn" title="Edit"></i>
                <i class="fa-solid fa-thumbtack rp-mem-pin-btn" title="Toggle pin"></i>
                <i class="fa-solid fa-trash rp-mem-delete-btn" title="Delete"></i>
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

        const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');

        if (Array.isArray(value)) {
            if (value.length === 0) continue;
            // Check if it's an array of objects (relationships)
            if (typeof value[0] === 'object' && value[0] !== null) {
                const formatted = value.map(v => {
                    if (v.target && v.nature) return `${v.target}: ${v.nature}`;
                    return JSON.stringify(v);
                }).join(', ');
                lines.push(`<div class="rp-mem-field"><span class="rp-mem-field-label">${escapeHtml(label)}:</span> <span class="rp-mem-field-value">${escapeHtml(formatted)}</span></div>`);
            } else {
                lines.push(`<div class="rp-mem-field"><span class="rp-mem-field-label">${escapeHtml(label)}:</span> <span class="rp-mem-field-value">${escapeHtml(value.join(', '))}</span></div>`);
            }
        } else if (typeof value === 'object') {
            // Nested object (e.g., status)
            for (const [subKey, subVal] of Object.entries(value)) {
                if (!subVal || (Array.isArray(subVal) && subVal.length === 0)) continue;
                const subLabel = subKey.charAt(0).toUpperCase() + subKey.slice(1);
                const displayVal = Array.isArray(subVal) ? subVal.join(', ') : String(subVal);
                lines.push(`<div class="rp-mem-field"><span class="rp-mem-field-label">${escapeHtml(subLabel)}:</span> <span class="rp-mem-field-value">${escapeHtml(displayVal)}</span></div>`);
            }
        } else {
            lines.push(`<div class="rp-mem-field"><span class="rp-mem-field-label">${escapeHtml(label)}:</span> <span class="rp-mem-field-value">${escapeHtml(String(value))}</span></div>`);
        }
    }

    return lines.join('');
}

// ===================== Conflict UI =====================

function renderConflicts() {
    const container = $('#rp_memory_conflict_list');
    container.empty();

    const allConflicts = memoryStore.getConflicts();

    if (allConflicts.length === 0) {
        container.append('<div class="rp-mem-empty-state">No conflicts detected</div>');
        return;
    }

    for (const { category, entity, conflicts } of allConflicts) {
        for (const conflict of conflicts) {
            container.append(renderConflictCard(category, entity, conflict));
        }
    }
}

function renderConflictCard(category, entity, conflict) {
    return `
    <div class="rp-mem-conflict-card" data-category="${category}" data-id="${entity.id}" data-field="${escapeHtml(conflict.field)}">
        <div class="rp-mem-conflict-header">
            ${escapeHtml(entity.name)} &gt; ${escapeHtml(conflict.field)} (Turn ${conflict.detectedTurn})
        </div>
        <div class="rp-mem-conflict-diff">
            <div class="rp-mem-conflict-old">
                <span class="rp-mem-field-label">Old:</span> ${escapeHtml(JSON.stringify(conflict.oldValue))}
            </div>
            <div class="rp-mem-conflict-new">
                <span class="rp-mem-field-label">New:</span> ${escapeHtml(JSON.stringify(conflict.newValue))}
            </div>
        </div>
        <div class="rp-mem-conflict-actions">
            <div class="menu_button rp-mem-conflict-accept" data-category="${category}" data-id="${entity.id}" data-field="${escapeHtml(conflict.field)}">Accept New</div>
            <div class="menu_button rp-mem-conflict-revert" data-category="${category}" data-id="${entity.id}" data-field="${escapeHtml(conflict.field)}">Keep Old</div>
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
        // Revert: restore old value
        if (entity.fields && conflict.oldValue !== undefined) {
            entity.fields[field] = conflict.oldValue;
        }
    }

    conflict.resolved = true;
    saveMemoryState();
    injectMemoryPrompt();
    renderMemoryUI();
}

// ===================== Entity CRUD Dialogs =====================

async function openAddEntityDialog(category) {
    const categoryLabels = {
        mainCharacter: 'Main Character',
        characters: 'Character (NPC)',
        locations: 'Location',
        goals: 'Goal / Task',
        events: 'Event',
    };

    // For mainCharacter, check if one already exists
    if (category === 'mainCharacter' && memoryStore.getMainCharacter()) {
        openEditEntityDialog('mainCharacter', 'main_character');
        return;
    }

    const nameInput = category === 'mainCharacter'
        ? `<input id="rp_mem_new_name" class="text_pole" type="text" value="{{user}}" />`
        : `<input id="rp_mem_new_name" class="text_pole" type="text" placeholder="Enter name..." />`;

    const html = `
    <div class="rp-mem-editor">
        <h3>Add ${categoryLabels[category] || category}</h3>
        <label>Name</label>
        ${nameInput}
    </div>`;

    const result = await Popup.show.confirm(html, 'Create');

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        const name = $('#rp_mem_new_name').val()?.trim();
        if (!name) return;

        const turn = memoryStore.getTurnCounter();
        const entity = createEmptyEntity(category, name, turn);
        memoryStore.addEntity(category, entity);
        saveMemoryState();
        injectMemoryPrompt();
        renderMemoryUI();

        // Open editor immediately for the new entity
        openEditEntityDialog(category, entity.id);
    }
}

async function openEditEntityDialog(category, entityId) {
    const entity = memoryStore.getEntity(category, entityId);
    if (!entity) return;

    const html = buildEntityEditorHTML(category, entity);

    const result = await Popup.show.confirm(html, 'Save');

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        // Read updated values from DOM
        const updatedName = $('#rp_mem_edit_name').val()?.trim() || entity.name;
        const updatedTier = parseInt($('#rp_mem_edit_tier').val()) || entity.tier;
        const updatedImportance = parseFloat($('#rp_mem_edit_importance').val()) || entity.importance;
        const updatedFields = readFieldsFromDOM(category);

        // Update ID if name changed
        let newId = entity.id;
        if (updatedName !== entity.name && category !== 'mainCharacter') {
            newId = generateId(updatedName);
            // Delete old, create with new ID
            memoryStore.deleteEntity(category, entity.id);
            memoryStore.addEntity(category, {
                ...entity,
                id: newId,
                name: updatedName,
                tier: updatedTier,
                importance: updatedImportance,
                baseScore: updatedImportance,
                fields: updatedFields,
                source: 'manual',
            });
        } else {
            memoryStore.updateEntity(category, entityId, {
                name: updatedName,
                tier: updatedTier,
                importance: updatedImportance,
                baseScore: updatedImportance,
                fields: updatedFields,
                source: 'manual',
            });
        }

        saveMemoryState();
        injectMemoryPrompt();
        renderMemoryUI();
    }
}

function buildEntityEditorHTML(category, entity) {
    const f = entity.fields || {};
    let fieldsHtml = '';

    switch (category) {
        case 'characters':
            fieldsHtml = `
                <label>Description</label>
                <textarea id="rp_mem_edit_description" class="text_pole">${escapeHtml(f.description || '')}</textarea>
                <label>Personality</label>
                <textarea id="rp_mem_edit_personality" class="text_pole">${escapeHtml(f.personality || '')}</textarea>
                <label>Status</label>
                <input id="rp_mem_edit_status" class="text_pole" type="text" value="${escapeHtml(f.status || '')}" />
                <label>Relationships (one per line: target_id: nature)</label>
                <textarea id="rp_mem_edit_relationships" class="text_pole">${escapeHtml((f.relationships || []).map(r => `${r.target}: ${r.nature}`).join('\n'))}</textarea>`;
            break;
        case 'locations':
            fieldsHtml = `
                <label>Description</label>
                <textarea id="rp_mem_edit_description" class="text_pole">${escapeHtml(f.description || '')}</textarea>
                <label>Atmosphere</label>
                <input id="rp_mem_edit_atmosphere" class="text_pole" type="text" value="${escapeHtml(f.atmosphere || '')}" />
                <label>Notable Features (comma-separated)</label>
                <input id="rp_mem_edit_notableFeatures" class="text_pole" type="text" value="${escapeHtml((f.notableFeatures || []).join(', '))}" />
                <label>Connections (comma-separated location IDs)</label>
                <input id="rp_mem_edit_connections" class="text_pole" type="text" value="${escapeHtml((f.connections || []).join(', '))}" />`;
            break;
        case 'mainCharacter':
            fieldsHtml = `
                <label>Description</label>
                <textarea id="rp_mem_edit_description" class="text_pole">${escapeHtml(f.description || '')}</textarea>
                <label>Skills (comma-separated)</label>
                <input id="rp_mem_edit_skills" class="text_pole" type="text" value="${escapeHtml((f.skills || []).join(', '))}" />
                <label>Inventory (comma-separated)</label>
                <input id="rp_mem_edit_inventory" class="text_pole" type="text" value="${escapeHtml((f.inventory || []).join(', '))}" />
                <label>Health</label>
                <input id="rp_mem_edit_health" class="text_pole" type="text" value="${escapeHtml(f.status?.health || '')}" />
                <label>Conditions (comma-separated)</label>
                <input id="rp_mem_edit_conditions" class="text_pole" type="text" value="${escapeHtml((f.status?.conditions || []).join(', '))}" />
                <label>Buffs (comma-separated)</label>
                <input id="rp_mem_edit_buffs" class="text_pole" type="text" value="${escapeHtml((f.status?.buffs || []).join(', '))}" />`;
            break;
        case 'goals':
            fieldsHtml = `
                <label>Description</label>
                <textarea id="rp_mem_edit_description" class="text_pole">${escapeHtml(f.description || '')}</textarea>
                <label>Progress</label>
                <textarea id="rp_mem_edit_progress" class="text_pole">${escapeHtml(f.progress || '')}</textarea>
                <label>Blockers</label>
                <input id="rp_mem_edit_blockers" class="text_pole" type="text" value="${escapeHtml(f.blockers || '')}" />
                <label>Status</label>
                <select id="rp_mem_edit_goal_status" class="text_pole">
                    <option value="in_progress" ${f.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                    <option value="completed" ${f.status === 'completed' ? 'selected' : ''}>Completed</option>
                    <option value="failed" ${f.status === 'failed' ? 'selected' : ''}>Failed</option>
                    <option value="abandoned" ${f.status === 'abandoned' ? 'selected' : ''}>Abandoned</option>
                </select>`;
            break;
        case 'events':
            fieldsHtml = `
                <label>Description</label>
                <textarea id="rp_mem_edit_description" class="text_pole">${escapeHtml(f.description || '')}</textarea>
                <label>Turn</label>
                <input id="rp_mem_edit_turn" class="text_pole" type="number" value="${f.turn || 0}" />
                <label>Involved Entities (comma-separated IDs)</label>
                <input id="rp_mem_edit_involvedEntities" class="text_pole" type="text" value="${escapeHtml((f.involvedEntities || []).join(', '))}" />
                <label>Consequences</label>
                <textarea id="rp_mem_edit_consequences" class="text_pole">${escapeHtml(f.consequences || '')}</textarea>
                <label>Significance</label>
                <input id="rp_mem_edit_significance" class="text_pole" type="text" value="${escapeHtml(f.significance || '')}" />`;
            break;
    }

    return `
    <div class="rp-mem-editor">
        <h3>Edit: ${escapeHtml(entity.name)}</h3>
        <div class="rp-mem-editor-row">
            <label>Name</label>
            <input id="rp_mem_edit_name" class="text_pole" type="text" value="${escapeHtml(entity.name)}" />
        </div>
        <div class="rp-mem-editor-row">
            <label>Tier</label>
            <select id="rp_mem_edit_tier" class="text_pole" style="width:120px;">
                <option value="1" ${entity.tier === 1 ? 'selected' : ''}>Pinned</option>
                <option value="2" ${entity.tier === 2 ? 'selected' : ''}>Active</option>
                <option value="3" ${entity.tier === 3 ? 'selected' : ''}>Archived</option>
            </select>
            <label>Importance</label>
            <input id="rp_mem_edit_importance" class="text_pole" type="number" min="1" max="10" step="0.5" value="${entity.importance}" style="width:80px;" />
        </div>
        ${fieldsHtml}
    </div>`;
}

function readFieldsFromDOM(category) {
    const parseCSV = (val) => val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];

    switch (category) {
        case 'characters': {
            const relsText = $('#rp_mem_edit_relationships').val() || '';
            const relationships = relsText.split('\n').filter(Boolean).map(line => {
                const [target, ...natureParts] = line.split(':');
                return { target: target.trim(), nature: natureParts.join(':').trim() };
            }).filter(r => r.target && r.nature);

            return {
                description: $('#rp_mem_edit_description').val() || '',
                personality: $('#rp_mem_edit_personality').val() || '',
                status: $('#rp_mem_edit_status').val() || '',
                relationships,
            };
        }
        case 'locations':
            return {
                description: $('#rp_mem_edit_description').val() || '',
                atmosphere: $('#rp_mem_edit_atmosphere').val() || '',
                notableFeatures: parseCSV($('#rp_mem_edit_notableFeatures').val()),
                connections: parseCSV($('#rp_mem_edit_connections').val()),
            };
        case 'mainCharacter':
            return {
                description: $('#rp_mem_edit_description').val() || '',
                skills: parseCSV($('#rp_mem_edit_skills').val()),
                inventory: parseCSV($('#rp_mem_edit_inventory').val()),
                status: {
                    health: $('#rp_mem_edit_health').val() || '',
                    conditions: parseCSV($('#rp_mem_edit_conditions').val()),
                    buffs: parseCSV($('#rp_mem_edit_buffs').val()),
                },
            };
        case 'goals':
            return {
                description: $('#rp_mem_edit_description').val() || '',
                progress: $('#rp_mem_edit_progress').val() || '',
                blockers: $('#rp_mem_edit_blockers').val() || '',
                status: $('#rp_mem_edit_goal_status').val() || 'in_progress',
            };
        case 'events':
            return {
                description: $('#rp_mem_edit_description').val() || '',
                turn: parseInt($('#rp_mem_edit_turn').val()) || 0,
                involvedEntities: parseCSV($('#rp_mem_edit_involvedEntities').val()),
                consequences: $('#rp_mem_edit_consequences').val() || '',
                significance: $('#rp_mem_edit_significance').val() || '',
            };
        default:
            return {};
    }
}

// ===================== Entity Actions =====================

function togglePin(category, entityId) {
    const entity = memoryStore.getEntity(category, entityId);
    if (!entity) return;

    const newTier = entity.tier === 1 ? 2 : 1;
    memoryStore.updateEntity(category, entityId, { tier: newTier });
    saveMemoryState();
    injectMemoryPrompt();
    renderMemoryUI();
}

async function deleteEntity(category, entityId) {
    const entity = memoryStore.getEntity(category, entityId);
    if (!entity) return;

    const result = await Popup.show.confirm(
        `Delete "${escapeHtml(entity.name)}" from memory?`,
        'Delete',
    );

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        memoryStore.deleteEntity(category, entityId);
        saveMemoryState();
        injectMemoryPrompt();
        renderMemoryUI();
    }
}

async function clearAllMemory() {
    const result = await Popup.show.confirm(
        'Clear ALL memory for this chat? This cannot be undone.',
        'Clear All',
    );

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        memoryStore.clear();
        saveMemoryState();
        injectMemoryPrompt();
        renderMemoryUI();
    }
}

// ===================== Extraction & Events =====================

/**
 * Called after AI responds. Checks interval, runs decay, triggers async extraction.
 */
async function onNewMessage() {
    const settings = getSettings();
    if (!settings.enabled || !settings.apiKey) return;

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

    // Kick off async extraction — does NOT block chat
    triggerExtraction(context).catch(err => {
        console.error('[RP Memory] Extraction failed:', err);
        toastr.error('Memory extraction failed. Check console for details.');
    });
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

        // Verify context hasn't changed during extraction
        const newContext = getContext();
        if (newContext.chatId !== chatId || newContext.characterId !== characterId) {
            debugLog('Context changed during extraction, discarding');
            return;
        }

        memoryStore.setLastExtractionTurn(memoryStore.getTurnCounter());
        saveMemoryState();
        injectMemoryPrompt();
        renderMemoryUI();

        debugLog('Extraction complete');
        toastr.success('Memory updated', 'RP Memory', { timeOut: 2000 });
    } finally {
        memoryStore.setExtractionInProgress(false);
        showExtractionIndicator(false);
    }
}

async function testConnection() {
    const s = getSettings();
    if (!s.apiKey) {
        toastr.warning('Please enter an OpenRouter API key first');
        return;
    }

    toastr.info('Testing connection...');
    try {
        const ok = await apiClient.testConnection();
        if (ok) {
            toastr.success('Connection successful!');
        } else {
            toastr.error('Connection test returned unexpected response');
        }
    } catch (err) {
        toastr.error(`Connection failed: ${err.message}`);
        console.error('[RP Memory] Connection test failed:', err);
    }
}

async function forceExtract() {
    const s = getSettings();
    if (!s.enabled) {
        toastr.warning('RP Memory is disabled');
        return;
    }
    if (!s.apiKey) {
        toastr.warning('Please configure an OpenRouter API key in Settings');
        return;
    }

    const context = getContext();
    if (!context.chat?.length) {
        toastr.warning('No chat messages to extract from');
        return;
    }

    await triggerExtraction(context);
}

function showExtractionIndicator(visible) {
    if (visible) {
        $('#rp_memory_status').show();
    } else {
        $('#rp_memory_status').hide();
    }
}

// ===================== Utilities =====================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function debugLog(...args) {
    if (getSettings().debugMode) {
        console.debug('[RP Memory]', ...args);
    }
}

// ===================== Init =====================

jQuery(async function () {
    try {
        console.log('[RP Memory] Initializing...');

        initSettings();

        console.log('[RP Memory] Loading template...');
        const html = await renderExtensionTemplateAsync('third-party/rp-memory', 'settings');
        $('#extensions_settings2').append(html);
        console.log('[RP Memory] Template loaded');

        // Construct singletons
        memoryStore = new MemoryStore();
        injector = new PromptInjector(() => getSettings());
        apiClient = new OpenRouterClient(() => getSettings());
        decayEngine = new DecayEngine(() => getSettings());
        pipeline = new ExtractionPipeline(apiClient, memoryStore, () => getSettings());

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

        // Load initial state
        onChatChanged();

        console.log('[RP Memory] Extension loaded successfully');
    } catch (err) {
        console.error('[RP Memory] Failed to initialize:', err);
    }
});
