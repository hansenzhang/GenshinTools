import "@/providers/reference/statLoaders";
import "@/domain/combat/damage/index";
import { describe, expect, it } from "vitest";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type {
  CalcContext,
  ComboFormula,
  TeamSlotConfig,
} from "@/domain/combat/damage/types";
import {
  adviseLevelling,
  compareLevellingPieces,
  expectedRollsByStat,
  type GainDistribution,
  levelledPiece,
  type PendingRolls,
  pendingRolls,
  rollGainDistribution,
  summarizeOutcome,
  tierValues,
  upgradesLeft,
} from "@/domain/combat/lineup/levelling";
import {
  formedSet,
  type SetScreenInput,
} from "@/domain/combat/lineup/setConfigScreen";
import type { Element, MainStat, Slot, SubStat } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import type {
  LevellingPiece,
  LineupMember,
} from "@/domain/team/lineupSolverTypes";

const [chars] = await Promise.all([
  characterStatsResource.preload(),
  weaponStatsResource.preload(),
]);

function piece(overrides: Partial<ArtifactData> = {}): ArtifactData {
  return {
    id: "piece",
    setKey: "crimson_witch_of_flames",
    slotKey: "sands",
    level: 0,
    rarity: 5,
    mainStatKey: "atk%",
    lock: false,
    substats: { cr: 3.5, cd: 7, em: 21 },
    ...overrides,
  };
}

// ─── Roll odds ───

const WEIGHTS: Record<SubStat, number> = {
  hp: 6,
  atk: 6,
  def: 6,
  "hp%": 4,
  "atk%": 4,
  "def%": 4,
  er: 4,
  em: 4,
  cr: 3,
  cd: 3,
};

/** Every sequence of lines and roll values, one at a time. */
function enumerate(
  pending: PendingRolls,
  gains: (stat: SubStat) => readonly number[],
  bin: number
): GainDistribution {
  const out: GainDistribution = new Map();
  const walk = (lines: SubStat[], rolls: number, p: number, k: number) => {
    if (rolls === 0) {
      out.set(k, (out.get(k) ?? 0) + p);
      return;
    }
    const choices =
      lines.length >= 4
        ? lines.map((stat) => ({ stat, p: 1 / lines.length, next: lines }))
        : (() => {
            const pool = (Object.keys(WEIGHTS) as SubStat[]).filter(
              (stat) => stat !== pending.mainStat && !lines.includes(stat)
            );
            const total = pool.reduce((sum, stat) => sum + WEIGHTS[stat], 0);
            return pool.map((stat) => ({
              stat,
              p: WEIGHTS[stat] / total,
              next: [...lines, stat],
            }));
          })();
    for (const choice of choices)
      for (const gain of gains(choice.stat))
        walk(
          choice.next,
          rolls - 1,
          (p * choice.p) / 4,
          k + Math.round(gain / bin)
        );
  };
  walk(pending.lines, pending.rolls, 1, 0);
  return out;
}

function expectSameDistribution(a: GainDistribution, b: GainDistribution) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of keys)
    expect(a.get(key) ?? 0).toBeCloseTo(b.get(key) ?? 0, 10);
  const total = [...a.values()].reduce((sum, p) => sum + p, 0);
  expect(total).toBeCloseTo(1, 10);
}

/** A gain per stat and roll value, distinct enough to tell sequences apart. */
const scaledGains =
  (rarity: 4 | 5) =>
  (stat: SubStat): number[] => {
    const scale = 1 + Object.keys(WEIGHTS).indexOf(stat) / 7;
    return tierValues(stat, rarity).map((value) => value * scale);
  };

describe("roll odds", () => {
  it("counts one upgrade per +4 levels", () => {
    expect(upgradesLeft(piece({ level: 0 }))).toBe(5);
    expect(upgradesLeft(piece({ level: 3 }))).toBe(5);
    expect(upgradesLeft(piece({ level: 4 }))).toBe(4);
    expect(upgradesLeft(piece({ level: 16 }))).toBe(1);
    expect(upgradesLeft(piece({ level: 20 }))).toBe(0);
    expect(upgradesLeft(piece({ rarity: 4, level: 0 }))).toBe(4);
    expect(upgradesLeft(piece({ rarity: 4, level: 16 }))).toBe(0);
    expect(upgradesLeft(piece({ rarity: 3, level: 0 }))).toBe(0);
  });

  it("levels the main stat and activates a line the game has shown", () => {
    const shown = piece({ unactivatedSubstats: { "hp%": 5.8 } });
    expect(levelledPiece(shown)).toMatchObject({
      level: 20,
      substats: { cr: 3.5, cd: 7, em: 21, "hp%": 5.8 },
      unactivatedSubstats: undefined,
    });
    expect(pendingRolls(shown)).toEqual({
      rarity: 5,
      mainStat: "atk%",
      lines: ["cr", "cd", "em", "hp%"],
      rolls: 4,
    });
    expect(pendingRolls(piece())).toMatchObject({
      lines: ["cr", "cd", "em"],
      rolls: 5,
    });
    expect(levelledPiece(piece({ rarity: 4 })).level).toBe(16);
  });

  it.each([
    ["a 5★ piece missing a line", pendingRolls(piece()), 5],
    [
      "a 5★ piece with four lines",
      pendingRolls(piece({ substats: { cr: 3.5, cd: 7, em: 21, hp: 299 } })),
      5,
    ],
    [
      "a 4★ piece with two lines",
      pendingRolls(
        piece({ rarity: 4, mainStatKey: "hp", substats: { cr: 2.2, er: 3 } })
      ),
      4,
    ],
  ] as const)("matches every roll sequence for %s", (_, pending, rarity) => {
    const gains = scaledGains(rarity);
    expectSameDistribution(
      rollGainDistribution(pending, gains),
      enumerate(pending, gains, 1e-4)
    );
  });

  it("reproduces the published slot-upgrade table over four lines", () => {
    // One wanted line of four, five upgrades: Binomial(5, 1/4).
    const pending = pendingRolls(
      piece({ substats: { cr: 3.5, cd: 7, em: 21, hp: 299 } })
    );
    const hits = rollGainDistribution(
      pending,
      (stat) => (stat === "cr" ? [1, 1, 1, 1] : [0, 0, 0, 0]),
      1
    );
    expect([0, 1, 2, 3, 4, 5].map((k) => hits.get(k) ?? 0)).toEqual(
      [243, 405, 270, 90, 15, 1].map((count) => expect.closeTo(count / 1024))
    );
  });

  it("expects as many rolls per stat as the distribution's mean", () => {
    const pending = pendingRolls(piece());
    const expected = expectedRollsByStat(pending);
    const total = Object.values(expected).reduce((sum, n) => sum + (n ?? 0), 0);
    expect(total).toBeCloseTo(5, 10);
    const wanted = new Set<SubStat>(["cr", "cd", "atk"]);
    const hits = rollGainDistribution(
      pending,
      (stat) => (wanted.has(stat) ? [1, 1, 1, 1] : [0, 0, 0, 0]),
      1
    );
    const mean = [...hits].reduce((sum, [k, p]) => sum + k * p, 0);
    expect(mean).toBeCloseTo(
      (expected.cr ?? 0) + (expected.cd ?? 0) + (expected.atk ?? 0),
      10
    );
  });
});

describe("summarizeOutcome", () => {
  it("beats the bar and counts losses as no gain", () => {
    const rolls: GainDistribution = new Map([
      [-200, 0.25],
      [0, 0.25],
      [400, 0.5],
    ]);
    // Gains −1%, +1% and +5% against a 3% bar.
    const outcome = summarizeOutcome(0.01, rolls, 0.03, 1e-4);
    expect(outcome.beatChance).toBeCloseTo(0.5, 10);
    expect(outcome.expectedGain).toBeCloseTo(0.25 * 0.01 + 0.5 * 0.05, 10);
  });
});

describe("compareLevellingPieces", () => {
  const option = (beatChance: number, expectedGain: number) =>
    ({ beatChance, expectedGain }) as LevellingPiece;

  it("ranks by chance, with chances within a point tied on expected gain", () => {
    const likely = option(0.95, 0.01);
    const steady = option(0.904, 0.02);
    const larger = option(0.898, 0.05);
    expect([steady, larger, likely].sort(compareLevellingPieces)).toEqual([
      likely,
      larger,
      steady,
    ]);
  });
});

// ─── Advice ───

const CTX: CalcContext = {
  enemyLevel: 100,
  enemyRes: 0.1,
  rollMultiplier: 0.85,
  substatBudget: "8_6",
};
const CW = "crimson_witch_of_flames";
const SLOTS: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];

function art(
  id: string,
  setKey: string,
  slotKey: Slot,
  mainStatKey: MainStat,
  level: number,
  substats: Partial<Record<SubStat, number>>
): ArtifactData {
  return {
    id,
    setKey,
    slotKey,
    level,
    rarity: 5,
    mainStatKey,
    lock: false,
    substats,
  };
}

const crit = { cr: 7, cd: 14, "hp%": 5, em: 20 };
const junk = { def: 20, "def%": 6, hp: 250, atk: 15 };
// Hu Tao in four Crimson Witch pieces and an off-set circlet; her sands is
// unlevelled.
const HU_TAO_PIECES: Record<Slot, ArtifactData> = {
  flower: art("cw-flower", CW, "flower", "hp", 20, crit),
  plume: art("cw-plume", CW, "plume", "atk", 20, crit),
  sands: art("cw-sands", CW, "sands", "hp%", 0, { cr: 3.5, cd: 7, em: 21 }),
  goblet: art("cw-goblet", CW, "goblet", "pyro%", 20, junk),
  circlet: art("glad-circlet", "gladiators_finale", "circlet", "cr", 20, crit),
};
const XINGQIU_PIECES = Object.fromEntries(
  SLOTS.map((slot, index) => [
    slot,
    art(
      `emblem-${slot}`,
      "emblem_of_severed_fate",
      slot,
      (["hp", "atk", "er", "hydro%", "cr"] as MainStat[])[index],
      20,
      crit
    ),
  ])
) as Record<Slot, ArtifactData>;
// A great Crimson Witch goblet, a better off-set one, and a poor sands.
const SPARE = [
  art("cw-goblet-great", CW, "goblet", "pyro%", 0, {
    cr: 3.9,
    cd: 7.8,
    "hp%": 5.8,
  }),
  art("noblesse-goblet", "noblesse_oblige", "goblet", "pyro%", 0, {
    cr: 3.9,
    cd: 7.8,
    "hp%": 5.8,
    em: 23,
  }),
  art("cw-sands-def", CW, "sands", "def%", 0, junk),
];

function member(
  charId: string,
  pieces: Record<Slot, ArtifactData>
): LineupMember {
  return {
    charId,
    weaponId: charId === "hu_tao" ? "staff_of_homa" : "sacrificial_sword",
    refinement: 1,
    artifactSet: formedSet(pieces),
    artifacts: pieces,
    anyPieces: false,
  };
}

const MEMBERS = [
  member("hu_tao", HU_TAO_PIECES),
  member("xingqiu", XINGQIU_PIECES),
];

function screenFor(xingqiuSkill = 10): SetScreenInput {
  const configs: TeamSlotConfig[] = MEMBERS.map((entry) => ({
    charId: entry.charId,
    charLevel: 90,
    constellation: 0,
    weaponId: entry.weaponId,
    refinement: 1,
    artifactSet: entry.artifactSet,
    talentLevels: {
      auto: 10,
      skill: entry.charId === "xingqiu" ? xingqiuSkill : 10,
      burst: 10,
    },
  }));
  const team = new TeamBuild(configs, {}, undefined, [], undefined, CTX);
  const lines = configs.flatMap((config) =>
    Object.entries(team.catalog.getCombo(config.charId))
      .filter(([, count]) => count > 0)
      .map(([formulaId, count]) => ({
        charId: config.charId,
        formulaId,
        count,
      }))
  );
  const combo: ComboFormula = {
    id: "test",
    label: { en: "Test", zh: "Test" },
    lines,
  };
  return {
    configs,
    combo,
    combatOptions: {},
    optimizeContext: CTX,
    displayContext: CTX,
    carryCharId: "hu_tao",
    requirements: Object.fromEntries(
      configs.map((config) => [config.charId, { minEr: 1, minCr: 0 }])
    ),
    elements: Object.fromEntries(
      configs.map((config) => [
        config.charId,
        chars[config.charId].element as Element,
      ])
    ),
    lockedCharIds: new Set(),
    pinned: {},
  };
}

function advise(reservedIds: string[] = [], xingqiuSkill = 10) {
  const advice = adviseLevelling({
    screen: screenFor(xingqiuSkill),
    members: MEMBERS,
    artifacts: [
      ...Object.values(HU_TAO_PIECES),
      ...Object.values(XINGQIU_PIECES),
      ...SPARE,
    ],
    reservedIds: new Set(reservedIds),
    bar: 0.03,
  });
  if (!advice) throw new Error("The team could not be scored.");
  return advice;
}

describe("adviseLevelling", () => {
  it("levels an unlevelled worn piece whose main stat the carry wants", () => {
    const { pieces } = advise();
    const sands = pieces.find(
      (entry) => entry.charId === "hu_tao" && entry.slot === "sands"
    );
    expect(sands?.artifact.id).toBe("cw-sands");
    expect(sands?.replaces?.id).toBe("cw-sands");
    expect(sands?.toLevel).toBe(20);
    expect(sands?.beatChance).toBeCloseTo(1, 6);
    expect(sands?.expectedGain).toBeGreaterThan(0.1);
  });

  it("keeps the member's sets and leaves other teams' pieces alone", () => {
    const goblet = (reserved: string[]) =>
      advise(reserved).pieces.find(
        (entry) => entry.charId === "hu_tao" && entry.slot === "goblet"
      );
    // The off-set goblet would break four-piece Crimson Witch.
    expect(goblet([])?.artifact.id).toBe("cw-goblet-great");
    expect(goblet([])?.replaces?.id).toBe("cw-goblet");
    expect(goblet(["cw-goblet-great"])).toBeUndefined();
    const ids = advise().pieces.map((entry) => entry.artifact.id);
    expect(ids).not.toContain("noblesse-goblet");
    // Xingqiu's pieces are all levelled and nobody else's are free.
    expect(ids.every((id) => !id.startsWith("emblem-"))).toBe(true);
  });

  it("prices one more character level and talent level", () => {
    const steps = advise([], 9).steps;
    expect(steps.map((step) => `${step.charId}:${step.kind}`)).toEqual(
      expect.arrayContaining(["hu_tao:level", "xingqiu:skill"])
    );
    expect(steps.find((step) => step.kind === "skill")).toMatchObject({
      from: 9,
      to: 10,
    });
    // Talents at 10 have no step.
    expect(
      steps.some((step) => step.charId === "hu_tao" && step.kind !== "level")
    ).toBe(false);
    for (const [a, b] of steps.slice(1).map((step, i) => [steps[i], step]))
      expect(a.gain).toBeGreaterThanOrEqual(b.gain);
  });
});
