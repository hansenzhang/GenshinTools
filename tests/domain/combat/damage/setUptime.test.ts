import "@/providers/reference/statLoaders";
import { describe, expect, it } from "vitest";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import "@/domain/combat/damage/index";
import { buildBuffOverrides } from "@/domain/combat/damage/core/comboBuffOverrides";
import { defaultSetUptime } from "@/domain/combat/damage/core/setUptime";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type {
  CalcContext,
  ComboFormula,
  SetUptimeSettings,
  TeamSlotConfig,
} from "@/domain/combat/damage/types";
import { emptySheets } from "../../../fixtures/optimizerHelpers";

await Promise.all([
  characterStatsResource.preload(),
  weaponStatsResource.preload(),
]);

const CTX: CalcContext = {
  enemyLevel: 100,
  enemyRes: 0.1,
  rollMultiplier: 0.85,
  substatBudget: "8_6",
};

// Hu Tao drives; Bennett wears Noblesse (Q, 12 s), Diona Tenacity (E, 3 s).
const TEAM: TeamSlotConfig[] = [
  {
    charId: "hu_tao",
    charLevel: 90,
    constellation: 0,
    weaponId: "staff_of_homa",
    refinement: 1,
    artifactSet: null,
  },
  {
    charId: "bennett",
    charLevel: 90,
    constellation: 0,
    weaponId: "aquila_favonia",
    refinement: 1,
    artifactSet: { type: "4pc", setId: "noblesse_oblige" },
  },
  {
    charId: "diona",
    charLevel: 90,
    constellation: 0,
    weaponId: "sacrificial_bow",
    refinement: 1,
    artifactSet: { type: "4pc", setId: "tenacity_of_the_millelith" },
  },
];

const COMBO: ComboFormula = {
  id: "test",
  label: { zh: "测试", en: "Test" },
  lines: [
    { charId: "hu_tao", formulaId: "hutao-charged", count: 8 },
    { charId: "bennett", formulaId: "bennett-skill", count: 2 },
    { charId: "diona", formulaId: "diona-skill", count: 1 },
  ],
};

const sheets = emptySheets("hu_tao", "bennett", "diona");

function damage(team: TeamBuild, settings?: SetUptimeSettings): number {
  const overrides = buildBuffOverrides(
    COMBO.lines,
    team,
    sheets,
    CTX,
    undefined,
    settings
  );
  return team.getComboDamageResult(COMBO, sheets, CTX, overrides).totalDamage;
}

describe("timed set uptime", () => {
  const team = new TeamBuild(TEAM);
  const { formulaIndex } = team.catalog;

  it("defaults to full uptime without a rotation length", () => {
    expect(
      defaultSetUptime(3, ["E"], "diona", COMBO.lines, formulaIndex, undefined)
    ).toBe(1);
  });

  it("counts the wearer's casts of the triggering ability", () => {
    // Diona casts E once: 3 s of an 18 s rotation.
    expect(
      defaultSetUptime(3, ["E"], "diona", COMBO.lines, formulaIndex, 18)
    ).toBeCloseTo(3 / 18);
    // Bennett's Burst deals no counted damage; he still casts it once.
    expect(
      defaultSetUptime(12, ["Q"], "bennett", COMBO.lines, formulaIndex, 18)
    ).toBeCloseTo(12 / 18);
    // Two E casts for an E-triggered effect.
    expect(
      defaultSetUptime(3, ["E"], "bennett", COMBO.lines, formulaIndex, 18)
    ).toBeCloseTo(6 / 18);
  });

  it("keeps a driver's effects at full uptime", () => {
    expect(
      defaultSetUptime(
        8,
        ["on-reaction"],
        "hu_tao",
        COMBO.lines,
        formulaIndex,
        18
      )
    ).toBe(1);
  });

  it("lists each worn timed set with its default and override", () => {
    const effects = team.getTimedSetEffects(COMBO.lines, {
      rotationSeconds: 18,
      overrides: { noblesse_oblige: 0.5 },
    });
    expect(effects).toEqual([
      {
        setId: "noblesse_oblige",
        wearerId: "bennett",
        duration: 12,
        defaultUptime: 12 / 18,
        uptime: 0.5,
      },
      {
        setId: "tenacity_of_the_millelith",
        wearerId: "diona",
        duration: 3,
        defaultUptime: 3 / 18,
        uptime: 3 / 18,
      },
    ]);
  });

  it("prices a share of the rotation as that share of the buffed hits", () => {
    const full = damage(team);
    const keep = { tenacity_of_the_millelith: 1 };
    const off = damage(team, {
      overrides: { ...keep, noblesse_oblige: 0 },
    });
    const half = damage(team, {
      overrides: { ...keep, noblesse_oblige: 0.5 },
    });
    expect(off).toBeLessThan(full);
    expect(half).toBeCloseTo((full + off) / 2, 6);
    expect(damage(team, { overrides: { noblesse_oblige: 1, ...keep } })).toBe(
      full
    );
  });

  it("lowers damage once a rotation length is saved", () => {
    expect(damage(team, { rotationSeconds: 18 })).toBeLessThan(damage(team));
  });
});
