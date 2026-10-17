import "@/providers/reference/statLoaders";
import "@/domain/combat/damage/index";
import { describe, expect, it } from "vitest";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import {
  buildChoiceRows,
  enumerateJointAssignments,
  findOrphanedSetOverrideKeys,
  type MemberChoices,
  pickBestOutcome,
  selectFinalists,
  selectWitnesses,
  trimChoicesToCap,
} from "@/domain/combat/lineup/setAssignments";
import { assignmentKey, setChoiceKey } from "@/domain/combat/lineup/setChoices";
import type { ArtifactSetConfig } from "@/domain/models";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import type {
  SetAssignment,
  SetAssignmentOutcome,
} from "@/domain/team/setConfigExplorerTypes";

await Promise.all([
  characterStatsResource.preload(),
  weaponStatsResource.preload(),
]);

const set = (setId: string): ArtifactSetConfig => ({ type: "4pc", setId });
const SILKEN = set("silken_moons_serenade");
const AUBADE = set("aubade_of_morningstar_and_moon");
const VV = set("viridescent_venerer");
const ATK_EM: ArtifactSetConfig = {
  type: "2pc+2pc",
  halfSetIds: ["atk%-18", "em-80"],
};
const CHARS = ["columbina", "ineffa", "sucrose"];

function member(
  charId: string,
  choices: [ArtifactSetConfig | null, number, boolean?][]
): MemberChoices {
  return {
    charId,
    choices: choices.map(([choice, score, isProtected = false]) => ({
      choice,
      key: setChoiceKey(choice),
      score,
      protected: isProtected,
    })),
  };
}

function outcome(
  assignment: SetAssignment,
  screenDamage: number,
  extra: Partial<SetAssignmentOutcome> = {}
): SetAssignmentOutcome {
  return {
    assignment,
    key: assignmentKey(assignment, CHARS),
    screenDamage,
    ...extra,
  };
}

const screen = (o: SetAssignmentOutcome) => o.screenDamage;

describe("trimChoicesToCap / enumerateJointAssignments", () => {
  it("keeps protected choices and trims the widest member first", () => {
    const members = [
      member("columbina", [
        [SILKEN, 10, true],
        [AUBADE, 9],
        [ATK_EM, 8],
        [VV, 1],
      ]),
      member("ineffa", [
        [AUBADE, 10, true],
        [SILKEN, 2, true],
      ]),
    ];
    const trimmed = trimChoicesToCap(members, 4);
    expect(trimmed[0].choices.map((c) => c.key)).toEqual([
      "silken_moons_serenade",
      "aubade_of_morningstar_and_moon",
    ]);
    expect(trimmed[1].choices).toHaveLength(2);
    const joint = enumerateJointAssignments(trimmed);
    expect(joint).toHaveLength(4);
    expect(joint).toContainEqual({ columbina: AUBADE, ineffa: SILKEN });
  });

  it("stops when only protected choices remain", () => {
    const members = [
      member("columbina", [
        [SILKEN, 1, true],
        [AUBADE, 1, true],
      ]),
    ];
    expect(trimChoicesToCap(members, 1)[0].choices).toHaveLength(2);
  });
});

describe("pickBestOutcome", () => {
  it("prefers fewer changes among tied outcomes", () => {
    const current = { columbina: SILKEN, ineffa: AUBADE, sucrose: VV };
    const outcomes = [
      outcome(current, 1000),
      outcome({ columbina: AUBADE, ineffa: SILKEN, sucrose: VV }, 1000.5),
      outcome({ columbina: AUBADE, ineffa: AUBADE, sucrose: SILKEN }, 900),
    ];
    expect(
      pickBestOutcome(outcomes, [0, 1, 2], screen, current, CHARS, 0.1)
    ).toBe(0);
    expect(
      pickBestOutcome(outcomes, [0, 1, 2], screen, current, CHARS, 0)
    ).toBe(1);
  });
});

describe("selectWitnesses / selectFinalists", () => {
  const current = { columbina: SILKEN, ineffa: AUBADE, sucrose: VV };
  const outcomes = [
    outcome(current, 100),
    outcome({ columbina: AUBADE, ineffa: SILKEN, sucrose: VV }, 104),
    outcome({ columbina: AUBADE, ineffa: AUBADE, sucrose: SILKEN }, 103),
    outcome({ columbina: SILKEN, ineffa: ATK_EM, sucrose: VV }, 99),
    outcome({ columbina: ATK_EM, ineffa: SILKEN, sucrose: VV }, 98),
    outcome({ columbina: AUBADE, ineffa: SILKEN, sucrose: ATK_EM }, 50),
  ];

  it("covers top screened assignments, each member's top choices and pins", () => {
    const witnesses = selectWitnesses({
      outcomes,
      charIds: CHARS,
      score: screen,
      topCount: 1,
      perMember: 1,
      pinned: { sucrose: [ATK_EM] },
      currentIndex: 0,
    });
    expect(witnesses).toContain(0);
    expect(witnesses).toContain(1);
    expect(witnesses).toContain(5);
    expect(witnesses).not.toContain(4);
  });

  it("moves each team-buff set of the best to another member before runner-ups", () => {
    const finalists = selectFinalists({
      outcomes,
      charIds: CHARS,
      score: screen,
      bestIndex: 1,
      currentIndex: 0,
      teamBuffSetIds: new Set(["silken_moons_serenade", "viridescent_venerer"]),
      pinned: {},
      max: 2,
    });
    // Best, then Silken moved off Ineffa (to Sucrose); current is excluded.
    expect(finalists).toEqual([1, 2]);
  });

  it("always keeps pinned choices, even past the limit", () => {
    const finalists = selectFinalists({
      outcomes,
      charIds: CHARS,
      score: screen,
      bestIndex: 1,
      currentIndex: 0,
      teamBuffSetIds: new Set(),
      pinned: { sucrose: [ATK_EM], columbina: [ATK_EM] },
      max: 1,
    });
    expect(finalists).toEqual([1, 5, 4]);
  });
});

describe("buildChoiceRows", () => {
  it("ranks reachable real results, then unreachable ones, then estimates", () => {
    const account = (damage: number | null) => ({
      damage,
      realized: {},
      artifactsByChar: {},
      failReasons: {},
      unmetCharIds: [],
    });
    const outcomes = [
      outcome({ columbina: SILKEN, ineffa: AUBADE, sucrose: VV }, 100, {
        generatedDamage: 100,
        account: account(90),
      }),
      outcome({ columbina: AUBADE, ineffa: SILKEN, sucrose: VV }, 104, {
        generatedDamage: 104,
        account: account(null),
      }),
      outcome({ columbina: ATK_EM, ineffa: SILKEN, sucrose: VV }, 99, {
        generatedDamage: 99,
      }),
    ];
    const rows = buildChoiceRows(outcomes, CHARS, { columbina: [ATK_EM] });
    expect(
      rows.columbina.map((row) => [row.key, row.basis, row.pinned])
    ).toEqual([
      ["silken_moons_serenade", "account", false],
      ["aubade_of_morningstar_and_moon", "account", false],
      ["atk%-18+em-80", "generated", true],
    ]);
    // Sucrose's only choice keeps the best reachable outcome.
    expect(rows.sucrose).toHaveLength(1);
    expect(rows.sucrose[0].outcomeIndex).toBe(0);
  });
});

describe("findOrphanedSetOverrideKeys", () => {
  it("finds activations of a set bonus whose wearer changes", () => {
    const team = new TeamBuild([
      {
        charId: "hu_tao",
        charLevel: 90,
        constellation: 0,
        weaponId: "staff_of_homa",
        refinement: 1,
        artifactSet: set("crimson_witch_of_flames"),
      },
      {
        charId: "bennett",
        charLevel: 90,
        constellation: 6,
        weaponId: "mistsplitter_reforged",
        refinement: 1,
        artifactSet: set("noblesse_oblige"),
      },
    ]);
    const noblesseKey = team.buffLedger.allBuffs.find(
      (entry) =>
        entry.providerCharId === "bennett" &&
        entry.buff.source.type === "artifactSet"
    )?.buffKey;
    expect(noblesseKey).toBeDefined();
    const overrides = { "hu_tao.e": { [noblesseKey!]: { 0: 0 } } };
    const from = {
      hu_tao: set("crimson_witch_of_flames"),
      bennett: set("noblesse_oblige"),
    };
    expect(
      findOrphanedSetOverrideKeys(overrides, from, {
        hu_tao: set("noblesse_oblige"),
        bennett: set("crimson_witch_of_flames"),
      })
    ).toEqual([noblesseKey]);
    expect(findOrphanedSetOverrideKeys(overrides, from, from)).toEqual([]);
  });
});
