/**
 * End-to-end test using ZH-4O dataset (MOOM benchmark).
 *
 * Feeds Chinese RP dialogue through the full pipeline:
 *   Extraction → Conflict Detection → Provenance → Decay → Reflection → Embeddings
 *
 * Usage:
 *   node test/e2e-zh4o.mjs [--session N] [--turns N] [--chunk N]
 *
 * Defaults: session 0, first 60 turns, chunk size 10 (= 5 exchanges)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Load .env manually (no dependencies) ──────────────────────────────
const envFile = readFileSync(resolve(ROOT, '.env'), 'utf-8');
for (const line of envFile.split('\n')) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+)\s*$/);
    if (match) process.env[match[1]] = match[2];
}

// ── Import project modules ────────────────────────────────────────────
import { OpenRouterClient } from '../src/OpenRouterClient.js';
import { MemoryStore } from '../src/MemoryStore.js';
import { ExtractionPipeline } from '../src/ExtractionPipeline.js';
import { DecayEngine } from '../src/DecayEngine.js';
import { EmbeddingService } from '../src/EmbeddingService.js';
import { ReflectionEngine } from '../src/ReflectionEngine.js';
import { PromptInjector } from '../src/PromptInjector.js';

// ── CLI args ──────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { session: 0, turns: 60, chunk: 10 };
    for (let i = 0; i < args.length; i += 2) {
        if (args[i] === '--session') opts.session = parseInt(args[i + 1], 10);
        if (args[i] === '--turns') opts.turns = parseInt(args[i + 1], 10);
        if (args[i] === '--chunk') opts.chunk = parseInt(args[i + 1], 10);
    }
    return opts;
}

// ── Settings ──────────────────────────────────────────────────────────
function createSettings() {
    return {
        enabled: true,
        apiKey: process.env.OPENROUTER_API_KEY,
        model: 'google/gemini-3-flash-preview',
        embeddingModel: 'google/gemini-embedding-001',
        embeddingsEnabled: true,
        extractionInterval: 2,
        messagesPerExtraction: 5,
        maxRetries: 2,
        decayFactor: 0.95,
        demotionThreshold: 5.0,
        tokenBudget: 4000,
        userMessageWeight: 'high',
        debugMode: true,
        reflectionEnabled: true,
        reflectionThreshold: 30,
        maxBeats: 200,
        maxReflections: 30,
        beatBudgetPercent: 25,
        reflectionBudgetPercent: 15,
        language: 'zh',
    };
}

// ── Load ZH-4O data ───────────────────────────────────────────────────
function loadSession(sessionIndex) {
    const dataPath = resolve(ROOT, '..', 'MOOM-Roleplay-Dialogue', 'data', 'ZH-4O_dataset.jsonl');
    const lines = readFileSync(dataPath, 'utf-8').trim().split('\n');
    if (sessionIndex >= lines.length) {
        throw new Error(`Session ${sessionIndex} not found (max: ${lines.length - 1})`);
    }
    return JSON.parse(lines[sessionIndex]);
}

/**
 * Convert ZH-4O messages to SillyTavern chat format.
 * ZH-4O: { sender_name, text, flag }  (G=bot, U=user, GC=bot continuation, L=narration)
 * ST:    { name, mes, is_user, is_system }
 */
function convertToSTChat(zh4oMessages, botName, userName) {
    return zh4oMessages.map(msg => ({
        name: msg.sender_name,
        mes: msg.text,
        is_user: msg.flag === 'U',
        is_system: false,
    }));
}

// ── Logging helpers ───────────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function header(text) { console.log(`\n${BOLD}${CYAN}${'═'.repeat(60)}${RESET}`); console.log(`${BOLD}${CYAN}  ${text}${RESET}`); console.log(`${BOLD}${CYAN}${'═'.repeat(60)}${RESET}`); }
function ok(text) { console.log(`  ${GREEN}✓${RESET} ${text}`); }
function warn(text) { console.log(`  ${YELLOW}⚠${RESET} ${text}`); }
function fail(text) { console.log(`  ${RED}✗${RESET} ${text}`); }
function info(text) { console.log(`  ${DIM}${text}${RESET}`); }

// ── Provenance inspector ──────────────────────────────────────────────
function inspectProvenance(memoryStore) {
    const issues = [];
    const stats = { total: 0, wrapped: 0, plain: 0, missingSourceTurns: 0 };

    const checkEntity = (entity, label) => {
        if (!entity || !entity.fields) return;
        for (const [key, val] of Object.entries(entity.fields)) {
            stats.total++;
            if (val && typeof val === 'object' && 'value' in val) {
                stats.wrapped++;
                if (!Array.isArray(val.sourceTurns) || val.sourceTurns.length === 0) {
                    stats.missingSourceTurns++;
                    issues.push(`${label}.${key}: provenance-wrapped but sourceTurns is empty`);
                }
            } else {
                stats.plain++;
                issues.push(`${label}.${key}: plain value (not provenance-wrapped) = ${JSON.stringify(val).slice(0, 80)}`);
            }
        }
    };

    // Main character
    const mc = memoryStore.getMainCharacter();
    if (mc) checkEntity(mc, `mainCharacter/${mc.name}`);

    // All categories
    for (const cat of ['characters', 'locations', 'goals', 'events']) {
        const all = memoryStore.getAllEntities(cat);
        for (const [id, entity] of Object.entries(all)) {
            checkEntity(entity, `${cat}/${id}`);
        }
    }

    return { stats, issues };
}

// ── Conflict inspector ────────────────────────────────────────────────
function inspectConflicts(memoryStore) {
    const conflicts = memoryStore.getConflicts();
    const details = [];

    for (const { category, entity, conflicts: unresolvedConflicts } of conflicts) {
        for (const c of unresolvedConflicts) {
            details.push({
                category,
                entity: entity.name,
                entityId: entity.id,
                field: c.field,
                oldValue: typeof c.oldValue === 'string' ? c.oldValue.slice(0, 100) : c.oldValue,
                newValue: typeof c.newValue === 'string' ? c.newValue.slice(0, 100) : c.newValue,
                detectedTurn: c.detectedTurn,
            });
        }
    }

    return details;
}

function countAutoResolved(memoryStore) {
    let count = 0;
    for (const cat of ['mainCharacter', 'characters', 'locations', 'goals', 'events']) {
        const entities = memoryStore.getAllEntities(cat);
        for (const entity of Object.values(entities)) {
            count += (entity.conflicts || []).filter(c => c.resolved && c.autoResolved).length;
        }
    }
    return count;
}

// ── Main test ─────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs();
    const settings = createSettings();

    header(`ZH-4O E2E Test — Session ${opts.session}, ${opts.turns} turns, chunk ${opts.chunk}`);

    // Load session
    const session = loadSession(opts.session);
    const botName = session.role_meta.primary_bot_name;
    const userName = session.role_meta.user_name;
    info(`Bot: ${botName} | User: ${userName} | Total msgs: ${session.messages.length}`);

    const slicedMessages = session.messages.slice(0, opts.turns);
    const chat = convertToSTChat(slicedMessages, botName, userName);
    info(`Using ${chat.length} messages for test`);

    // ── Initialize components ─────────────────────────────────────────
    const getSettings = () => settings;
    const getLang = () => 'zh';

    const apiClient = new OpenRouterClient(getSettings);
    apiClient.setKeyResolver(async () => settings.apiKey);

    const memoryStore = new MemoryStore();
    const decayEngine = new DecayEngine(getSettings);
    const embeddingService = new EmbeddingService(apiClient, getSettings, getLang);
    const pipeline = new ExtractionPipeline(apiClient, memoryStore, getSettings, decayEngine, getLang);
    const reflectionEngine = new ReflectionEngine(apiClient, memoryStore, getSettings, getLang);

    // ── Phase 1: API connectivity test ────────────────────────────────
    header('Phase 1: API Connectivity');
    try {
        const testOk = await apiClient.testConnection();
        if (testOk) ok('OpenRouter connection OK (Gemini 3 Flash Preview)');
        else fail('Connection test returned unexpected response');
    } catch (err) {
        fail(`Connection test failed: ${err.message}`);
        process.exit(1);
    }

    // Test embedding API
    try {
        const [emb] = await embeddingService.embedTexts(['测试嵌入']);
        if (emb && emb.length > 0) ok(`Embedding API OK (dim=${emb.length}, model=gemini-embedding-001)`);
        else fail('Embedding returned empty vector');
    } catch (err) {
        fail(`Embedding test failed: ${err.message}`);
        warn('Continuing without embeddings...');
        settings.embeddingsEnabled = false;
    }

    // ── Phase 2: Chunked extraction ───────────────────────────────────
    header('Phase 2: Extraction Pipeline');

    const chunkSize = opts.chunk;
    const chunks = [];
    for (let i = 0; i < chat.length; i += chunkSize) {
        chunks.push(chat.slice(i, i + chunkSize));
    }
    info(`${chunks.length} chunks of ~${chunkSize} messages each`);

    const extractionTimings = [];
    let extractionErrors = 0;

    for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        memoryStore.incrementTurn();
        const turn = memoryStore.getTurnCounter();

        // Build a context object mimicking SillyTavern
        const context = {
            chat: chat.slice(0, (ci + 1) * chunkSize), // All messages up to current chunk
            name1: userName,
            name2: botName,
        };

        const start = Date.now();
        try {
            await pipeline.extract(context);
            const elapsed = Date.now() - start;
            extractionTimings.push(elapsed);
            memoryStore.setLastExtractionTurn(turn);

            // Apply decay
            decayEngine.applyDecay(memoryStore, turn);

            // Enforce caps — matches production lifecycle (index.js)
            memoryStore.enforceMaxBeats(settings.maxBeats);
            memoryStore.pruneEvents(6, 10);
            memoryStore.pruneGoals(5, turn);

            // Post-extraction: compress + reflect — matches production pattern
            await reflectionEngine.compress();
            if (reflectionEngine.shouldReflect()) {
                await reflectionEngine.reflect();
            }

            const counts = memoryStore.getCounts();
            ok(`Chunk ${ci + 1}/${chunks.length} (turn ${turn}): ${elapsed}ms | ` +
                `chars=${counts.characters} locs=${counts.locations} goals=${counts.goals} ` +
                `events=${counts.events} beats=${counts.beats} refs=${counts.reflections} MC=${counts.mainCharacter ? 'yes' : 'no'}`);
        } catch (err) {
            extractionErrors++;
            const elapsed = Date.now() - start;
            fail(`Chunk ${ci + 1}/${chunks.length} failed (${elapsed}ms): ${err.message}`);
        }

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
    }

    const avgTime = extractionTimings.length > 0
        ? Math.round(extractionTimings.reduce((a, b) => a + b, 0) / extractionTimings.length)
        : 0;
    info(`Average extraction time: ${avgTime}ms | Errors: ${extractionErrors}/${chunks.length}`);

    // ── Phase 3: Provenance audit ─────────────────────────────────────
    header('Phase 3: Provenance Audit');

    const prov = inspectProvenance(memoryStore);
    ok(`Total fields: ${prov.stats.total}`);
    ok(`Provenance-wrapped: ${prov.stats.wrapped} (${prov.stats.total ? Math.round(100 * prov.stats.wrapped / prov.stats.total) : 0}%)`);

    if (prov.stats.plain > 0) {
        warn(`Plain (unwrapped) fields: ${prov.stats.plain}`);
        for (const issue of prov.issues.filter(i => i.includes('plain value')).slice(0, 5)) {
            info(`  → ${issue}`);
        }
        if (prov.issues.filter(i => i.includes('plain value')).length > 5) {
            info(`  → ... and ${prov.issues.filter(i => i.includes('plain value')).length - 5} more`);
        }
    }
    if (prov.stats.missingSourceTurns > 0) {
        warn(`Missing sourceTurns: ${prov.stats.missingSourceTurns}`);
        for (const issue of prov.issues.filter(i => i.includes('sourceTurns')).slice(0, 3)) {
            info(`  → ${issue}`);
        }
    }

    // Check for multi-update provenance (sourceTurns with >1 entry = field was updated across extractions)
    let multiUpdateCount = 0;
    const checkMultiUpdate = (entity) => {
        if (!entity?.fields) return;
        for (const val of Object.values(entity.fields)) {
            if (val?.sourceTurns?.length > 1) multiUpdateCount++;
        }
    };
    const mc = memoryStore.getMainCharacter();
    if (mc) checkMultiUpdate(mc);
    for (const cat of ['characters', 'locations', 'goals', 'events']) {
        for (const entity of Object.values(memoryStore.getAllEntities(cat))) {
            checkMultiUpdate(entity);
        }
    }
    ok(`Fields with multi-turn provenance trail: ${multiUpdateCount}`);

    // ── Phase 4: Conflict detection audit ─────────────────────────────
    header('Phase 4: Conflict Detection');

    const conflicts = inspectConflicts(memoryStore);
    ok(`Total unresolved conflicts: ${conflicts.length}`);

    if (conflicts.length > 0) {
        for (const c of conflicts.slice(0, 10)) {
            info(`  ${c.category}/${c.entity} [${c.field}] @ turn ${c.detectedTurn}`);
            info(`    old: "${c.oldValue}"`);
            info(`    new: "${c.newValue}"`);
        }
        if (conflicts.length > 10) {
            info(`  ... and ${conflicts.length - 10} more`);
        }
    } else {
        info('No conflicts detected — this could mean:');
        info('  (a) All field updates were consistent (good!)');
        info('  (b) Conflict detection may not be triggering properly (check below)');
    }

    // Verify conflict detection mechanics
    const totalConflictsByCategory = {};
    for (const cat of ['mainCharacter', 'characters', 'locations', 'goals', 'events']) {
        const entities = memoryStore.getAllEntities(cat);
        let catConflicts = 0;
        for (const entity of Object.values(entities)) {
            catConflicts += (entity.conflicts || []).length;
        }
        if (catConflicts > 0) totalConflictsByCategory[cat] = catConflicts;
    }
    const autoResolvedCount = countAutoResolved(memoryStore);
    ok(`Total conflicts (including resolved): ${JSON.stringify(totalConflictsByCategory)}`);
    if (autoResolvedCount > 0) {
        ok(`Auto-resolved (stale after 10 turns): ${autoResolvedCount}`);
    }

    // ── Phase 5: Reflection summary ─────────────────────────────────
    // Reflections now fire during extraction (matching production).
    // This phase reports what was generated, and runs one final reflection
    // if there are still unreflected beats.
    header('Phase 5: Reflection Engine');

    const existingReflections = memoryStore.getReflections();
    ok(`Reflections generated during extraction: ${existingReflections.length}`);
    for (const ref of existingReflections.slice(-5)) {
        info(`  [${ref.type}/${ref.horizon}] ${ref.text.slice(0, 100)}...`);
        info(`    participants: ${ref.participants.join(', ') || '(none)'} | importance: ${ref.importance}`);
    }

    // Final reflection pass if beats accumulated since last reflection
    const shouldReflectFinal = reflectionEngine.shouldReflect();
    if (shouldReflectFinal) {
        const start = Date.now();
        try {
            const reflected = await reflectionEngine.reflect();
            const elapsed = Date.now() - start;
            if (reflected) {
                const allReflections = memoryStore.getReflections();
                ok(`Final reflection pass: ${allReflections.length - existingReflections.length} new (${elapsed}ms)`);
            } else {
                warn(`Final reflection returned false (${elapsed}ms)`);
            }
        } catch (err) {
            fail(`Final reflection failed: ${err.message}`);
        }
    } else {
        ok('No unreflected beats remaining — all beats were covered during extraction');
    }

    // ── Phase 6: Embedding & ranking ──────────────────────────────────
    let phase6Ranked = null;
    let phase6SceneType = null;
    let phase6RankedBeats = null;
    let phase6RankedReflections = null;

    if (settings.embeddingsEnabled) {
        header('Phase 6: Embedding & Ranking');

        // Get recent message texts for context
        const recentTexts = chat.slice(-10).map(m => m.mes);
        const currentTurn = memoryStore.getTurnCounter();

        try {
            const { ranked, sceneType } = await embeddingService.rankEntities(memoryStore, recentTexts, currentTurn);
            phase6Ranked = ranked;
            phase6SceneType = sceneType;
            ok(`Scene type detected: ${sceneType}`);
            ok(`Entities ranked: ${ranked.length}`);

            if (ranked.length > 0) {
                info('Top 10 entities by tri-score:');
                for (const r of ranked.slice(0, 10)) {
                    info(`  ${r.score.toFixed(3)} | ${r.category}/${r.entity.name} (tier ${r.entity.tier}, imp ${r.entity.importance})`);
                }
            }

            // Rank beats
            phase6RankedBeats = await embeddingService.rankBeats(memoryStore, recentTexts, currentTurn);
            ok(`Beats ranked: ${phase6RankedBeats.length}`);
            if (phase6RankedBeats.length > 0) {
                info('Top 5 beats by relevance:');
                for (const rb of phase6RankedBeats.slice(0, 5)) {
                    info(`  ${rb.score.toFixed(3)} | ${rb.beat.text.slice(0, 80)}...`);
                }
            }

            // Rank reflections if any
            phase6RankedReflections = await embeddingService.rankReflections(memoryStore, recentTexts, currentTurn);
            if (phase6RankedReflections.length > 0) {
                ok(`Reflections ranked: ${phase6RankedReflections.length}`);
                for (const rr of phase6RankedReflections.slice(0, 3)) {
                    info(`  ${rr.score.toFixed(3)} | ${rr.reflection.text.slice(0, 80)}...`);
                }
            }
        } catch (err) {
            fail(`Embedding/ranking failed: ${err.message}`);
        }
    }

    // ── Phase 7: Final state dump ─────────────────────────────────────
    header('Phase 7: Final Memory State');

    const finalCounts = memoryStore.getCounts();
    ok(`Characters: ${finalCounts.characters}`);
    ok(`Locations: ${finalCounts.locations}`);
    ok(`Main Character: ${finalCounts.mainCharacter ? 'tracked' : 'missing'}`);
    ok(`Goals: ${finalCounts.goals}`);
    ok(`Events: ${finalCounts.events}`);
    ok(`Beats: ${finalCounts.beats}`);
    ok(`Reflections: ${finalCounts.reflections}`);

    // Dump entities
    const mc2 = memoryStore.getMainCharacter();
    if (mc2) {
        info(`\nMain Character: ${mc2.name}`);
        for (const [key, val] of Object.entries(mc2.fields || {})) {
            const plain = val?.value ?? val;
            const turns = val?.sourceTurns ? ` [turns: ${val.sourceTurns.join(',')}]` : '';
            info(`  ${key}: ${String(plain).slice(0, 120)}${turns}`);
        }
    }

    for (const cat of ['characters', 'locations', 'goals', 'events']) {
        const entities = memoryStore.getAllEntities(cat);
        const entries = Object.entries(entities);
        if (entries.length > 0) {
            info(`\n${cat.toUpperCase()} (${entries.length}):`);
            for (const [id, entity] of entries.slice(0, 8)) {
                info(`  [${id}] ${entity.name} | tier=${entity.tier} imp=${entity.importance} conflicts=${(entity.conflicts || []).length}`);
                for (const [key, val] of Object.entries(entity.fields || {})) {
                    const plain = val?.value ?? val;
                    const turns = val?.sourceTurns ? ` [turns: ${val.sourceTurns.join(',')}]` : '';
                    info(`    ${key}: ${String(plain).slice(0, 100)}${turns}`);
                }
            }
            if (entries.length > 8) info(`  ... and ${entries.length - 8} more`);
        }
    }

    // ── Phase 8: Injection Output ────────────────────────────────────
    header('Phase 8: Injection Output (what the RP model sees)');

    const injector = new PromptInjector(() => settings, getLang);
    const currentTurnFinal = memoryStore.getTurnCounter();

    // Build reflections list for injection (top-ranked or recent)
    const injectReflections = phase6RankedReflections
        ? phase6RankedReflections.map(rr => rr.reflection)
        : memoryStore.getRecentReflections(10);

    const injectionText = injector.format(
        memoryStore,
        phase6Ranked || null,
        phase6SceneType || null,
        currentTurnFinal,
        phase6RankedBeats || null,
        injectReflections,
    );

    const { estimateTokens } = await import('../src/Utils.js');
    const injectionTokens = estimateTokens(injectionText);

    ok(`Injection tokens: ~${injectionTokens} (budget: ${settings.tokenBudget})`);
    ok(`Scene type: ${phase6SceneType || 'none'}`);
    console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(injectionText);
    console.log(`${DIM}${'─'.repeat(60)}${RESET}\n`);

    // ── Summary ───────────────────────────────────────────────────────
    header('Test Summary');

    const pass = extractionErrors === 0;
    const provenanceOk = prov.stats.plain === 0;
    const conflictDetectionWorking = conflicts.length > 0 || multiUpdateCount > 0;

    const beatsUnderCap = finalCounts.beats <= (settings.maxBeats || 200);
    console.log(`
  ${pass ? GREEN + '✓' : RED + '✗'}${RESET} Extraction:           ${extractionErrors === 0 ? 'all chunks succeeded' : `${extractionErrors} failures`}
  ${provenanceOk ? GREEN + '✓' : YELLOW + '⚠'}${RESET} Provenance:           ${prov.stats.wrapped}/${prov.stats.total} fields wrapped (${provenanceOk ? '100%' : prov.stats.total ? Math.round(100 * prov.stats.wrapped / prov.stats.total) + '%' : 'N/A'})
  ${conflicts.length > 0 ? GREEN + '✓' : YELLOW + '⚠'}${RESET} Conflict detection:   ${conflicts.length} unresolved / ${autoResolvedCount} auto-resolved / ${Object.values(totalConflictsByCategory).reduce((a, b) => a + b, 0) || 0} total
  ${multiUpdateCount > 0 ? GREEN + '✓' : YELLOW + '⚠'}${RESET} Multi-turn tracking:  ${multiUpdateCount} fields updated across extractions
  ${finalCounts.beats > 0 ? GREEN + '✓' : RED + '✗'}${RESET} Beats:                ${finalCounts.beats} (cap: ${settings.maxBeats || 200}, ${beatsUnderCap ? 'under cap' : 'AT CAP'})
  ${finalCounts.reflections > 0 ? GREEN + '✓' : YELLOW + '⚠'}${RESET} Reflections:          ${finalCounts.reflections} generated (during extraction + final pass)
  ${GREEN}✓${RESET} Pruning:              goals=${finalCounts.goals} events=${finalCounts.events} (post-prune)
  ${GREEN}✓${RESET} Model:                gemini-3-flash-preview (LLM) + gemini-embedding-001 (embed)
  ${GREEN}✓${RESET} Dataset:              ZH-4O session ${opts.session} (${chat.length} msgs)
  ${DIM}  Avg extraction time:  ${avgTime}ms${RESET}
`);

    // Exit with error code if critical failures
    if (extractionErrors > Math.ceil(chunks.length * 0.5)) {
        console.log(`${RED}FAIL: More than 50% of extractions failed${RESET}`);
        process.exit(1);
    }

    console.log(`${GREEN}${BOLD}Test complete.${RESET}`);
}

main().catch(err => {
    console.error(`${RED}Fatal error: ${err.message}${RESET}`);
    console.error(err.stack);
    process.exit(1);
});
