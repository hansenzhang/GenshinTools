import "@/providers/reference/statLoaders";
import { describe, expect, it } from "vitest";
import {
  DirectFormula,
  TransformFormula,
} from "@/domain/combat/damage/core/damageFormula";
import { evaluate, simplify } from "@/domain/combat/damage/core/expr";
import {
  createExprStats,
  VarMapping,
} from "@/domain/combat/damage/core/exprStatSheet";
import { StatSheet } from "@/domain/combat/damage/core/statSheet";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type { CalcContext, TeamSlotConfig } from "@/domain/combat/damage/types";
import { resolveEnemyRes } from "@/domain/combat/damage/utils";
import { ELEMENT_KEYS, type StatKey } from "@/domain/enums";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import "@/domain/combat/damage/index";
import { getFirstFormulaId } from "../../../fixtures/optimizerHelpers";

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

const ALL_EQUAL: CalcContext = {
  ...CTX,
  enemyResByElement: Object.fromEntries(
    ELEMENT_KEYS.map((element) => [element, CTX.enemyRes])
  ),
};

const pyroCharged = new DirectFormula(2.426, {
  element: "Pyro",
  ability: "charge",
  reaction: "none",
});
const hydroSkill = new DirectFormula(1.5, {
  element: "Hydro",
  ability: "skill",
  reaction: "none",
});

const sheet = new StatSheet([
  { key: "baseAtk", value: 800 },
  { key: "atk%", value: 0.5 },
  { key: "cr", value: 0.6 },
  { key: "cd", value: 1.2 },
  { key: "em", value: 200 },
]);

describe("per-element enemy RES", () => {
  it("falls back to the single RES for elements without an entry", () => {
    const ctx = { ...CTX, enemyResByElement: { Pyro: 0.5 } };
    expect(resolveEnemyRes(ctx, "Pyro")).toBe(0.5);
    expect(resolveEnemyRes(ctx, "Hydro")).toBe(0.1);
    expect(resolveEnemyRes(CTX, "Physical")).toBe(0.1);
  });

  it("matches the single-RES result exactly when every element is equal", () => {
    for (const formula of [pyroCharged, hydroSkill]) {
      expect(formula.calc(sheet, 90, ALL_EQUAL)).toBe(
        formula.calc(sheet, 90, CTX)
      );
      expect(formula.display(sheet, 90, ALL_EQUAL).damage).toBe(
        formula.display(sheet, 90, CTX).damage
      );
    }
  });

  it("applies each element's RES only to damage of that element", () => {
    const ctx = { ...CTX, enemyResByElement: { Pyro: 0.5 } };
    // RES 50% → ×0.5 against the default ×0.9.
    expect(pyroCharged.calc(sheet, 90, ctx)).toBeCloseTo(
      (pyroCharged.calc(sheet, 90, CTX) * 0.5) / 0.9,
      6
    );
    expect(hydroSkill.calc(sheet, 90, ctx)).toBe(
      hydroSkill.calc(sheet, 90, CTX)
    );
    expect(pyroCharged.display(sheet, 90, ctx).params.enemyRes).toBe(0.5);
    expect(hydroSkill.display(sheet, 90, ctx).params.enemyRes).toBe(0.1);
  });

  it("uses the reaction damage element for transformative reactions", () => {
    const overloaded = new TransformFormula(0, {
      element: "Pyro",
      ability: "skill",
      reaction: "overloaded",
    });
    const ctx = { ...CTX, enemyResByElement: { Pyro: -0.2, Electro: 0.7 } };
    // RES −20% → ×1.1 against the default ×0.9.
    expect(overloaded.calc(sheet, 90, ctx)).toBeCloseTo(
      (overloaded.calc(sheet, 90, CTX) * 1.1) / 0.9,
      6
    );
  });

  it("compiles the per-element RES into the expression path", () => {
    const ctx = { ...CTX, enemyResByElement: { Pyro: 0.9 } };
    const baseline = new StatSheet([
      { key: "baseAtk", value: 800 },
      { key: "cr", value: 0.05 },
      { key: "cd", value: 0.5 },
    ]);
    const varMapping = new VarMapping();
    const exprStats = createExprStats(
      baseline,
      0,
      varMapping,
      new Set<StatKey>(["atk%"])
    );
    const expr = simplify(pyroCharged.buildExpr(exprStats, 90, ctx));
    const compiled = evaluate(expr, new Float64Array(varMapping.totalVars));
    expect(compiled).toBeCloseTo(pyroCharged.calc(baseline, 90, ctx), 4);
  });

  it("keeps team damage unchanged when all elements equal the single RES", () => {
    const configs: TeamSlotConfig[] = [
      {
        charId: "diluc",
        charLevel: 90,
        constellation: 0,
        weaponId: "wolfs_gravestone",
        refinement: 1,
        artifactSet: null,
      },
      {
        charId: "xingqiu",
        charLevel: 90,
        constellation: 6,
        weaponId: "sacrificial_sword",
        refinement: 5,
        artifactSet: null,
      },
    ];
    const sheets = {
      diluc: new StatSheet([]),
      xingqiu: new StatSheet([]),
    };
    const damage = (ctx: CalcContext) => {
      const tb = new TeamBuild(configs, {}, undefined, [], undefined, ctx);
      tb.teamStats.setArtifacts(sheets, ctx);
      return tb.getDamageResult("diluc", getFirstFormulaId(tb, "diluc"), ctx)
        .totalDamage;
    };
    const single = damage(CTX);
    expect(single).toBeGreaterThan(0);
    expect(damage(ALL_EQUAL)).toBe(single);
    expect(damage({ ...CTX, enemyResByElement: { Hydro: 0.7 } })).toBe(single);
    expect(damage({ ...CTX, enemyResByElement: { Pyro: 0.7 } })).toBeLessThan(
      single
    );
  });
});
