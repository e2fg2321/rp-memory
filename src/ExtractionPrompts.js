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
        "relationships": [
          {"target": "other-entity-id", "nature": "brief relationship description"}
        ]
      }
    }
  ]
}`;

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
        "notableFeatures": ["feature1", "feature2"],
        "connections": ["connected-location-id"]
      }
    }
  ]
}`;

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
        "skills": ["skill1", "skill2"],
        "inventory": ["item1", "item2"],
        "status": {
          "health": "current health state",
          "conditions": ["condition1"],
          "buffs": ["buff1"]
        }
      }
    }
  ]
}

IMPORTANT: Only include fields that CHANGED. If skills didn't change, omit the "skills" field entirely. If only inventory changed, only include "inventory".`;

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

IMPORTANT: Also detect when existing goals are COMPLETED, FAILED, or ABANDONED based on the narrative. Update their status accordingly.`;

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
        "involvedEntities": ["entity-id-1", "entity-id-2"],
        "consequences": "What this event means for the story going forward",
        "significance": "Why this matters narratively"
      }
    }
  ]
}

NOTE: Set "turn" to 0 — the system will fill in the actual turn number.`;

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
