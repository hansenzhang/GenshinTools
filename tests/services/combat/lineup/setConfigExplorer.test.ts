import "@/providers/reference/statLoaders";
import { beforeAll, describe, expect, it } from "vitest";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import { setChoiceKey } from "@/domain/combat/lineup/setChoices";
import type { MainStat, Slot, SubStat } from "@/domain/enums";
import type {
  AccountData,
  ArtifactData,
  ArtifactSetConfig,
  CharacterData,
} from "@/domain/models";
import {
  type CharacterStatsMap,
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import type {
  SetConfigExplorerMessage,
  SetConfigExplorerRequest,
  SetConfigExplorerResult,
} from "@/domain/team/setConfigExplorerTypes";
import { buildTeamSlotConfigs } from "@/domain/team/teamConfigUtils";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";
import { runSetConfigExplorer } from "@/services/combat/lineup/setConfigExplorer";

let chars: CharacterStatsMap;
beforeAll(async () => {
  [chars] = await Promise.all([
    characterStatsResource.preload(),
    weaponStatsResource.preload(),
  ]);
});

const set = (setId: string): ArtifactSetConfig => ({ type: "4pc", setId });
const CW = "crimson_witch_of_flames";
const NOBLESSE = "noblesse_oblige";
const EMBLEM = "emblem_of_severed_fate";
const TENACITY = "tenacity_of_the_millelith";
const SLOTS: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];

function pieces(
  setKey: string,
  mains: [MainStat, MainStat, MainStat],
  substats: Partial<Record<SubStat, number>>
): ArtifactData[] {
  const slotMains: MainStat[] = ["hp", "atk", ...mains];
  return SLOTS.map((slotKey, index) => ({
    id: `${setKey}-${slotKey}`,
    setKey,
    slotKey,
    level: 20,
    rarity: 5,
    mainStatKey: slotMains[index],
    lock: false,
    substats,
  }));
}

const JUNK_CW = pieces(CW, ["def%", "def%", "def%"], { def: 40 });
const GREAT_NOBLESSE = pieces(NOBLESSE, ["hp%", "pyro%", "cr"], {
  cr: 10.5,
  cd: 21,
  "hp%": 10,
});
const EMBLEM_PIECES = pieces(EMBLEM, ["er", "hydro%", "cr"], {
  cr: 7,
  cd: 14,
  "atk%": 10,
});
const TENACITY_PIECES = pieces(TENACITY, ["hp%", "hp%", "hp%"], {
  "hp%": 10,
});

function character(key: string, weaponKey: string): CharacterData {
  return {
    key,
    level: 90,
    constellation: key === "hu_tao" ? 1 : 6,
    talent: { auto: 10, skill: 10, burst: 10 },
    weapon: {
      id: `${key}-weapon`,
      key: weaponKey,
      refinement: key === "hu_tao" ? 1 : 3,
      level: 90,
      lock: false,
    },
    artifacts: {},
  };
}

function request(
  overrides: Partial<SetConfigExplorerRequest["settings"]> = {}
): SetConfigExplorerRequest {
  const accountData: AccountData = {
    characters: [
      character("hu_tao", "staff_of_homa"),
      character("xingqiu", "sacrificial_sword"),
      character("zhongli", "favonius_lance"),
      character("bennett", "favonius_sword"),
    ],
    extraArtifacts: [
      ...JUNK_CW,
      ...GREAT_NOBLESSE,
      ...EMBLEM_PIECES,
      ...TENACITY_PIECES,
    ],
    extraWeapons: [],
  };
  const teamComp = teamCompInputToComp({
    id: "explore",
    characters: accountData.characters.map((char) => char.key),
    weapons: accountData.characters.map((char) => char.weapon!.key),
    artifacts: [set(CW), set(EMBLEM), set(TENACITY), set(NOBLESSE)],
  });
  const configs = buildTeamSlotConfigs(
    teamComp,
    { combatOptions: {} },
    accountData
  );
  const team = new TeamBuild(configs);
  const lines = configs.flatMap((config) =>
    Object.entries(team.catalog.getCombo(config.charId))
      .filter(([, count]) => count > 0)
      .map(([formulaId, count]) => ({
        charId: config.charId,
        formulaId,
        count,
      }))
  );
  const objective = { id: "rotation", label: { en: "R", zh: "R" }, lines };
  const context = {
    enemyLevel: 100,
    enemyRes: 0.1,
    rollMultiplier: 0.85,
    substatBudget: "8_6" as const,
  };
  return {
    teamComp,
    setupConfig: { combatOptions: {} },
    accountData,
    objective,
    carryCharId: "hu_tao",
    optimizeContext: context,
    displayContext: context,
    settings: {
      useAccountArtifacts: true,
      lockedCharIds: ["xingqiu", "zhongli"],
      pinned: {},
      timeBudgetSec: 12,
      ...overrides,
    },
  };
}

async function run(input: SetConfigExplorerRequest) {
  const messages: SetConfigExplorerMessage[] = [];
  await runSetConfigExplorer(input, chars, (message) => messages.push(message));
  return messages;
}

function finalResult(
  messages: SetConfigExplorerMessage[]
): SetConfigExplorerResult {
  const last = messages.at(-1);
  if (last?.type !== "result")
    throw new Error(`Expected a result, got ${JSON.stringify(last)}`);
  return last.result;
}

const choiceOf = (
  result: SetConfigExplorerResult,
  index: number,
  charId: string
) => setChoiceKey(result.outcomes[index].assignment[charId] ?? null);

describe("runSetConfigExplorer", () => {
  it("reports a generated ranking without account artifacts", async () => {
    const messages = await run(request({ useAccountArtifacts: false }));
    expect(messages.some((message) => message.type === "progress")).toBe(true);
    expect(messages.some((message) => message.type === "partial")).toBe(false);
    const result = finalResult(messages);
    expect(result.basis).toBe("generated");
    expect(result.partial).toBe(false);
    expect(result.outcomes.every((outcome) => !outcome.account)).toBe(true);
    expect(choiceOf(result, result.currentIndex, "hu_tao")).toBe(CW);
  }, 60_000);

  it("lets real piece quality move a team-buff set onto the carry", async () => {
    const messages = await run(request());
    expect(messages.some((message) => message.type === "partial")).toBe(true);
    const result = finalResult(messages);
    expect(result.basis).toBe("account");
    const generated = result.outcomes
      .map((outcome, index) => ({ outcome, index }))
      .filter(({ outcome }) => outcome.generatedDamage != null)
      .sort(
        (a, b) =>
          (b.outcome.generatedDamage ?? 0) - (a.outcome.generatedDamage ?? 0)
      )[0].index;
    // With ideal artifacts, Hu Tao keeps Crimson Witch and Bennett carries Noblesse.
    expect(choiceOf(result, generated, "hu_tao")).toBe(CW);
    expect(choiceOf(result, generated, "bennett")).toBe(NOBLESSE);
    // With these pieces, Hu Tao is better off in the excellent Noblesse pieces.
    expect(choiceOf(result, result.bestIndex, "hu_tao")).toBe(NOBLESSE);
    const best = result.outcomes[result.bestIndex].account!;
    expect(best.damage).toBeGreaterThan(
      result.outcomes[result.currentIndex].account?.damage ?? 0
    );
    expect(setChoiceKey(best.realized.hu_tao ?? null)).toBe(NOBLESSE);
    const ids = Object.values(best.artifactsByChar).flatMap((slots) =>
      Object.values(slots).map((artifact) => artifact?.id)
    );
    expect(new Set(ids).size).toBe(ids.length);
    // Locked members keep their sets in every assignment.
    for (const outcome of result.outcomes) {
      expect(setChoiceKey(outcome.assignment.xingqiu ?? null)).toBe(EMBLEM);
      expect(setChoiceKey(outcome.assignment.zhongli ?? null)).toBe(TENACITY);
    }
  }, 120_000);

  it("reports pinned choices the pieces cannot form as unreachable", async () => {
    const result = finalResult(
      await run(request({ pinned: { bennett: [set("gladiators_finale")] } }))
    );
    const row = result.rowsByChar.bennett.find(
      (candidate) => candidate.key === "gladiators_finale"
    );
    expect(row?.pinned).toBe(true);
    const outcome = result.outcomes[row!.outcomeIndex];
    expect(outcome.account?.damage).toBeNull();
    expect(outcome.account?.failReasons.bennett?.kind).toBe("set-impossible");
    expect(result.bestIndex).not.toBe(row!.outcomeIndex);
  }, 120_000);

  it("never uses pieces another team reserved", async () => {
    const input = request();
    input.inventoryReservations = {
      teams: {
        other: {
          frozenCharIds: ["diluc"],
          artifactsByChar: {
            diluc: Object.fromEntries(
              GREAT_NOBLESSE.map((artifact) => [artifact.slotKey, artifact])
            ) as Record<Slot, ArtifactData>,
          },
        },
      },
      reuseMode: "none",
      standaloneIds: [],
    };
    const result = finalResult(await run(input));
    const reserved = new Set(GREAT_NOBLESSE.map((artifact) => artifact.id));
    for (const outcome of result.outcomes) {
      for (const slots of Object.values(outcome.account?.artifactsByChar ?? {}))
        for (const artifact of Object.values(slots))
          expect(reserved.has(artifact?.id ?? "")).toBe(false);
      // No member can wear Noblesse without the reserved pieces.
      if (outcome.account?.damage != null)
        expect(setChoiceKey(outcome.assignment.hu_tao ?? null)).not.toBe(
          NOBLESSE
        );
    }
  }, 120_000);

  it("keeps force-reused members on their saved pieces", async () => {
    const input = request({ lockedCharIds: ["xingqiu"] });
    const saved = Object.fromEntries(
      TENACITY_PIECES.map((artifact) => [artifact.slotKey, artifact])
    ) as Record<Slot, ArtifactData>;
    input.inventoryReservations = {
      teams: {
        other: {
          frozenCharIds: ["zhongli"],
          artifactsByChar: { zhongli: saved },
        },
      },
      reuseMode: "forceReuse",
      standaloneIds: [],
    };
    const result = finalResult(await run(input));
    const evaluated = result.outcomes.filter((outcome) => outcome.account);
    expect(evaluated.length).toBeGreaterThan(1);
    for (const outcome of result.outcomes)
      expect(setChoiceKey(outcome.assignment.zhongli ?? null)).toBe(TENACITY);
    for (const outcome of evaluated)
      expect(
        Object.values(outcome.account!.artifactsByChar.zhongli ?? {}).map(
          (artifact) => artifact?.id
        )
      ).toEqual(TENACITY_PIECES.map((artifact) => artifact.id));
  }, 120_000);
});
