import "@/providers/reference/statLoaders";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type { AccountData, CharacterData } from "@/domain/models";
import {
  type CharacterStatsMap,
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import type {
  OptRunPosition,
  SetConfigExplorerRequest,
} from "@/domain/team/setConfigExplorerTypes";
import { buildTeamSlotConfigs } from "@/domain/team/teamConfigUtils";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";
import type { TeamOptYield } from "@/domain/team/types";
import {
  optimizeAssignmentOnAccount,
  prepareTeamSetsJob,
} from "@/services/combat/lineup/setConfigExplorer";

// The browser's optimizer: per-character searches in parallel workers, each
// member dropping out of `workerBestDamage` when its search ends.
const STEPS: [Partial<TeamOptYield>, number][] = [
  [{ phase: "init" }, 5],
  [{ phase: "phase1", workerBestDamage: { hu_tao: 0, bennett: 0 } }, 5],
  [{ phase: "phase1", workerBestDamage: { hu_tao: 10 } }, 5],
  [{ phase: "phase1" }, 5],
  [{ phase: "phase2" }, 5],
  [{ phase: "phase3" }, 5],
  [{ phase: "phase3" }, 5],
];

vi.mock("@/services/combat/optimizer/teamOptimization", () => ({
  async *runTeamOptimization() {
    for (const [update, waitMs] of STEPS) {
      yield { done: false, passResults: [], ...update };
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    yield {
      done: true,
      bestDamage: 0,
      bestArtifactsByChar: {},
      passResults: [],
      failReasons: {},
    };
  },
}));

let chars: CharacterStatsMap;
beforeAll(async () => {
  [chars] = await Promise.all([
    characterStatsResource.preload(),
    weaponStatsResource.preload(),
  ]);
});

function character(key: string, weaponKey: string): CharacterData {
  return {
    key,
    level: 90,
    constellation: 0,
    talent: { auto: 10, skill: 10, burst: 10 },
    weapon: {
      id: `${key}-weapon`,
      key: weaponKey,
      refinement: 1,
      level: 90,
      lock: false,
    },
    artifacts: {},
  };
}

function request(): SetConfigExplorerRequest {
  const accountData: AccountData = {
    characters: [
      character("hu_tao", "staff_of_homa"),
      character("bennett", "favonius_sword"),
    ],
    extraArtifacts: [],
    extraWeapons: [],
  };
  const teamComp = teamCompInputToComp({
    id: "timeline",
    characters: ["hu_tao", "bennett"],
    weapons: ["staff_of_homa", "favonius_sword"],
  });
  const configs = buildTeamSlotConfigs(
    teamComp,
    { combatOptions: {} },
    accountData
  );
  const team = new TeamBuild(configs);
  const lines = Object.entries(team.catalog.getCombo("hu_tao"))
    .filter(([, count]) => count > 0)
    .map(([formulaId, count]) => ({ charId: "hu_tao", formulaId, count }));
  const context = {
    enemyLevel: 100,
    enemyRes: 0.1,
    rollMultiplier: 0.85,
    substatBudget: "8_6" as const,
  };
  return {
    teamComp,
    setupConfig: { combatOptions: {} },
    accountData,
    objective: { id: "rotation", label: { en: "R", zh: "R" }, lines },
    carryCharId: "hu_tao",
    optimizeContext: context,
    displayContext: context,
    settings: {
      useAccountArtifacts: true,
      lockedCharIds: [],
      pinned: {},
      timeBudgetSec: 0,
    },
  };
}

describe("optimizeAssignmentOnAccount", () => {
  it("records where a run's time went and reports where it is", async () => {
    const setup = prepareTeamSetsJob(request(), chars);
    if (setup.kind !== "ready") throw new Error(setup.reason);
    const positions: OptRunPosition[] = [];
    const outcome = await optimizeAssignmentOnAccount(
      setup.job,
      setup.job.current,
      null,
      new Set(),
      (position) => positions.push(position)
    );

    const phases = outcome.diagnostics?.phases ?? [];
    expect(phases.map(({ phase, round }) => [phase, round])).toEqual([
      ["init", null],
      ["phase1", null],
      ["phase2", null],
      ["phase3", 1],
      ["phase3", 2],
    ]);
    // Three phase1 steps 5 ms apart make one span.
    expect(phases[1].ms).toBeGreaterThanOrEqual(10);

    const searched = outcome.diagnostics?.memberSearchMs ?? {};
    expect(Object.keys(searched).sort()).toEqual(["bennett", "hu_tao"]);
    expect(searched.hu_tao).toBeGreaterThan(searched.bennett);

    expect(positions).toEqual([
      { phase: "phase1", round: null, searching: [] },
      { phase: "phase1", round: null, searching: ["hu_tao", "bennett"] },
      { phase: "phase1", round: null, searching: ["hu_tao"] },
      { phase: "phase1", round: null, searching: [] },
      { phase: "phase2", round: null, searching: [] },
      { phase: "phase3", round: 1, searching: [] },
      { phase: "phase3", round: 2, searching: [] },
    ]);
  });
});
