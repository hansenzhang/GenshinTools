import "@/providers/reference/statLoaders";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { planAbyssChambers } from "@/domain/combat/lineup/abyssPairs";
import {
  candidateArtifactIds,
  canFieldTogether,
} from "@/domain/combat/lineup/candidateConflicts";
import type { MainStat, Slot, SubStat } from "@/domain/enums";
import type { AccountData, ArtifactData, CharacterData } from "@/domain/models";
import {
  type CharacterStatsMap,
  characterStatsResource,
  type WeaponStatsMap,
  weaponStatsResource,
} from "@/domain/reference/stats";
import {
  captureTeamReferenceBuild,
  createAbyssEncounter,
  createTeamTemplate,
} from "@/domain/team/lineup";
import type {
  LineupSolverMessage,
  LineupSolverRequest,
  LineupSolverResult,
  LineupSolverTeam,
} from "@/domain/team/lineupSolverTypes";
import type { Calibration, Encounter } from "@/domain/team/lineupTypes";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";
import type { TeamComp, TeamSetupConfig } from "@/domain/team/types";
import { runLineupSolver } from "@/services/combat/lineup/lineupSolver";

// Small inventories finish quickly; short runs and narrow screens keep the
// suite light.
vi.mock("@/domain/combat/lineup/constants", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/domain/combat/lineup/constants")
  >()),
  SET_MIN_RUN_MS: 500,
  SET_GENERATED_REFINE_COUNT: 4,
}));

let chars: CharacterStatsMap;
let weapons: WeaponStatsMap;
beforeAll(async () => {
  [chars, weapons] = await Promise.all([
    characterStatsResource.preload(),
    weaponStatsResource.preload(),
  ]);
});

const SLOTS: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];
const CW = "crimson_witch_of_flames";

function pieces(
  id: string,
  setKey: string,
  mains: [MainStat, MainStat, MainStat],
  substats: Partial<Record<SubStat, number>>
): ArtifactData[] {
  const slotMains: MainStat[] = ["hp", "atk", ...mains];
  return SLOTS.map((slotKey, index) => ({
    id: `${id}-${slotKey}`,
    setKey,
    slotKey,
    level: 20,
    rarity: 5,
    mainStatKey: slotMains[index],
    lock: false,
    substats,
  }));
}

// Both Pyro carries want the great Crimson Witch set; the supports' sets
// matter little.
const GREAT_CW = pieces("great", CW, ["atk%", "pyro%", "cr"], {
  cr: 10,
  cd: 20,
  "atk%": 10,
});
const POOR_CW = pieces("poor", CW, ["def%", "def%", "def%"], { def: 40 });
const NOBLESSE = pieces("noblesse", "noblesse_oblige", ["er", "hp%", "hp%"], {
  er: 10,
  "hp%": 10,
});
const EMBLEM = pieces(
  "emblem",
  "emblem_of_severed_fate",
  ["er", "hydro%", "cr"],
  {
    er: 10,
    cr: 5,
  }
);

const byslot = (artifacts: ArtifactData[]) =>
  Object.fromEntries(
    artifacts.map((artifact) => [artifact.slotKey, artifact])
  ) as CharacterData["artifacts"];

function character(
  key: string,
  weaponKey: string,
  artifacts: ArtifactData[]
): CharacterData {
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
    artifacts: byslot(artifacts),
  };
}

// One Favonius Sword: Bennett's. Xingqiu's team also asks for it.
const account: AccountData = {
  characters: [
    character("hu_tao", "staff_of_homa", POOR_CW),
    character("xingqiu", "sacrificial_sword", EMBLEM),
    character("diluc", "wolfs_gravestone", GREAT_CW),
    character("bennett", "favonius_sword", NOBLESSE),
  ],
  extraArtifacts: [],
  extraWeapons: [],
};

function solverTeam(id: string, members: [string, string][]): LineupSolverTeam {
  const teamComp: TeamComp = teamCompInputToComp({
    id,
    characters: members.map(([charId]) => charId),
    weapons: members.map(([, weaponId]) => weaponId),
  });
  const setupConfig: TeamSetupConfig = {
    combatOptions: {},
    damage: { formulaMode: "combo" },
  };
  return {
    template: createTeamTemplate(`template-${id}`, teamComp),
    teamComp,
    setupConfig,
  };
}

const teamA = solverTeam("a", [
  ["hu_tao", "staff_of_homa"],
  ["xingqiu", "favonius_sword"],
]);
const teamB = solverTeam("b", [
  ["diluc", "wolfs_gravestone"],
  ["bennett", "favonius_sword"],
]);

function encounter(id: string, half: 1 | 2): Encounter {
  return {
    ...createAbyssEncounter(id, 1, half),
    downtimeSeconds: 10,
    timeBarSeconds: 120,
  };
}

function calibrate(team: LineupSolverTeam, encounterId: string): Calibration {
  return {
    id: `calibration-${team.template.id}`,
    templateId: team.template.id,
    encounterId,
    reference: captureTeamReferenceBuild(
      team.teamComp,
      team.setupConfig,
      account,
      1
    )!,
    measuredSeconds: 100,
    downtimeSeconds: null,
  };
}

function request(
  overrides: Partial<LineupSolverRequest> = {}
): LineupSolverRequest {
  const encounters = [encounter("first", 1), encounter("second", 2)];
  return {
    accountData: account,
    encounters,
    teams: [teamA, teamB],
    calibrations: [calibrate(teamA, "first"), calibrate(teamB, "second")],
    comboOverrides: {},
    timeBudgetSec: 1,
    ...overrides,
  };
}

async function run(input: LineupSolverRequest) {
  const messages: LineupSolverMessage[] = [];
  await runLineupSolver(input, chars, weapons, (message) =>
    messages.push(message)
  );
  return messages;
}

function finalResult(messages: LineupSolverMessage[]): LineupSolverResult {
  const last = messages.at(-1);
  if (last?.type !== "result")
    throw new Error(`Expected a result, got ${JSON.stringify(last)}`);
  return last.result;
}

describe("runLineupSolver", () => {
  it("needs a recorded Abyss clear", async () => {
    const messages = await run(request({ calibrations: [] }));
    expect(messages).toEqual([{ type: "error", reason: "no-calibrations" }]);
  });

  it("reports a half without a time bar", async () => {
    const input = request({ teams: [teamA] });
    input.encounters = input.encounters.map((entry) => ({
      ...entry,
      timeBarSeconds: null,
    }));
    input.calibrations = [calibrate(teamA, "first")];
    const result = finalResult(await run(input));
    expect(result.candidates).toEqual([]);
    expect(result.issues).toEqual([
      { templateId: "template-a", encounterId: "first", reason: "no-bar" },
    ]);
  });

  it("finds a conflict-free pairing when both halves want the same gear", async () => {
    const messages = await run(request());
    expect(messages.some((message) => message.type === "partial")).toBe(true);
    const result = finalResult(messages);
    expect(result.issues).toEqual([]);
    expect(result.weaponCopies.favonius_sword).toBe(1);
    for (const candidate of result.candidates) {
      // margin = r · (T_req − D) / (T_meas − D) with r against the clear.
      expect(candidate.margin).toBeCloseTo((candidate.ratio * 110) / 90, 10);
      expect(candidate.activeSeconds).toBeCloseTo(90 / candidate.ratio, 10);
      const ids = candidateArtifactIds(candidate);
      expect(ids).toHaveLength(10);
      expect(new Set(ids).size).toBe(10);
    }
    const first = result.candidates.filter((c) => c.encounterId === "first");
    const second = result.candidates.filter((c) => c.encounterId === "second");
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    // Both carries' best builds use the great Crimson Witch pieces, so the
    // re-runs keep each team clear of the other's pieces and the one
    // Favonius Sword.
    const origins = new Set(result.candidates.map((c) => c.origin));
    expect(origins.has("pieces-excluded")).toBe(true);
    expect(origins.has("weapon-swapped")).toBe(true);

    const [plan] = planAbyssChambers(
      request().encounters,
      result.candidates,
      result.weaponCopies,
      "per-half",
      3,
      4
    );
    expect(plan.pairings.length).toBeGreaterThan(0);
    const byId = new Map(result.candidates.map((c) => [c.id, c]));
    for (const pairing of plan.pairings) {
      const fielded = [
        byId.get(pairing.firstId!)!,
        byId.get(pairing.secondId!)!,
      ];
      expect(canFieldTogether(fielded, result.weaponCopies)).toBe(true);
      expect(pairing.margin).toBe(
        Math.min(...fielded.map((candidate) => candidate.margin))
      );
    }
  }, 120_000);
});
