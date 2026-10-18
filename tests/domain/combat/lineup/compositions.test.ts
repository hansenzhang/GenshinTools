import "@/providers/reference/statLoaders";
import "@/domain/combat/damage/index";
import { describe, expect, it } from "vitest";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type { ComboFormula } from "@/domain/combat/damage/types";
import {
  compositionObjective,
  countWeaponCopies,
  fieldComposition,
  resolveTeamObjective,
} from "@/domain/combat/lineup/compositions";
import type { AccountData, ArtifactData, CharacterData } from "@/domain/models";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import { createTeamTemplate } from "@/domain/team/lineup";
import { buildTeamSlotConfigs } from "@/domain/team/teamConfigUtils";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";

await Promise.all([
  characterStatsResource.preload(),
  weaponStatsResource.preload(),
]);

const CW = "crimson_witch_of_flames";
const flower = (id: string, setKey: string): ArtifactData => ({
  id,
  setKey,
  slotKey: "flower",
  level: 20,
  rarity: 5,
  mainStatKey: "hp",
  lock: false,
  substats: {},
});

function character(
  key: string,
  weaponKey: string,
  artifacts: CharacterData["artifacts"] = {}
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
    artifacts,
  };
}

const account: AccountData = {
  characters: [
    character("hu_tao", "staff_of_homa"),
    character("xingqiu", "sacrificial_sword"),
    character("yelan", "favonius_warbow"),
    character("bennett", "favonius_sword"),
    character("xiangling", "the_catch", { flower: flower("xl-flower", CW) }),
  ],
  extraArtifacts: [],
  extraWeapons: [],
};

const team = teamCompInputToComp({
  id: "team",
  characters: ["hu_tao", "xingqiu", "yelan", null],
  weapons: ["staff_of_homa", "favonius_sword", "favonius_warbow", null],
  artifacts: [{ type: "4pc", setId: CW }, null, null, null],
});
const template = {
  ...createTeamTemplate("template", team),
  flexBySlot: [[], ["xiangling"], [], []],
};

describe("fieldComposition", () => {
  it("keeps the team's weapons and sets and brings an alternative's own", () => {
    expect(countWeaponCopies(account)).toMatchObject({ favonius_sword: 1 });
    const fielded = fieldComposition(
      template,
      team,
      ["hu_tao", "xiangling", "yelan"],
      account
    );
    expect(fielded?.slots).toEqual([
      {
        charId: "hu_tao",
        weaponId: "staff_of_homa",
        artifactSet: { type: "4pc", setId: CW },
      },
      { charId: "xiangling", weaponId: "the_catch", artifactSet: null },
      { charId: "yelan", weaponId: "favonius_warbow", artifactSet: null },
    ]);
  });

  it("takes the equipped weapon when the slot's weapon has no copy left", () => {
    const twoFavonius = teamCompInputToComp({
      id: "team",
      characters: ["bennett", "xingqiu"],
      weapons: ["favonius_sword", "favonius_sword"],
    });
    const fielded = fieldComposition(
      createTeamTemplate("t", twoFavonius),
      twoFavonius,
      ["bennett", "xingqiu"],
      account
    );
    expect(fielded?.slots.map((slot) => slot.weaponId)).toEqual([
      "favonius_sword",
      "sacrificial_sword",
    ]);
  });

  it("cannot field characters that are not owned", () => {
    expect(
      fieldComposition(template, team, ["hu_tao", "kazuha", "yelan"], account)
    ).toBeNull();
  });
});

describe("compositionObjective", () => {
  const build = (members: [string, string][]) =>
    new TeamBuild(
      buildTeamSlotConfigs(
        teamCompInputToComp({
          id: "t",
          characters: members.map(([charId]) => charId),
          weapons: members.map(([, weaponId]) => weaponId),
        }),
        { combatOptions: {} },
        account
      )
    );
  const original = build([
    ["hu_tao", "staff_of_homa"],
    ["xingqiu", "sacrificial_sword"],
  ]);
  const rotation: ComboFormula = {
    ...resolveTeamObjective({ formulaMode: "combo" }, original),
    id: "rotation",
  };

  it("keeps staying members' lines and adds a joiner's defaults", () => {
    expect(rotation.lines.some((line) => line.charId === "xingqiu")).toBe(true);
    const swapped = build([
      ["hu_tao", "staff_of_homa"],
      ["xiangling", "the_catch"],
    ]);
    const objective = compositionObjective(rotation, false, swapped, [
      "hu_tao",
      "xingqiu",
    ]);
    expect(objective?.id).toBe("rotation");
    expect(objective?.lines.filter((l) => l.charId === "hu_tao")).toEqual(
      rotation.lines.filter((l) => l.charId === "hu_tao")
    );
    expect(objective?.lines.some((l) => l.charId === "xingqiu")).toBe(false);
    expect(objective?.lines.some((l) => l.charId === "xiangling")).toBe(true);
  });

  it("drops a single formula whose character left", () => {
    const single = resolveTeamObjective(
      {
        formulaMode: "single",
        selectedFormula: {
          charId: "xingqiu",
          formulaId: rotation.lines.find((l) => l.charId === "xingqiu")!
            .formulaId,
        },
      },
      original
    );
    expect(single.lines).toHaveLength(1);
    const without = build([
      ["hu_tao", "staff_of_homa"],
      ["xiangling", "the_catch"],
    ]);
    expect(
      compositionObjective(single, true, without, ["hu_tao", "xingqiu"])
    ).toBeNull();
    expect(
      compositionObjective(single, true, original, ["hu_tao", "xingqiu"])?.lines
    ).toEqual(single.lines);
  });
});
