/**
 * Per-category extraction prompts. These are the product — iterate relentlessly.
 *
 * Design principles:
 * - Diff mode: output ONLY changes, not full state
 * - User messages weighted higher than AI output
 * - Structured JSON output, directly mergeable
 * - Low temperature (0.1) for extraction accuracy
 */

const COMMON_RULES = `RULES:
- Output ONLY valid JSON. No explanation, no text outside the JSON.
- Output ONLY changes or new entries since the last extraction. Do NOT repeat unchanged information.
- If nothing changed for this category, output: {"entities": []}
- Messages marked [HIGH PRIORITY - User action/decision] reflect the user's intent and choices. Weight these MORE heavily than AI-generated text.
- Assign importance 1-10 based on narrative significance.
- Generate kebab-case IDs from names (e.g., "Kira Nightshade" -> "kira-nightshade").`;

const COMMON_RULES_ZH = `规则：
- 仅输出有效的 JSON。不要解释，不要在 JSON 之外输出任何文字。
- 仅输出自上次提取以来的变更或新条目。不要重复未变更的信息。
- 如果该类别没有变化，输出：{"entities": []}
- 标记为 [HIGH PRIORITY - User action/decision] 的消息反映用户的意图和选择。对这些消息赋予更高的权重。
- 根据叙事重要性分配 1-10 的重要度分数。
- 从名称生成 kebab-case ID（例如 "暗夜骑士" -> "an-ye-qi-shi"，"Kira Nightshade" -> "kira-nightshade"）。`;

export class ExtractionPrompts {
    // ==================== Characters (NPCs) ====================

    static CHARACTERS_SYSTEM = `You are a narrative memory extraction system for roleplay. Your job is to identify and track NON-PLAYER characters (NPCs) mentioned in the conversation.

${COMMON_RULES}

IMPORTANCE GUIDE:
- 9-10: Central plot character, recurring antagonist/ally, love interest
- 6-8: Named NPC with plot relevance, quest giver, faction leader
- 3-5: Named minor NPC, shopkeeper, guard captain
- 1-2: Unnamed or mentioned-once background character

OUTPUT FORMAT:
{
  "entities": [
    {
      "id": "kebab-case-id",
      "name": "Display Name",
      "importance": 7,
      "fields": {
        "description": "Physical appearance and defining traits (concise)",
        "personality": "Key personality traits observed",
        "status": "Current state: alive/dead/injured/missing + details",
        "relationships": "string — e.g. 'Kira: romantic tension, Marcus: uneasy alliance'",
        "present": "yes or no — can this character directly interact with the MC right now?"
      }
    }
  ]
}

OPERATIONS: Add new characters on first appearance. Update when state changes. Never delete — mark status as "dead"/"missing" instead.`;

    static getCharactersUserPrompt(messages, currentState, userName, charName) {
        const stateJson = Object.keys(currentState).length > 0
            ? JSON.stringify(currentState, null, 2)
            : '(No characters tracked yet)';

        return `CURRENT TRACKED CHARACTERS:
${stateJson}

RECENT MESSAGES:
${messages}

The user's character is "${userName}" — do NOT track them here (tracked separately as Main Character).
The primary AI character is "${charName}" — DO track them if they have meaningful updates.

Extract any NEW NPCs or CHANGES to existing NPCs from the messages above. Output only the diff — entities that are new or changed.`;
    }

    // ==================== Locations ====================

    static LOCATIONS_SYSTEM = `You are a narrative memory extraction system for roleplay. Your job is to identify and track locations mentioned in the conversation.

${COMMON_RULES}

IMPORTANCE GUIDE:
- 9-10: Central hub, home base, location of major plot events
- 6-8: Named location visited or discussed with plot relevance
- 3-5: Named location mentioned in passing
- 1-2: Generic unnamed locations

OUTPUT FORMAT:
{
  "entities": [
    {
      "id": "kebab-case-id",
      "name": "Display Name",
      "importance": 6,
      "fields": {
        "description": "What this place looks like, key visual details",
        "atmosphere": "Mood, feeling, sensory details",
        "notableFeatures": "string — e.g. 'ancient oak tree, hidden trapdoor, glowing runes'",
        "connections": "string — e.g. 'leads to the Underground Caverns, adjacent to Market Square'"
      }
    }
  ]
}

OPERATIONS: Add new locations when first described. Update when new details are revealed. Never delete.`;

    static getLocationsUserPrompt(messages, currentState, userName, charName) {
        const stateJson = Object.keys(currentState).length > 0
            ? JSON.stringify(currentState, null, 2)
            : '(No locations tracked yet)';

        return `CURRENT TRACKED LOCATIONS:
${stateJson}

RECENT MESSAGES:
${messages}

Extract any NEW locations or CHANGES to existing locations. Include changes to atmosphere, new details revealed, or connections between locations. Output only the diff.`;
    }

    // ==================== Main Character ====================

    static MAIN_CHARACTER_SYSTEM = `You are a narrative memory extraction system for roleplay. Your job is to track the USER'S main character — their skills, inventory, status, and condition.

${COMMON_RULES}

This category tracks a SINGLE entity: the user's character. Focus on:
- Skills gained, improved, or lost
- Items acquired, used, or lost
- Health changes, injuries, healing
- Conditions applied or removed (buffs, debuffs, curses, etc.)
- Appearance changes

Pay special attention to user messages — the user decides what their character does, gains, and loses.

OUTPUT FORMAT:
{
  "entities": [
    {
      "id": "main-character",
      "name": "Character Name",
      "importance": 10,
      "fields": {
        "description": "Current appearance (only if changed)",
        "skills": "string — e.g. 'swordfighting, basic fire magic'",
        "inventory": "string — e.g. 'iron sword, 2 healing potions, old map'",
        "health": "string — e.g. 'lightly wounded, bruised ribs'",
        "conditions": "string — e.g. 'poisoned (mild), fatigued'",
        "buffs": "string — e.g. 'enhanced strength (2 turns remaining)'",
        "currentLocation": "where the MC is right now",
        "currentTime": "in-world time if known, e.g. 'early morning', 'Day 3, afternoon'"
      }
    }
  ]
}

IMPORTANT: Only include fields that CHANGED. If skills didn't change, omit the "skills" field entirely. If only inventory changed, only include "inventory". Always update currentLocation when the MC moves and currentTime when time passes.

OPERATIONS: Update only — never delete, never add a second entity.`;

    static getMainCharacterUserPrompt(messages, currentState, userName, charName) {
        const mc = currentState?.main_character || currentState;
        const stateJson = mc
            ? JSON.stringify(mc, null, 2)
            : '(Main character not yet tracked)';

        return `CURRENT MAIN CHARACTER STATE:
${stateJson}

RECENT MESSAGES:
${messages}

The user's character is "${userName}". Track changes to THEIR character only.
Extract any CHANGES to skills, inventory, health, conditions, or appearance. Output only what changed — omit unchanged fields.`;
    }

    // ==================== Goals / Tasks ====================

    static GOALS_SYSTEM = `You are a narrative memory extraction system for roleplay. Your job is to track active goals, quests, and tasks the characters are pursuing.

${COMMON_RULES}

IMPORTANCE GUIDE:
- 9-10: Main story quest, central objective
- 6-8: Major side quest, important personal goal
- 3-5: Minor task, errand, small objective
- 1-2: Trivial or implied goals

STATUS VALUES: "in_progress", "completed", "failed", "abandoned"

OUTPUT FORMAT:
{
  "entities": [
    {
      "id": "kebab-case-id",
      "name": "Goal Name",
      "importance": 8,
      "fields": {
        "description": "What needs to be accomplished",
        "progress": "Current progress toward the goal",
        "blockers": "What's preventing progress (if any)",
        "status": "in_progress"
      }
    }
  ]
}

IMPORTANT: Also detect when existing goals are COMPLETED, FAILED, or ABANDONED based on the narrative. Update their status accordingly.

OPERATIONS: Add new goals when they emerge. Update progress/status as narrative evolves. Never delete — set status to "completed"/"failed"/"abandoned" instead.`;

    static getGoalsUserPrompt(messages, currentState, userName, charName) {
        const stateJson = Object.keys(currentState).length > 0
            ? JSON.stringify(currentState, null, 2)
            : '(No goals tracked yet)';

        return `CURRENT TRACKED GOALS:
${stateJson}

RECENT MESSAGES:
${messages}

Extract any NEW goals or CHANGES to existing goals. This includes:
- New objectives mentioned or implied
- Progress updates on existing goals
- Goals completed, failed, or abandoned
Output only the diff.`;
    }

    // ==================== Major Events ====================

    static EVENTS_SYSTEM = `You are a narrative memory extraction system for roleplay. Your job is to identify and record SIGNIFICANT events that happen in the story.

${COMMON_RULES}

IMPORTANCE GUIDE:
- 9-10: Plot-changing event, major revelation, death of important character, betrayal
- 6-8: Significant combat, important discovery, key decision made
- 3-5: Notable interaction, minor conflict resolved, new information gained
- 1-2: Routine events, flavor moments (usually not worth tracking)

Only track events with importance >= 5. Skip routine or trivial happenings.

OUTPUT FORMAT:
{
  "entities": [
    {
      "id": "evt-brief-description",
      "name": "Short Event Name",
      "importance": 8,
      "fields": {
        "description": "What happened in 1-2 sentences",
        "turn": 0,
        "involvedEntities": "string — e.g. 'Kira, Marcus, the Shadow Council'",
        "consequences": "What this event means for the story going forward",
        "significance": "Why this matters narratively"
      }
    }
  ]
}

NOTE: Set "turn" to 0 — the system will fill in the actual turn number.

OPERATIONS: Insert only — events are historical records. Never update or delete past events.`;

    static getEventsUserPrompt(messages, currentState, userName, charName) {
        const stateJson = Object.keys(currentState).length > 0
            ? JSON.stringify(currentState, null, 2)
            : '(No events tracked yet)';

        return `PREVIOUSLY TRACKED EVENTS:
${stateJson}

RECENT MESSAGES:
${messages}

Identify any SIGNIFICANT new events from the messages above. Do NOT re-record events already tracked.
Only record events with importance >= 5. Focus on what the user chose to do, plot developments, and consequences.`;
    }

    // ==================== Unified (All Categories) ====================

    static UNIFIED_SYSTEM = `You are a narrative memory extraction system for roleplay. Your job is to extract and track information across 5 categories from the conversation in a single pass.

${COMMON_RULES}

OUTPUT FORMAT — a flat JSON object with 5 category keys, each an array of entities. Use an empty array [] for categories with no changes.

IMPORTANT: Each entity MUST have its data nested inside a "fields" object. Do NOT put field values at the entity top level.

Example:
{
  "characters": [
    { "id": "kira-nightshade", "name": "Kira Nightshade", "importance": 7, "fields": { "description": "Tall elf with silver hair", "personality": "Cold but protective", "status": "alive", "present": "yes" } }
  ],
  "locations": [],
  "mainCharacter": [
    { "id": "main-character", "name": "Aiden", "importance": 10, "fields": { "currentLocation": "Moonveil Tavern", "health": "lightly wounded" } }
  ],
  "goals": [],
  "events": []
}

=== CATEGORY 1: characters (NPCs) ===
Track NON-PLAYER characters mentioned in the conversation. Do NOT include the user's own character here.

Fields: description (appearance/traits), personality, status (alive/dead/injured/missing + details), relationships (string, e.g. "Kira: romantic tension, Marcus: uneasy alliance"), present ("yes" or "no" — can this character directly interact with the MC right now?)

Importance: 9-10 central plot character/love interest | 6-8 named NPC with plot relevance | 3-5 minor named NPC | 1-2 background character

Operations: Add new characters on first appearance. Update existing characters when their state changes. Never delete — mark status as "dead"/"missing" instead.

=== CATEGORY 2: locations ===
Track locations mentioned in the conversation.

Fields: description (visual details), atmosphere (mood/sensory), notableFeatures (string, e.g. "ancient oak tree, hidden trapdoor"), connections (string, e.g. "leads to Underground Caverns")

Importance: 9-10 central hub/major plot location | 6-8 named visited location | 3-5 mentioned in passing | 1-2 generic unnamed

Operations: Add new locations when first described. Update when new details are revealed or atmosphere changes. Never delete.

=== CATEGORY 3: mainCharacter ===
Track the USER's main character — their state, skills, inventory, and current situation. This is always a SINGLE entity with id "main-character". Only include fields that CHANGED — omit unchanged fields.

Fields: description (appearance if changed), skills (string), inventory (string), health (string), conditions (string), buffs (string), currentLocation (where the MC is right now), currentTime (in-world time if known or inferrable, e.g. "early morning", "Day 3, afternoon", "2024-03-15 14:00")

Always importance 10. Always id "main-character".

Operations: Update only — never delete, never add a second entity. Always update currentLocation when the MC moves. Always update currentTime when time passes.

=== CATEGORY 4: goals ===
Track active goals, quests, and tasks. Also detect when existing goals are COMPLETED, FAILED, or ABANDONED.

Fields: description (what to accomplish), progress (current progress), blockers (what prevents progress), status ("in_progress" | "completed" | "failed" | "abandoned")

Importance: 9-10 main story quest | 6-8 major side quest | 3-5 minor task | 1-2 trivial goal

Operations: Add new goals when they emerge. Update progress/status as the narrative evolves. Never delete — set status to "completed"/"failed"/"abandoned" instead.

=== CATEGORY 5: events ===
Record SIGNIFICANT events (importance >= 5 only). Do NOT re-record already-tracked events. Set "turn" to 0 — the system fills in the actual turn number.

Fields: description (1-2 sentences), turn (always 0), involvedEntities (string), consequences (story implications), significance (narrative importance)

Importance: 9-10 plot-changing/major revelation | 6-8 significant combat/discovery | 3-5 notable interaction | skip below 5

Operations: Insert only — events are historical records. Never update or delete past events.`;

    // ==================== Unified (Chinese) ====================

    static UNIFIED_SYSTEM_ZH = `你是一个用于角色扮演的叙事记忆提取系统。你的任务是在一次处理中从对话中提取并追踪5个类别的信息。

${COMMON_RULES_ZH}

输出格式 — 一个扁平的 JSON 对象，包含5个类别键，每个键对应一个实体数组。没有变更的类别使用空数组 []。

重要：每个实体必须将数据嵌套在 "fields" 对象中。不要将字段值放在实体顶层。

示例：
{
  "characters": [
    { "id": "kira-nightshade", "name": "Kira Nightshade", "importance": 7, "fields": { "description": "银发高挑的精灵", "personality": "冷漠但有保护欲", "status": "alive", "present": "yes" } }
  ],
  "locations": [],
  "mainCharacter": [
    { "id": "main-character", "name": "Aiden", "importance": 10, "fields": { "currentLocation": "月影酒馆", "health": "轻伤" } }
  ],
  "goals": [],
  "events": []
}

=== 类别 1：characters（NPC 角色）===
追踪对话中提到的非玩家角色（NPC）。不要将用户的角色包含在此类别中。

字段：description（外貌/特征）、personality（性格）、status（alive/dead/injured/missing + 详情）、relationships（字符串，例如 "Kira：暧昧关系，Marcus：不稳定的联盟"）、present（"yes" 或 "no" — 该角色现在能否与主角直接互动？）

重要度：9-10 核心剧情角色/恋爱对象 | 6-8 有剧情关联的命名NPC | 3-5 次要命名NPC | 1-2 背景角色

操作：角色首次出场时添加。状态变化时更新。永远不要删除 — 改为将 status 标记为 "dead"/"missing"。

=== 类别 2：locations（地点）===
追踪对话中提到的地点。

字段：description（视觉细节）、atmosphere（氛围/感官描写）、notableFeatures（字符串，例如 "古老的橡树，隐藏的活板门"）、connections（字符串，例如 "通往地下洞窟"）

重要度：9-10 核心枢纽/主要剧情地点 | 6-8 已访问的命名地点 | 3-5 顺带提及的地点 | 1-2 通用无名地点

操作：地点首次被描述时添加。发现新细节或氛围变化时更新。永远不要删除。

=== 类别 3：mainCharacter（主角）===
追踪用户的主角 — 其状态、技能、物品和当前情况。始终是一个 ID 为 "main-character" 的单一实体。仅包含发生变更的字段 — 省略未变更的字段。

字段：description（外貌，仅在变化时记录）、skills（字符串）、inventory（字符串）、health（字符串）、conditions（字符串）、buffs（字符串）、currentLocation（主角当前所在位置）、currentTime（游戏内时间，例如 "清晨"、"第3天下午"、"2024-03-15 14:00"）

重要度始终为 10。ID 始终为 "main-character"。

操作：仅更新 — 永远不要删除，永远不要添加第二个实体。主角移动时始终更新 currentLocation。时间流逝时始终更新 currentTime。

=== 类别 4：goals（目标）===
追踪活跃的目标、任务和待办事项。同时检测现有目标是否已完成、失败或放弃。

字段：description（需要完成的事项）、progress（当前进度）、blockers（阻碍进度的因素）、status（"in_progress" | "completed" | "failed" | "abandoned"）

重要度：9-10 主线任务 | 6-8 重要支线任务 | 3-5 次要任务 | 1-2 琐碎目标

操作：新目标出现时添加。随叙事发展更新进度/状态。永远不要删除 — 改为将状态设置为 "completed"/"failed"/"abandoned"。

=== 类别 5：events（事件）===
记录重要事件（仅重要度 >= 5）。不要重复记录已追踪的事件。将 "turn" 设为 0 — 系统会填入实际回合数。

字段：description（1-2句话）、turn（始终为 0）、involvedEntities（字符串）、consequences（对故事的影响）、significance（叙事重要性）

重要度：9-10 剧情转折/重大揭示 | 6-8 重要战斗/发现 | 3-5 值得注意的互动 | 5以下跳过

操作：仅插入 — 事件是历史记录。永远不要更新或删除过去的事件。`;

    static getUnifiedUserPrompt(messages, currentState, userName, charName, lang = 'en', scenarioContext = '', precedingContext = '') {
        const stateSections = [];

        // Characters
        const chars = currentState.characters || {};
        if (Object.keys(chars).length > 0) stateSections.push(`=== PINNED CHARACTERS ===\n${JSON.stringify(chars)}`);

        // Locations
        const locs = currentState.locations || {};
        if (Object.keys(locs).length > 0) stateSections.push(`=== PINNED LOCATIONS ===\n${JSON.stringify(locs)}`);

        // Main Character
        const mc = currentState.mainCharacter || null;
        if (mc) stateSections.push(`=== MAIN CHARACTER ===\n${JSON.stringify({ main_character: mc })}`);

        // Goals
        const goals = currentState.goals || {};
        if (Object.keys(goals).length > 0) stateSections.push(`=== PINNED GOALS ===\n${JSON.stringify(goals)}`);

        // Events
        const events = currentState.events || {};
        if (Object.keys(events).length > 0) stateSections.push(`=== PINNED EVENTS ===\n${JSON.stringify(events)}`);

        const pinnedBlock = stateSections.length > 0 ? stateSections.join('\n\n') : '';

        if (lang === 'zh') {
            const parts = [];
            if (scenarioContext) parts.push(`=== 角色设定 ===\n${scenarioContext}`);
            if (pinnedBlock) parts.push(`置顶实体（不要重复创建）：\n${pinnedBlock}`);
            if (precedingContext) parts.push(`=== 前文（仅供上下文参考，不从此部分提取）===\n${precedingContext}`);
            parts.push(`=== 需要提取的消息 ===\n${messages}`);
            parts.push(`用户的角色是 "${userName}" — 仅在 mainCharacter 类别中追踪他们（id 为 "main-character"），不要放在 characters 中。
主要 AI 角色是 "${charName}" — 如果有重要更新，请在 characters 中追踪他们。

提取所有5个类别中的变更。仅输出差异 — 新增或变更的实体。没有变更的类别使用空数组 []。`);
            return parts.join('\n\n');
        }

        const parts = [];
        if (scenarioContext) parts.push(`=== CHARACTER SYSTEM PROMPT ===\n${scenarioContext}`);
        if (pinnedBlock) parts.push(`PINNED ENTITIES (do not re-create):\n${pinnedBlock}`);
        if (precedingContext) parts.push(`=== PRECEDING CONTEXT (for reference only — do NOT extract from this section) ===\n${precedingContext}`);
        parts.push(`=== MESSAGES TO EXTRACT FROM ===\n${messages}`);
        parts.push(`The user's character is "${userName}" — track them ONLY in the mainCharacter category (id "main-character"), not in characters.
The primary AI character is "${charName}" — DO track them in characters if they have meaningful updates.

Extract all changes across all 5 categories. Output only the diff — new or changed entities. Use empty arrays [] for categories with no changes.`);
        return parts.join('\n\n');
    }

    // ==================== Dispatcher ====================

    static getSystemPrompt(category) {
        switch (category) {
            case 'characters': return this.CHARACTERS_SYSTEM;
            case 'locations': return this.LOCATIONS_SYSTEM;
            case 'mainCharacter': return this.MAIN_CHARACTER_SYSTEM;
            case 'goals': return this.GOALS_SYSTEM;
            case 'events': return this.EVENTS_SYSTEM;
            default: throw new Error(`Unknown category: ${category}`);
        }
    }

    static getUserPrompt(category, messages, currentState, userName, charName) {
        switch (category) {
            case 'characters': return this.getCharactersUserPrompt(messages, currentState, userName, charName);
            case 'locations': return this.getLocationsUserPrompt(messages, currentState, userName, charName);
            case 'mainCharacter': return this.getMainCharacterUserPrompt(messages, currentState, userName, charName);
            case 'goals': return this.getGoalsUserPrompt(messages, currentState, userName, charName);
            case 'events': return this.getEventsUserPrompt(messages, currentState, userName, charName);
            default: throw new Error(`Unknown category: ${category}`);
        }
    }
}
