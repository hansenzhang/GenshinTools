import "@/providers/reference/statLoaders";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { planAbyssChambers } from "@/domain/combat/lineup/abyssPairs";
import {
  calibrateCandidates,
  candidateArtifactIds,
  canFieldTogether,
} from "@/domain/combat/lineup/candidates";
import { assignmentKey } from "@/domain/combat/lineup/setChoices";
import { planStygianRun } from "@/domain/combat/lineup/stygianPlan";
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
import type {
  Calibration,
  Encounter,
  StygianEncounter,
} from "@/domain/team/lineupTypes";
import type { SetAssignment } from "@/domain/team/setConfigExplorerTypes";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";
import type { TeamComp, TeamSetupConfig } from "@/domain/team/types";
import { solveMilp } from "@/services/combat/lineup/highsSolver";
import { runLineupSolver } from "@/services/combat/lineup/lineupSolver";
import { loadTestHighs } from "../../../helpers/highs";

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
    mode: "abyss",
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

  it("reports a team without a rotation", async () => {
    const silent: LineupSolverTeam = {
      ...teamA,
      setupConfig: {
        combatOptions: {},
        damage: {
          formulaMode: "combo",
          combo: { id: "empty", label: { en: "", zh: "" }, lines: [] },
        },
      },
    };
    const result = finalResult(
      await run(
        request({ teams: [silent], calibrations: [calibrate(silent, "first")] })
      )
    );
    expect(result.issues).toEqual([
      {
        templateId: "template-a",
        encounterId: "first",
        reason: "no-objective",
      },
    ]);
  });

  it("leaves margins to the recorded clear and the bar", async () => {
    const input = request({
      teams: [teamA],
      calibrations: [calibrate(teamA, "first")],
    });
    input.encounters = input.encounters.map((entry) => ({
      ...entry,
      timeBarSeconds: null,
    }));
    const result = finalResult(await run(input));
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(
      calibrateCandidates(
        result.candidates,
        input.calibrations,
        input.encounters
      )
    ).toEqual([]);
    const withBar = request().encounters;
    const [best] = calibrateCandidates(
      result.candidates,
      input.calibrations,
      withBar
    );
    expect(best.margin).toBeCloseTo((best.ratio * 110) / 90, 10);
  });

  it("sends the trace after every run, with the run in progress", async () => {
    const messages = await run(
      request({ teams: [teamA], calibrations: [calibrate(teamA, "first")] })
    );
    const { trace } = finalResult(messages);
    expect(trace.runs.length).toBeGreaterThan(0);
    expect(trace.inFlight).toBeNull();
    const partials = messages.flatMap((message) =>
      message.type === "partial" ? [message.result.trace] : []
    );
    for (const [index, entry] of trace.runs.entries()) {
      // Announced before it starts, listed once it ends.
      const announced = partials.find(
        (partial) =>
          partial.runs.length === index &&
          partial.inFlight?.startedAt === entry.startedAt
      );
      expect(announced?.inFlight?.assignment).toEqual(entry.assignment);
      expect(
        partials.some(
          (partial) =>
            partial.runs.length === index + 1 && partial.inFlight === null
        )
      ).toBe(true);
      expect(entry.phases[0]?.phase).toBe("init");
      expect(
        entry.phases.reduce((sum, span) => sum + span.ms, 0)
      ).toBeLessThanOrEqual(entry.elapsedMs);
    }
    const positions = messages.flatMap((message) =>
      message.type === "progress" && message.run ? [message] : []
    );
    expect(positions.map((message) => message.run?.phase)).toEqual(
      expect.arrayContaining(["phase1", "phase2"])
    );
    for (const message of positions)
      expect(
        trace.runs.some((entry) => entry.startedAt === message.run?.startedAt)
      ).toBe(true);
  }, 60_000);

  it("keeps members whose pieces matter to the kept pieces", async () => {
    // No piece is kept, so only the recorded build's pieces remain usable.
    const input = request({
      teams: [teamA],
      calibrations: [calibrate(teamA, "first")],
      keeperArtifactIds: [],
    });
    const result = finalResult(await run(input));
    const recorded = new Set(
      Object.values(input.calibrations[0].reference.artifactsByChar).flatMap(
        (pieces) => pieces.map((artifact) => artifact.id)
      )
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates)
      for (const id of candidateArtifactIds(candidate))
        expect(recorded.has(id)).toBe(true);
  }, 120_000);

  it("runs each composition even when its sets mirror another's", async () => {
    // Diluc takes Hu Tao's slot, so the compositions screen the same sets
    // slot for slot. The budget covers every composition's top three.
    const flex: LineupSolverTeam = {
      ...teamA,
      template: { ...teamA.template, flexBySlot: [["diluc"], [], [], []] },
    };
    const result = finalResult(
      await run(
        request({
          teams: [flex],
          calibrations: [calibrate(flex, "first")],
          timeBudgetSec: 5,
        })
      )
    );
    const runKey = (charIds: string[], assignment: SetAssignment) =>
      `${charIds.join(",")}:${assignmentKey(assignment, charIds)}`;
    const ran = new Set(
      result.trace.runs.map((entry) => runKey(entry.charIds, entry.assignment))
    );
    const screens = result.trace.tasks[0].screens;
    expect(screens).toHaveLength(2);
    for (const screen of screens)
      for (const outcome of screen.outcomes.slice(0, 3))
        expect(ran).toContain(runKey(screen.charIds, outcome.assignment));
  }, 120_000);

  it("finds a conflict-free pairing when both halves want the same gear", async () => {
    const messages = await run(request());
    expect(messages.some((message) => message.type === "partial")).toBe(true);
    const result = finalResult(messages);
    expect(result.issues).toEqual([]);
    expect(result.weaponCopies.favonius_sword).toBe(1);
    const input = request();
    const calibrated = calibrateCandidates(
      result.candidates,
      input.calibrations,
      input.encounters
    );
    expect(calibrated).toHaveLength(result.candidates.length);
    for (const candidate of calibrated) {
      // margin = r · (T_req − D) / (T_meas − D) with r against the clear.
      expect(candidate.margin).toBeCloseTo((candidate.ratio * 110) / 90, 10);
      expect(candidate.activeSeconds).toBeCloseTo(90 / candidate.ratio, 10);
      // Members whose stats don't move damage take any pieces of their set.
      for (const member of candidate.members)
        expect(Object.values(member.artifacts).every(Boolean)).toBe(true);
      const exact = candidate.members.filter((member) => !member.anyPieces);
      const ids = candidateArtifactIds(candidate);
      expect(ids).toHaveLength(5 * exact.length);
      expect(new Set(ids).size).toBe(ids.length);
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

    // The trace explains every candidate: its task, the run it came from
    // and its members' final stats.
    const { trace } = result;
    expect(
      trace.tasks.map((task) => `${task.templateId}:${task.encounterId}`)
    ).toEqual(["template-a:first", "template-b:second"]);
    for (const task of trace.tasks) {
      expect(task.referenceDamage).toBeGreaterThan(0);
      expect(task.compositions.length).toBeGreaterThan(0);
      expect(task.screens[0].outcomes.length).toBeGreaterThan(0);
    }
    const runKinds = new Set(trace.runs.map((entry) => entry.kind));
    expect(runKinds).toEqual(
      new Set(["recorded-sets", "search", "pieces-excluded"])
    );
    // Each half also lists its recorded build, at r = 1.
    for (const encounterId of ["first", "second"]) {
      const recorded = result.candidates.filter(
        (entry) =>
          entry.encounterId === encounterId && entry.origin === "recorded"
      );
      expect(recorded).toHaveLength(1);
      expect(recorded[0].ratio).toBe(1);
    }
    const ids = new Set(result.candidates.map((entry) => entry.id));
    for (const entry of trace.runs) {
      expect(entry.elapsedMs).toBeGreaterThan(0);
      if (entry.candidateId) expect(ids.has(entry.candidateId)).toBe(true);
    }
    for (const candidate of result.candidates) {
      const stats = trace.memberStats[candidate.id];
      expect(Object.keys(stats).sort()).toEqual(
        candidate.members.map((member) => member.charId).sort()
      );
      for (const sheet of Object.values(stats)) {
        expect(sheet.cr).toBeGreaterThan(0);
        expect(sheet.cd).toBeGreaterThan(0);
        expect(sheet.atk).toBeGreaterThan(0);
      }
    }

    const [plan] = planAbyssChambers(
      input.encounters,
      calibrated,
      result.weaponCopies,
      "per-half",
      3,
      4
    );
    expect(plan.pairings.length).toBeGreaterThan(0);
    const byId = new Map(calibrated.map((c) => [c.id, c]));
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

describe("runLineupSolver for a Stygian run", () => {
  // A third Pyro carry joins: all three want the great Crimson Witch set.
  const MID_CW = pieces("mid", CW, ["atk%", "pyro%", "cd"], {
    cr: 6,
    cd: 12,
  });
  const TENACITY = pieces(
    "tenacity",
    "tenacity_of_the_millelith",
    ["hp%", "hp%", "hp%"],
    { "hp%": 10 }
  );
  const stygianAccount: AccountData = {
    ...account,
    characters: [
      ...account.characters,
      character("yoimiya", "thundering_pulse", MID_CW),
      character("yelan", "aqua_simulacra", TENACITY),
    ],
  };
  const teamC = solverTeam("c", [
    ["yoimiya", "thundering_pulse"],
    ["yelan", "aqua_simulacra"],
  ]);
  const boss = (id: string, bossId: number): StygianEncounter => ({
    id,
    mode: "stygian",
    bossId,
    enemyLevel: 100,
    res: {},
    targets: "",
    downtimeSeconds: 10,
    timeBarSeconds: 120,
  });

  it("fields one team per boss with no gear twice", async () => {
    const encounters = [
      boss("boss-1", 1),
      boss("boss-2", 2),
      boss("boss-3", 3),
    ];
    const teams = [teamA, teamB, teamC];
    const calibrations = teams.map((team, index) => ({
      ...calibrate(team, encounters[index].id),
      reference: captureTeamReferenceBuild(
        team.teamComp,
        team.setupConfig,
        stygianAccount,
        1
      )!,
    }));
    const input: LineupSolverRequest = {
      mode: "stygian",
      accountData: stygianAccount,
      encounters: [...encounters, encounter("first", 1)],
      teams,
      calibrations,
      comboOverrides: {},
      timeBudgetSec: 1,
    };
    const result = finalResult(await run(input));
    expect(result.issues).toEqual([]);
    expect(new Set(result.candidates.map((c) => c.encounterId))).toEqual(
      new Set(["boss-1", "boss-2", "boss-3"])
    );
    expect(result.candidates.some((c) => c.origin === "pieces-excluded")).toBe(
      true
    );

    const highs = await loadTestHighs();
    const calibrated = calibrateCandidates(
      result.candidates,
      calibrations,
      encounters
    );
    const plan = planStygianRun(
      {
        encounterIds: encounters.map((entry) => entry.id),
        candidates: calibrated,
        weaponCopies: result.weaponCopies,
        tiePercent: 3,
      },
      (model) => solveMilp(highs, model)
    );
    expect(plan.missingEncounterIds).toEqual([]);
    const chosen = Object.values(plan.plans[0].candidateIds).map(
      (id) => calibrated.find((candidate) => candidate.id === id)!
    );
    expect(chosen).toHaveLength(3);
    expect(canFieldTogether(chosen, result.weaponCopies)).toBe(true);
  }, 120_000);
});
