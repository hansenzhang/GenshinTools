import { describe, expect, it } from "vitest";
import { DEFAULT_CALC_CONTEXT } from "@/domain/combat/damage/constants";
import type { TeamSlotConfig } from "@/domain/combat/damage/types";
import { resolveEnemyRes } from "@/domain/combat/damage/utils";
import { ELEMENT_KEYS } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import {
  type CharacterTraits,
  calibratedMargin,
  captureReferenceBuild,
  createAbyssEncounter,
  createStygianEncounter,
  createTeamTemplate,
  encounterCalcContext,
  templateCompositions,
} from "@/domain/team/lineup";
import type { Calibration, TeamTemplate } from "@/domain/team/lineupTypes";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";

const team = teamCompInputToComp({
  id: "team-1",
  name: "Neuvillette",
  characters: ["neuvillette", "furina", "kazuha", "zhongli"],
  weapons: [null, null, null, null],
  artifacts: [null, null, null, null],
});

const TRAITS: Record<string, CharacterTraits> = {
  neuvillette: { element: "Hydro" },
  furina: { element: "Hydro" },
  kazuha: { element: "Anemo" },
  zhongli: { element: "Geo" },
  xingqiu: { element: "Hydro" },
  baizhu: { element: "Dendro" },
  columbina: { element: "Hydro", faction: "Moonsign" },
};
const traits = (charId: string) => TRAITS[charId] ?? {};

function calibration(overrides: Partial<Calibration> = {}): Calibration {
  return {
    id: "calibration-1",
    templateId: "template-1",
    encounterId: "encounter-1",
    reference: { capturedAt: 1, slots: [], artifactsByChar: {} },
    measuredSeconds: 100,
    downtimeSeconds: null,
    ...overrides,
  };
}

describe("encounters", () => {
  it("takes a Stygian boss's Fearless level and base RES", () => {
    const encounter = createStygianEncounter("e", 10043, {
      id: 10043,
      tiers: { "4": { id: 1, level: 100 }, "5": { id: 2, level: 105 } },
      res: {
        Physical: -20,
        Pyro: 10,
        Hydro: 10,
        Electro: 10,
        Dendro: 10,
        Anemo: 10,
        Geo: 10,
        Cryo: 50,
      },
    });
    expect(encounter).toMatchObject({
      mode: "stygian",
      bossId: 10043,
      enemyLevel: 105,
      timeBarSeconds: null,
    });
    expect(encounter.res.Physical).toBe(-0.2);
    expect(encounter.res.Cryo).toBe(0.5);
  });

  it("uses 10% for a boss without RES data", () => {
    const encounter = createStygianEncounter("e", 1, {
      id: 1,
      tiers: { "5": { id: 2, level: 105 } },
    });
    expect(encounter.res).toEqual({});
    const ctx = encounterCalcContext(encounter, DEFAULT_CALC_CONTEXT);
    for (const element of ELEMENT_KEYS)
      expect(resolveEnemyRes(ctx, element)).toBe(0.1);
  });

  it("replaces the team's enemy with the encounter's in every element", () => {
    const encounter = {
      ...createAbyssEncounter("e", 3, 2),
      enemyLevel: 95,
      res: { Pyro: 0.7 },
    };
    const ctx = encounterCalcContext(encounter, {
      ...DEFAULT_CALC_CONTEXT,
      enemyRes: 0.4,
      enemyResByElement: { Hydro: 0.9 },
      rollMultiplier: 1,
    });
    expect(ctx.enemyLevel).toBe(95);
    expect(ctx.rollMultiplier).toBe(1);
    expect(resolveEnemyRes(ctx, "Pyro")).toBe(0.7);
    expect(resolveEnemyRes(ctx, "Hydro")).toBe(0.1);
    expect(resolveEnemyRes(ctx, "Physical")).toBe(0.1);
  });
});

describe("calibrated margin", () => {
  const encounter = {
    ...createAbyssEncounter("encounter-1", 1, 1),
    downtimeSeconds: 10,
    timeBarSeconds: 120,
  };

  it("scales the reference clear's slack by the DPS ratio", () => {
    // (120 − 10) / (100 − 10)
    const reference = calibratedMargin(1, calibration(), encounter);
    expect(reference).toEqual({ kind: "margin", margin: 110 / 90 });
    const weaker = calibratedMargin(0.9, calibration(), encounter);
    expect(weaker.kind === "margin" && weaker.margin).toBeCloseTo(1.1, 10);
  });

  it("uses the clear's own downtime over the encounter estimate", () => {
    const margin = calibratedMargin(
      1,
      calibration({ downtimeSeconds: 20 }),
      encounter
    );
    expect(margin).toEqual({ kind: "margin", margin: 100 / 80 });
  });

  it("reports a missing bar or downtime that leaves no damage time", () => {
    expect(
      calibratedMargin(1, calibration(), { ...encounter, timeBarSeconds: null })
    ).toEqual({ kind: "no-bar" });
    expect(
      calibratedMargin(1, calibration({ downtimeSeconds: 100 }), encounter)
    ).toEqual({ kind: "downtime-too-long" });
    expect(
      calibratedMargin(1, calibration({ downtimeSeconds: 120 }), {
        ...encounter,
      })
    ).toEqual({ kind: "downtime-too-long" });
  });
});

describe("team templates", () => {
  it("starts with the team's name and no flex slots", () => {
    const template = createTeamTemplate("template-1", team);
    expect(template).toMatchObject({
      name: "Neuvillette",
      teamId: "team-1",
      rules: [],
    });
    expect(templateCompositions(template, team, traits)).toEqual([
      ["neuvillette", "furina", "kazuha", "zhongli"],
    ]);
  });

  it("enumerates flex picks without repeating a character", () => {
    const template: TeamTemplate = {
      ...createTeamTemplate("template-1", team),
      flexBySlot: [[], ["xingqiu", "kazuha"], [], ["baizhu"]],
    };
    expect(templateCompositions(template, team, traits)).toEqual([
      ["neuvillette", "furina", "kazuha", "zhongli"],
      ["neuvillette", "furina", "kazuha", "baizhu"],
      ["neuvillette", "xingqiu", "kazuha", "zhongli"],
      ["neuvillette", "xingqiu", "kazuha", "baizhu"],
    ]);
  });

  it("keeps only compositions that meet every rule", () => {
    const template: TeamTemplate = {
      ...createTeamTemplate("template-1", team),
      flexBySlot: [[], ["columbina", "baizhu"], [], []],
      rules: [
        { kind: "element", element: "Hydro", min: 2 },
        { kind: "moonsign", min: 1 },
      ],
    };
    expect(templateCompositions(template, team, traits)).toEqual([
      ["neuvillette", "columbina", "kazuha", "zhongli"],
    ]);
  });
});

describe("reference builds", () => {
  it("copies the equipped artifacts so later account changes do not alter it", () => {
    const slots: TeamSlotConfig[] = [
      {
        charId: "neuvillette",
        charLevel: 90,
        constellation: 0,
        weaponId: "tome_of_the_eternal_flow",
        refinement: 1,
        artifactSet: { type: "4pc", setId: "marechaussee_hunter" },
      },
    ];
    const flower: ArtifactData = {
      id: "a1",
      setKey: "marechaussee_hunter",
      slotKey: "flower",
      level: 20,
      rarity: 5,
      mainStatKey: "hp",
      lock: true,
      substats: { cr: 10.5 },
    };
    const build = captureReferenceBuild(
      slots,
      { neuvillette: { flower, plume: null } },
      1234
    );
    flower.substats.cr = 0;
    slots[0]!.constellation = 6;
    expect(build.capturedAt).toBe(1234);
    expect(build.slots[0]!.constellation).toBe(0);
    expect(build.artifactsByChar.neuvillette).toEqual([
      { ...flower, substats: { cr: 10.5 } },
    ]);
  });
});
