const DECAYABLE_CATEGORIES = ['characters', 'locations', 'goals', 'events'];

export class DecayEngine {
    constructor(getSettings) {
        this.getSettings = getSettings;
    }

    /**
     * Apply decay to all Tier 2 entities.
     * Tier 1 (pinned) and mainCharacter never decay.
     * Tier 3 (archived) is already demoted.
     */
    applyDecay(memoryStore, currentTurn) {
        const settings = this.getSettings();
        const { decayFactor, demotionThreshold } = settings;

        for (const category of DECAYABLE_CATEGORIES) {
            const entities = memoryStore.getAllEntities(category);

            for (const entity of Object.values(entities)) {
                // Tier 1 (pinned) never decays
                if (entity.tier === 1) continue;
                // Tier 3 already demoted
                if (entity.tier === 3) continue;
                // Manual entries with no baseScore — skip
                if (!entity.baseScore) continue;

                const turnsSince = currentTurn - (entity.lastMentionedTurn || 0);
                if (turnsSince <= 0) continue;

                const effectiveScore = entity.baseScore * Math.pow(decayFactor, turnsSince);
                const rounded = Math.round(effectiveScore * 10) / 10;

                memoryStore.updateEntity(category, entity.id, {
                    importance: rounded,
                });

                // Demote to Tier 3 if below threshold
                if (effectiveScore < demotionThreshold) {
                    memoryStore.updateEntity(category, entity.id, {
                        tier: 3,
                    });

                    if (settings.debugMode) {
                        console.debug(`[RP Memory] Demoted "${entity.name}" to Tier 3 (score: ${effectiveScore.toFixed(2)}, threshold: ${demotionThreshold})`);
                    }
                }
            }
        }
    }

    /**
     * Reinforce an entity when re-mentioned.
     * Resets decay counter and optionally updates importance.
     */
    reinforce(memoryStore, category, entityId, currentTurn, newImportance = null) {
        const entity = memoryStore.getEntity(category, entityId);
        if (!entity) return;

        const updates = {
            lastMentionedTurn: currentTurn,
        };

        if (newImportance !== null) {
            updates.baseScore = newImportance;
            updates.importance = newImportance;
        } else {
            // Restore base score (undo decay)
            updates.importance = entity.baseScore;
        }

        // Promote back to Tier 2 if currently archived and score is sufficient
        const threshold = this.getSettings().demotionThreshold;
        if (entity.tier === 3 && (newImportance || entity.baseScore) >= threshold) {
            updates.tier = 2;

            if (this.getSettings().debugMode) {
                console.debug(`[RP Memory] Promoted "${entity.name}" back to Tier 2`);
            }
        }

        memoryStore.updateEntity(category, entityId, updates);
    }
}
