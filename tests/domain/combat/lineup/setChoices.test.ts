import "@/providers/reference/statLoaders";
import "@/domain/combat/damage/index";
import { describe, expect, it } from "vitest";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import {
  assignmentKey,
  buildFourPieceChoices,
  buildTwoPlusTwoChoices,
  isErBearing,
  setChoiceKey,
} from "@/domain/combat/lineup/setChoices";
import { artifactsById } from "@/domain/reference/catalog";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";

await Promise.all([
  characterStatsResource.preload(),
  weaponStatsResource.preload(),
]);

function pairKeys(element: Parameters<typeof buildTwoPlusTwoChoices>[0]) {
  return buildTwoPlusTwoChoices(element).map(setChoiceKey);
}

describe("buildFourPieceChoices", () => {
  it("lists five-star sets and the four-star support sets, each buildable", () => {
    const choices = buildFourPieceChoices();
    const setIds = choices.flatMap((choice) =>
      choice.type === "4pc" ? [choice.setId] : []
    );
    expect(setIds).toContain("silken_moons_serenade");
    expect(setIds).toContain("instructor");
    expect(new Set(setIds).size).toBe(setIds.length);
    for (const setId of setIds) {
      const rarity = artifactsById[setId]?.rarity;
      expect(
        rarity === 5 || ["the_exile", "instructor", "scholar"].includes(setId)
      ).toBe(true);
      expect(
        () =>
          new TeamBuild([
            {
              charId: "yae_miko",
              charLevel: 90,
              constellation: 0,
              weaponId: "kaguras_verity",
              refinement: 1,
              artifactSet: { type: "4pc", setId },
            },
          ])
      ).not.toThrow();
    }
  });
});

describe("buildTwoPlusTwoChoices", () => {
  it("pairs damage-relevant halves and only the member's own element", () => {
    const keys = pairKeys("Electro");
    expect(keys).toContain("atk%-18+em-80");
    expect(keys).toContain("atk%-18+electro%-15");
    expect(keys).toContain("burst-dmg%-20+em-80");
    expect(keys).toContain("em-80+skill-dmg%-20");
    expect(keys).toContain("atk%-18+na-ca-dmg%-15");
    expect(keys.some((key) => key.includes("pyro%-15"))).toBe(false);
    for (const excluded of [
      "heal%-15",
      "shield-35",
      "electro-res-40",
      "pyro-res-40",
      "nightsoul-energy-6",
    ])
      expect(keys.some((key) => key.includes(excluded))).toBe(false);
  });

  it("allows a same-group pair only with two concrete sets", () => {
    const keys = pairKeys("Electro");
    expect(keys).toContain("atk%-18+atk%-18");
    expect(keys).toContain("em-80+em-80");
    expect(keys).not.toContain("electro%-15+electro%-15");
    expect(keys).not.toContain("burst-dmg%-20+burst-dmg%-20");
    expect(
      buildTwoPlusTwoChoices("Electro", () => 1).map(setChoiceKey)
    ).not.toContain("atk%-18+atk%-18");
  });

  it("lists each unordered pair once", () => {
    const keys = pairKeys("Hydro");
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("set choice keys", () => {
  it("canonicalizes 2+2 order and names missing goals", () => {
    expect(
      setChoiceKey({ type: "2pc+2pc", halfSetIds: ["em-80", "atk%-18"] })
    ).toBe("atk%-18+em-80");
    expect(setChoiceKey(null)).toBe("none");
    expect(
      assignmentKey({ b: null, a: { type: "4pc", setId: "noblesse_oblige" } }, [
        "a",
        "b",
      ])
    ).toBe("noblesse_oblige|none");
  });

  it("recognizes Energy Recharge set bonuses", () => {
    expect(isErBearing({ type: "4pc", setId: "emblem_of_severed_fate" })).toBe(
      true
    );
    expect(isErBearing({ type: "4pc", setId: "silken_moons_serenade" })).toBe(
      true
    );
    expect(
      isErBearing({ type: "2pc+2pc", halfSetIds: ["atk%-18", "er-20"] })
    ).toBe(true);
    expect(isErBearing({ type: "4pc", setId: "gladiators_finale" })).toBe(
      false
    );
    expect(isErBearing(null)).toBe(false);
  });
});
