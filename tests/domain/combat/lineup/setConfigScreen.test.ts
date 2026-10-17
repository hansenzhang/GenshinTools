import "@/providers/reference/statLoaders";
import "@/domain/combat/damage/index";
import { describe, expect, it, vi } from "vitest";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type {
  CalcContext,
  ComboFormula,
  TeamSlotConfig,
} from "@/domain/combat/damage/types";
import { buildChoiceRows } from "@/domain/combat/lineup/setAssignments";
import { setChoiceKey } from "@/domain/combat/lineup/setChoices";
import {
  runSetConfigScreen,
  type SetScreenInput,
} from "@/domain/combat/lineup/setConfigScreen";
import type { Element } from "@/domain/enums";
import type { ArtifactSetConfig } from "@/domain/models";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";

// Fewer generated re-scores keep the suite light; witnesses still cover
// each member's top choices, shapes and pins.
vi.mock("@/domain/combat/lineup/constants", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/domain/combat/lineup/constants")
  >()),
  SET_GENERATED_REFINE_COUNT: 8,
}));

const [chars] = await Promise.all([
  characterStatsResource.preload(),
  weaponStatsResource.preload(),
]);

const CTX: CalcContext = {
  enemyLevel: 100,
  enemyRes: 0.1,
  rollMultiplier: 0.85,
  substatBudget: "8_6",
};

const set = (setId: string): ArtifactSetConfig => ({ type: "4pc", setId });
const twoTwo = (a: string, b: string): ArtifactSetConfig => ({
  type: "2pc+2pc",
  halfSetIds: [a, b],
});
const SILKEN = "silken_moons_serenade";
const DISENCHANTMENT = "disenchantment_in_deep_shadow";

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
  overrides: Partial<SetScreenInput> = {}
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
      teamConfigs.map((config) => [config.charId, { minEr: 1, minCr: 0 }])
    ),
    elements: Object.fromEntries(
      teamConfigs.map((config) => [
        config.charId,
        chars[config.charId].element as Element,
      ])
    ),
    lockedCharIds: new Set(),
    pinned: {},
    ...overrides,
  };
}

const LUNAR = configs([
  ["flins", "bloodsoaked_ruins", set("night_of_the_skys_unveiling")],
  ["columbina", "nocturnes_curtain_call", set(SILKEN)],
  ["ineffa", "fractured_halo", set(SILKEN)],
  ["sucrose", "thrilling_tales_of_dragon_slayers", set("viridescent_venerer")],
]);

const SANDRONE = configs([
  ["sandrone", "a_teaspoon_of_transcendence", set(DISENCHANTMENT)],
  ["yae_miko", "kaguras_verity", set(DISENCHANTMENT)],
  ["odette", "whitelake_frostfeather", set("heart_of_the_furnace")],
  ["alyosha", "favonius_lance", set("tenacity_of_the_millelith")],
]);

function silkenCarriers(assignment: Record<string, ArtifactSetConfig | null>) {
  return Object.entries(assignment).filter(
    ([, choice]) => setChoiceKey(choice) === SILKEN
  ).length;
}

describe("runSetConfigScreen", () => {
  it("finds one Silken Moon carrier and compares Silken on each Moonsign member", async () => {
    const output = await runSetConfigScreen(
      input(LUNAR, { lockedCharIds: new Set(["flins", "sucrose"]) }),
      () => {}
    );
    expect(output).not.toBeNull();
    const generated = output!.outcomes.filter(
      (outcome) => outcome.generatedDamage != null
    );
    const best = generated.reduce((a, b) =>
      (b.generatedDamage ?? 0) > (a.generatedDamage ?? 0) ? b : a
    );
    expect(silkenCarriers(best.assignment)).toBe(1);
    const rows = buildChoiceRows(output!.outcomes, output!.charIds, {});
    for (const charId of ["columbina", "ineffa"])
      expect(
        rows[charId].some(
          (row) => row.key === SILKEN && row.basis === "generated"
        )
      ).toBe(true);
    // Locked members never change.
    for (const outcome of output!.outcomes) {
      expect(setChoiceKey(outcome.assignment.flins)).toBe(
        "night_of_the_skys_unveiling"
      );
      expect(setChoiceKey(outcome.assignment.sucrose)).toBe(
        "viridescent_venerer"
      );
    }
  }, 60_000);

  it("re-scores pinned 2+2 choices and both Disenchantment wearers", async () => {
    const pinned = {
      yae_miko: [
        twoTwo("atk%-18", "atk%-18"),
        twoTwo("atk%-18", "em-80"),
        twoTwo("em-80", "em-80"),
      ],
    };
    const output = await runSetConfigScreen(
      input(SANDRONE, {
        lockedCharIds: new Set(["odette", "alyosha"]),
        pinned,
        requirements: {
          sandrone: { minEr: 1, minCr: 0 },
          yae_miko: { minEr: 1, minCr: 0 },
          odette: { minEr: 1, minCr: 0 },
          alyosha: { minEr: 1.3, minCr: 0 },
        },
      }),
      () => {}
    );
    expect(output).not.toBeNull();
    const rows = buildChoiceRows(output!.outcomes, output!.charIds, pinned);
    const yaeKeys = rows.yae_miko
      .filter((row) => row.basis === "generated")
      .map((row) => row.key);
    expect(yaeKeys).toEqual(
      expect.arrayContaining([
        "atk%-18+atk%-18",
        "atk%-18+em-80",
        "em-80+em-80",
        DISENCHANTMENT,
      ])
    );
    expect(rows.yae_miko.filter((row) => row.pinned)).toHaveLength(3);
    expect(
      rows.sandrone.some(
        (row) => row.key === DISENCHANTMENT && row.basis === "generated"
      )
    ).toBe(true);
    // Generated artifacts meet the 4★ support's ER requirement.
    for (const outcome of output!.outcomes)
      expect(outcome.generatedErShortCharIds ?? []).not.toContain("alyosha");
  }, 60_000);

  it("skips choices the account cannot wear and infeasible shared sets", async () => {
    const output = await runSetConfigScreen(
      input(LUNAR, {
        lockedCharIds: new Set(["flins", "sucrose"]),
        canWear: (charId, choice) =>
          !(
            charId === "columbina" &&
            setChoiceKey(choice) === "aubade_of_morningstar_and_moon"
          ),
        isJointlyFeasible: (assignment) => silkenCarriers(assignment) < 2,
      }),
      () => {}
    );
    expect(output).not.toBeNull();
    const [current, ...others] = output!.outcomes;
    expect(silkenCarriers(current.assignment)).toBe(2);
    for (const outcome of others) {
      expect(silkenCarriers(outcome.assignment)).toBeLessThan(2);
      expect(setChoiceKey(outcome.assignment.columbina)).not.toBe(
        "aubade_of_morningstar_and_moon"
      );
    }
  }, 60_000);
});
