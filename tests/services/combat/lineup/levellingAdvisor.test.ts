import "@/providers/reference/statLoaders";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { StatSheet } from "@/domain/combat/damage/core/statSheet";
import { candidateArtifactIds } from "@/domain/combat/lineup/candidates";
import {
  evaluateAssignment,
  formedSet,
} from "@/domain/combat/lineup/setConfigScreen";
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
  LineupCandidate,
  LineupSolverRequest,
  LineupSolverResult,
  LineupSolverTeam,
} from "@/domain/team/lineupSolverTypes";
import type { Calibration, Encounter } from "@/domain/team/lineupTypes";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";
import type { TeamComp, TeamSetupConfig } from "@/domain/team/types";
import {
  adviseCandidateLevelling,
  candidateScreen,
} from "@/services/combat/lineup/levellingAdvisor";
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

const SLOTS: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];
const CW = "crimson_witch_of_flames";

function pieces(
  id: string,
  setKey: string,
  level: number,
  mains: [MainStat, MainStat, MainStat],
  substats: Partial<Record<SubStat, number>>
): ArtifactData[] {
  const slotMains: MainStat[] = ["hp", "atk", ...mains];
  return SLOTS.map((slotKey, index) => ({
    id: `${id}-${slotKey}`,
    setKey,
    slotKey,
    level,
    rarity: 5,
    mainStatKey: slotMains[index],
    lock: false,
    substats,
  }));
}

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
    talent: { auto: 9, skill: 9, burst: 9 },
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

// Hu Tao wears levelled Crimson Witch; an unlevelled set with crit lines
// waits in the inventory.
const account: AccountData = {
  characters: [
    character(
      "hu_tao",
      "staff_of_homa",
      pieces("worn", CW, 20, ["hp%", "pyro%", "cr"], { def: 40, "def%": 10 })
    ),
    character(
      "xingqiu",
      "sacrificial_sword",
      pieces("emblem", "emblem_of_severed_fate", 20, ["er", "hydro%", "cr"], {
        er: 10,
        cr: 5,
      })
    ),
  ],
  extraArtifacts: pieces("fresh", CW, 0, ["hp%", "pyro%", "cd"], {
    cr: 3.9,
    cd: 7.8,
    "hp%": 5.8,
  }),
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

const team = solverTeam("a", [
  ["hu_tao", "staff_of_homa"],
  ["xingqiu", "sacrificial_sword"],
]);
const encounter: Encounter = {
  ...createAbyssEncounter("first", 1, 1),
  downtimeSeconds: 10,
  timeBarSeconds: 120,
};
const calibration: Calibration = {
  id: "calibration-a",
  templateId: team.template.id,
  encounterId: encounter.id,
  reference: captureTeamReferenceBuild(
    team.teamComp,
    team.setupConfig,
    account,
    1
  )!,
  measuredSeconds: 100,
  downtimeSeconds: null,
};
const request: LineupSolverRequest = {
  mode: "abyss",
  accountData: account,
  encounters: [encounter],
  teams: [team],
  calibrations: [calibration],
  comboOverrides: {},
  timeBudgetSec: 1,
};

let result: LineupSolverResult;
beforeAll(async () => {
  [chars, weapons] = await Promise.all([
    characterStatsResource.preload(),
    weaponStatsResource.preload(),
  ]);
  let finished: LineupSolverResult | null = null;
  await runLineupSolver(request, chars, weapons, (message) => {
    if (message.type === "result") finished = message.result;
  });
  if (!finished) throw new Error("The solver gave no result.");
  result = finished;
}, 60_000);

const sheetsOf = (candidate: LineupCandidate) =>
  Object.fromEntries(
    candidate.members.map((member) => [
      member.charId,
      StatSheet.fromArtifacts(Object.values(member.artifacts)),
    ])
  );

describe("candidateScreen", () => {
  it("scores every candidate as the solver did", () => {
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      const screen = candidateScreen(
        { solver: request, candidate, others: [] },
        chars
      );
      expect(screen).not.toBeNull();
      const damage = evaluateAssignment(
        screen!,
        Object.fromEntries(
          candidate.members.map((member) => [member.charId, member.artifactSet])
        ),
        sheetsOf(candidate)
      );
      expect(damage! / candidate.damage).toBeCloseTo(1, 9);
    }
  });

  it("needs the candidate's team and clear in the request", () => {
    const [candidate] = result.candidates;
    expect(
      candidateScreen(
        { solver: { ...request, calibrations: [] }, candidate, others: [] },
        chars
      )
    ).toBeNull();
  });
});

describe("adviseCandidateLevelling", () => {
  const recorded = () => {
    const candidate = result.candidates.find(
      (entry) => entry.origin === "recorded"
    );
    if (!candidate) throw new Error("No recorded candidate.");
    return candidate;
  };

  it("levels the unlevelled crit pieces for the carry, keeping its set", () => {
    const candidate = recorded();
    const advice = adviseCandidateLevelling(
      { solver: request, candidate, others: [] },
      chars
    );
    expect(advice?.candidateId).toBe(candidate.id);
    const huTao = advice!.pieces.filter((entry) => entry.charId === "hu_tao");
    expect(huTao.length).toBeGreaterThan(0);
    for (const entry of huTao) {
      expect(entry.artifact.setKey).toBe(CW);
      expect(entry.artifact.level).toBe(0);
      expect(entry.beatChance).toBeGreaterThan(0);
      const worn = candidate.members.find(
        (member) => member.charId === "hu_tao"
      )!;
      expect(
        formedSet({ ...worn.artifacts, [entry.slot]: entry.artifact })
      ).toEqual(worn.artifactSet);
    }
    // Talents at 9 are one level from the cap.
    expect(advice!.steps.some((step) => step.kind !== "level")).toBe(true);
  });

  it("leaves pieces another team of the lineup needs", () => {
    const candidate = recorded();
    const other: LineupCandidate = {
      ...candidate,
      id: "other",
      members: [
        {
          ...candidate.members[0],
          charId: "diluc",
          artifacts: byslot(
            account.extraArtifacts
          ) as LineupCandidate["members"][number]["artifacts"],
        },
      ],
    };
    const reserved = new Set(candidateArtifactIds(other));
    const advice = adviseCandidateLevelling(
      { solver: request, candidate, others: [other] },
      chars
    );
    expect(advice).not.toBeNull();
    expect(
      advice!.pieces.some((entry) => reserved.has(entry.artifact.id))
    ).toBe(false);
  });
});
