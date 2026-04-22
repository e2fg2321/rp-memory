# RP Memory System — Build Plan

> **Status update 2026-04-22**: mem promoted to active main bet per the 2026-04-21
> portfolio decision. Per-session plan lives here (portfolio-level memory stays at
> `~/.claude/projects/-Users-apple-Desktop/memory/project_portfolio.md`). Phase 1.5
> (narrative agency layer) added below — prototypes in this SillyTavern extension,
> will port to the standalone Phase 3 platform once validated.

## Current Status

**Phase 1 — SillyTavern Extension MVP: ~95% complete (code done, needs live testing)**
**Phase 1.5 — Narrative Agency Layer (NPC agendas + plot director): scaffolded 2026-04-22, needs live testing**

| Task | Status |
|---|---|
| Extension file structure + manifest | DONE |
| Data model (5 categories, 3 tiers) | DONE |
| MemoryStore with full CRUD | DONE |
| Settings panel UI (3 tabs: Memory/Settings/Conflicts) | DONE |
| Entity viewer/editor (add/edit/delete/pin per category) | DONE |
| Per-chat persistence via chatMetadata | DONE |
| Prompt injection (Tier 1+2 via setExtensionPrompt) | DONE |
| OpenRouter API client (retries, rate limiting) | DONE |
| Unified extraction prompt (all 5 categories, single call) | DONE |
| Extraction pipeline (single API call, unified parse + merge) | DONE |
| User input priority weighting in extraction | DONE |
| Decay engine (Tier 2→3 demotion) | DONE |
| Tier 3→2 re-promotion on re-mention (via reinforce) | DONE |
| Conflict detection + resolution UI | DONE |
| Token budget display + optional cap | DONE |
| Time tracking (currentLocation, currentTime on MC) | DONE |
| NPC presence tracking (present field) | DONE |
| Per-category operation constraints in prompts | DONE |
| Test in actual SillyTavern | TODO |
| Fix bugs from live testing | TODO |
| Extraction prompt tuning on real RP transcripts | TODO |

**Extension location:** `SillyTavern/public/scripts/extensions/third-party/rp-memory/`
**Source location:** `/Users/apple/Desktop/mem/rp-memory/`

---

## Architecture

### Entity Model (5 Categories, User-Editable)

Each category has its own schema with tailored fields. All extracted in a single unified API call.

1. **Characters (NPCs)** — description, personality, status, relationships, present (on-scene yes/no)
2. **Locations** — description, atmosphere, notable features, connections
3. **Main Character** — skills, inventory, health, conditions, buffs, currentLocation, currentTime
4. **Active Goals/Tasks** — description, progress, blockers, status (in_progress/completed/failed/abandoned)
5. **Major Events** — description, turn, involvedEntities, consequences, significance

Per-category operation constraints:
- **characters**: add + update, never delete (mark status as dead/missing)
- **locations**: add + update, never delete
- **mainCharacter**: update only, single entity (id: "main-character")
- **goals**: add + update, never delete (use status field)
- **events**: insert only, never update or delete

All categories exposed in the frontend. Users can view, edit, add, and remove entries directly.

### Memory Tiers

**Tier 1 — Always In Context (Pinned)**
- High-importance memories (score >= 8)
- Compacted into structured summaries injected into every prompt
- Never decays — pinned until user removes or system compacts further
- This is the core consistency layer

**Tier 2 — In Context, Subject to Decay**
- Moderate-importance memories (score 4-7)
- In context by default but decays over turns
- Decay formula: `effective_score = base_score * (0.95 ^ turns_since_last_mention)`
- Below threshold (default 5.0) → demoted to Tier 3

**Tier 3 — Archived**
- Demoted memories from Tier 2
- Stored as JSON, not in prompt
- Re-promoted to Tier 2 when re-mentioned (reinforce resets decay, restores score)
- Phase 2: vector embeddings for semantic retrieval

### Processing Pipeline

```
AI responds → CHARACTER_MESSAGE_RENDERED event fires
    → onNewMessage() (non-blocking)
        → Increment turn counter
        → Check extraction interval (default: every 2 exchanges)
        → Apply decay to Tier 2 entities (synchronous, pure math)
        → Trigger async extraction:
            → 1 unified OpenRouter call (all 5 categories)
            → System prompt: unified schema + operation rules
            → User prompt: full memory state + last N messages
            → Parse unified JSON response
            → Merge each category into MemoryStore (detect conflicts)
            → Reinforce re-mentioned entities (Tier 3→2 promotion)
            → Save to chatMetadata
            → Re-inject updated prompt
            → Update UI
```

### Key Design Decisions

- **Extraction via OpenRouter** — separate cheap model (Gemini Flash), doesn't interfere with main generation
- **Single unified call** — 1 API call extracts all 5 categories (was 5 parallel calls, consolidated for cost)
- **Diff-mode prompts** — extraction receives current state, outputs only changes
- **User input priority** — user messages marked [HIGH PRIORITY] in extraction prompts
- **Operation constraints** — per-category rules prevent destructive operations (no deleting events, no duplicating MC, etc.)
- **Time/location tracking** — currentTime and currentLocation on MC, updated every extraction
- **NPC presence** — "present" field tracks whether NPCs are on-scene for interaction
- **Conflict resolution** — latest wins + flag for user review, no judge model (v1)
- **Token budget** — uncapped by default, optional user cap, manual demotion only
- **Injection** — system prompt via setExtensionPrompt, NOT lorebook
- **Storage** — chatMetadata (persists with chat file, survives message deletion)

### Reference Analysis (蚀心入魔 / shujuku)

Studied the Chinese community's 蚀心入魔 database system for design ideas. Key takeaways:

**Adopted:**
- Time tracking (their 全局数据表 → our MC currentTime/currentLocation)
- NPC presence tracking (their 是否离场 → our "present" field)
- Per-category operation constraints (their insert/update/delete rules per table)
- Structured table schemas with explicit field definitions

**Rejected:**
- CoAT reasoning framework (MCTS/tree-search in text — no evidence it helps Flash-tier models, just burns tokens)
- LLM-based retrieval (their 剧情推进 phase — LLMs aren't good at retrieval at scale; our importance + decay + future embeddings is architecturally sounder)
- Fake scoring systems (model-generated confidence scores aren't meaningful self-evaluation)

---

## File Structure

```
rp-memory/
├── manifest.json                   Extension metadata
├── index.js                        Main entry: init, events, UI, CRUD, injection
├── settings.html                   UI template: 3 tabs, 5 categories
├── style.css                       All custom styling
├── src/
│   ├── MemoryStore.js              Data model + CRUD
│   ├── ExtractionPipeline.js       Single-call extraction orchestrator + merge
│   ├── ExtractionPrompts.js        Unified + per-category prompts
│   ├── PromptInjector.js           Formats Tier 1+2 for injection
│   ├── OpenRouterClient.js         OpenRouter API client (retries, rate limiting)
│   ├── DecayEngine.js              Decay math + demotion + reinforce/re-promotion
│   └── Utils.js                    ID generation, token estimation
```

---

## Implementation Phases

### Phase 1 — SillyTavern Extension MVP (CURRENT)
**Goal:** Prove tiered memory works better than existing solutions

Remaining:
- Live testing in SillyTavern
- Bug fixes from testing
- Tune extraction prompts against real RP transcripts

Success metric: noticeably better consistency over 100+ turn sessions

### Phase 1.5 — Narrative Agency Layer (CURRENT — scaffolded 2026-04-22)
**Goal:** Fix the long-context "story dies, AI echoes user" failure mode by giving
NPCs independent agendas and the scene a forward-looking beat plan.

**Problem this solves:** Current LLM roleplay collapses over long context because
models are trained to be helpful-reactive. With low-info user input, the scene
stalls and drifts to generic tropes. User input alone isn't enough narrative
signal — we need authorial agency running alongside.

**Design (Stanford generative-agents pattern adapted to chat RP):**

```
Every N turns (default 3), after extraction + reflection:
  1. NPCReflector: for each "present" NPC, one small LLM call →
       { agenda, innerState, lastObservation }
       Uses reflectorModel (cheap, parallel). Capped at directorMaxNPCs.
  2. PlotDirector: single LLM call consuming
       NPC agendas + MC goals + recent beats + reflections + author direction
       + recent messages + existing plan →
       { arcBeats (3-5 forward-looking), pacingSignal, sceneAssessment }
       Uses directorModel (stronger; expensive to screw up).
  3. NarrativeInjector: formats plan + agendas into a prompt block with
       stronger framing than passive world-state memory. Injected via a
       separate setExtensionPrompt key ('rp_memory_director') at shallower
       depth so the model reads it as close-in directive framing.
```

**Key design decisions:**

- **Separate injection key**: `rp_memory_director` is distinct from `MODULE_NAME`
  so the director block composes with (doesn't replace) the world-state block.
- **Cadence independent of extraction**: director has its own `directorInterval`
  setting (default 3 vs extraction default 2).
- **Model split supported natively**: `chatCompletion()` already accepts
  `modelOverride`. Cheap model for NPC reflector, strong model for director.
- **Naming**: existing `ReflectionEngine` operates on past "beats" (event records).
  New layer uses `arcBeats` (forward-looking intents) + `npcAgendas` — distinct
  vocabulary, no collision.
- **OOC override reuse**: leverages existing OOC overlay + `setExtensionPrompt`
  depth-0 mechanism for user override. Director adapts naturally each cadence
  tick based on new user input via its "previous plan" consumption.
- **Author Direction still top-level**: user's persistent `authorDirection` feeds
  into the director as a long-range constraint. Director plan is short-range
  (3-5 turns) in service of it.
- **Visible plan panel (debug/prototype)**: `directorVisible=true` by default
  shows the live plan in the new "Director" settings tab. Toggle off once the
  mechanism is validated and we want full immersion.

**New files:**
```
src/NPCReflector.js        Per-NPC agenda update (parallel, cheap model)
src/PlotDirector.js        Arc-beat plan + pacing signal (one call, strong model)
src/NarrativeInjector.js   Formats plan + agendas into injection block
```

**MemoryStore extensions (v5 → v6):**
```
directorPlan: { arcBeats: [...], pacingSignal, sceneAssessment, lastUpdatedTurn }
npcAgendas: { [charId]: { agenda, innerState, lastObservation, lastUpdatedTurn } }
lastDirectorTurn: number
```
Backward-compat: v2-v5 states auto-migrate; older versions reset.

**Hook point:** `triggerExtraction`'s post-extraction callback (index.js ~L1791).
Non-blocking — director runs async after reflection settles, re-injects on completion.

**New settings (defaultSettings):**
- `directorEnabled` (default false — opt-in for safety during prototype)
- `directorInterval` (3)
- `directorMaxNPCs` (4)
- `directorInjectionDepth` (1)
- `directorModel` / `reflectorModel` (empty → falls back)
- `directorVisible` (true for prototype)

**Testing plan:**
1. Enable Director in a fresh chat with 2-3 NPCs marked present.
2. Play 10 low-info turns ("I look around", "Hmm.") — verify the scene advances
   via NPC agendas rather than echoing user input.
3. Inspect the live panel: arc beats should revise, NPC agendas should reflect
   each character's personality, not converge.
4. Submit OOC override mid-stream — verify director absorbs it at next cadence.
5. Compare 100-turn session with/without Director for drift.

**Success metric:** user feels the story has forward momentum in low-info stretches,
and NPCs feel like they have independent agendas rather than mirroring the MC.

**Priors referenced (from design conversation 2026-04-22):**
- Façade (Mateas & Stern, 2005) — beat-based drama manager
- Left 4 Dead AI Director (Valve, 2008) — pacing model
- Stanford Generative Agents (Park et al, 2023) — memory stream + reflection + planning per agent
- AI Dungeon / SillyTavern summary-based memory — demonstrated the failure mode we're fixing

### Phase 2 — Proper Retrieval Layer
**Goal:** Add real vector retrieval for Tier 3

- Embed Tier 3 memories using lightweight embedding model
- Local vector store (in-browser or lightweight server-side)
- Retrieval is supplementary, not critical path
- Confidence threshold: low confidence → deep search raw text
- Purge policy for very old Tier 3 entries

### Phase 3 — Standalone Hosted Platform
**Goal:** Own the stack

- Own frontend with built-in RP interface
- Own memory backend (no more metadata hacks)
- Model routing: cheap model for extraction, best available for conversation
- Multi-session world persistence
- Full memory inspector (see/edit what the system remembers)
- Free tier, premium for power users

### Phase 4 — Fine-tuned Model
**Goal:** Build the moat

- Training data from Phase 1-3 usage as byproduct
- Fine-tune open-source base (Qwen / DeepSeek / best at that point)
- Optimized for: reading structured world state, consistency, memory-aware generation
- Closed source weights = defensible advantage

---

## Technical Decisions to Test

| Question | Approach |
|---|---|
| Extraction model? | Start Gemini Flash, benchmark against DeepSeek/Qwen |
| Tier 1 + 2 context budget? | Default uncapped, optional user-set cap |
| Decay rate? | Start 0.95/turn, log scores, tune empirically |
| Tier 3 retrieval method? | Start keyword re-promotion, upgrade to embeddings Phase 2 |
| Compaction format? | Structured templates per category, LLM fills them |

---

## Competitive Positioning

- **vs 蚀心入魔**: Non-blocking, importance tiering, better retrieval design, no freezing, no fake reasoning overhead
- **vs Character.ai**: Uncensored, user-controlled, good memory, transparent
- **vs SillyTavern raw**: Memory without manual lorebook curation
- **vs nothing**: 100k likes on a janky version proves the demand

---

## Open Questions

- How aggressively can Tier 1 compact before losing RP texture (tone, voice, emotion)?
- Decay tuning: 0.95 per turn? 0.98? Needs empirical testing
- Handling user retcons / contradictions beyond latest-wins?
- Multi-user RP: conflicting entity descriptions from different players?
- Degradation point: 500 turns? 1000? 5000?
- Batching: if user sends multiple messages before extraction finishes, queue or batch?
- Cost at scale: extraction calls on 1000+ turn sessions — acceptable?
