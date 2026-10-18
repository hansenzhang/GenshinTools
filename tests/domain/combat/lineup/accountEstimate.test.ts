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
  estimateOnAccount,
  generateAssignmentSheets,
  type SetScreenInput,
} from "@/domain/combat/lineup/setConfigScreen";
import type { Element, MainStat, Slot, SubStat } from "@/domain/enums";
import type { ArtifactData, ArtifactSetConfig } from "@/domain/models";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import type { SetAssignment } from "@/domain/team/setConfigExplorerTypes";

const [chars] = await Promise.all([
  characterStatsResource.preload(),
  weaponStatsResource.preload(),
]);

const SLOTS: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];
const CTX: CalcContext = {
  enemyLevel: 100,
  enemyRes: 0.1,
  rollMultiplier: 0.85,
  substatBudget: "8_6",
};

const set = (setId: string): ArtifactSetConfig => ({ type: "4pc", setId });

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

function configs(members: [string, string, ArtifactSetConfig][]) {
  return members.map(
    ([charId, weaponId, artifactSet]): TeamSlotConfig => ({
      charId,
      charLevel: 90,
      constellation: 0,
      weaponId,
      refinement: 1,
      artifactSet,
      talentLevels: { auto: 10, skill: 10, burst: 10 },
    })
  );
}

function input(
  teamConfigs: TeamSlotConfig[],
  pool: ArtifactData[],
  minEr: Record<string, number> = {}
): SetScreenInput {
  const team = new TeamBuild(teamConfigs, {}, undefined, [], undefined, CTX);
  const lines = teamConfigs.flatMap((config) =>
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
    configs: teamConfigs,
    combo,
    combatOptions: {},
    optimizeContext: CTX,
    displayContext: CTX,
    carryCharId: lines[0].charId,
    requirements: Object.fromEntries(
      teamConfigs.map((config) => [
        config.charId,
        { minEr: minEr[config.charId] ?? 1, minCr: 0 },
      ])
    ),
    elements: Object.fromEntries(
      teamConfigs.map((config) => [
        config.charId,
        chars[config.charId].element as Element,
      ])
    ),
    lockedCharIds: new Set(),
    pinned: {},
    pools: Object.fromEntries(
      teamConfigs.map((config) => [config.charId, pool])
    ),
  };
}

describe("estimateOnAccount", () => {
  const team = configs([
    [
      "sandrone",
      "a_teaspoon_of_transcendence",
      set("disenchantment_in_deep_shadow"),
    ],
    ["alyosha", "favonius_lance", set("tenacity_of_the_millelith")],
  ]);
  const crit = { cr: 10, cd: 20, "atk%": 10 };
  // Great Disenchantment pieces, but only unlevelled Shimenawa.
  const pool = [
    ...pieces(
      "disenchantment",
      "disenchantment_in_deep_shadow",
      20,
      ["atk%", "cryo%", "cr"],
      crit
    ),
    ...pieces(
      "shimenawa",
      "shimenawas_reminiscence",
      0,
      ["def%", "def%", "def%"],
      { def: 20 }
    ),
    ...pieces(
      "tenacity",
      "tenacity_of_the_millelith",
      20,
      ["er", "hp%", "hp%"],
      { er: 6 }
    ),
  ];

  async function estimate(assignment: SetAssignment, minEr = {}) {
    const screen = input(team, pool, minEr);
    const sheets = await generateAssignmentSheets(screen, assignment);
    if (!sheets) throw new Error("No generated sheets.");
    return estimateOnAccount(screen, assignment, sheets);
  }

  it("rates a set by the account's own pieces of it", async () => {
    const disenchantment = await estimate({
      sandrone: set("disenchantment_in_deep_shadow"),
      alyosha: set("tenacity_of_the_millelith"),
    });
    const shimenawa = await estimate({
      sandrone: set("shimenawas_reminiscence"),
      alyosha: set("tenacity_of_the_millelith"),
    });
    expect(disenchantment).toBeGreaterThan(0);
    expect(shimenawa).toBeGreaterThan(0);
    expect(disenchantment!).toBeGreaterThan(shimenawa! * 1.5);
  });

  it("cannot estimate sets the account doesn't own or ER it can't reach", async () => {
    expect(
      await estimate({
        sandrone: set("noblesse_oblige"),
        alyosha: set("tenacity_of_the_millelith"),
      })
    ).toBeNull();
    expect(
      await estimate(
        {
          sandrone: set("disenchantment_in_deep_shadow"),
          alyosha: set("tenacity_of_the_millelith"),
        },
        { alyosha: 4 }
      )
    ).toBeNull();
  });
});
