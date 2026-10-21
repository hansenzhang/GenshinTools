/**
 * lineup-storage v1 (2026-10-18):
 *   {
 *     encounters: Array<{
 *       id, mode: "abyss" | "stygian", enemyLevel,
 *       res: Partial<Record<ElementalOrPhysical, number>>,
 *       targets, downtimeSeconds, timeBarSeconds,
 *       chamber, half,   // abyss
 *       bossId,          // stygian
 *     }>,
 *     templates, calibrations,
 *   }
 *
 * v2 (2026-10-21) adds `resPhases: ResPhase[]` to every encounter, empty for
 * the base RES throughout, and `resPhasesByBoss`, the RES phases last entered
 * for each Stygian boss.
 */
type LineupStoreV1 = {
  encounters?: Record<string, unknown>[];
  resPhasesByBoss?: Record<string, unknown>;
};

export function migrateLineupStore(
  persistedState: unknown,
  version: number
): unknown {
  const state = { ...((persistedState ?? {}) as LineupStoreV1) };
  if (version < 2) {
    state.encounters = (state.encounters ?? []).map((encounter) => ({
      ...encounter,
      resPhases: [],
    }));
    state.resPhasesByBoss = {};
  }
  return state;
}
