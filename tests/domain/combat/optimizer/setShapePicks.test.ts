import { describe, expect, it } from "vitest";
import {
  pickForChoice,
  rankPieces,
} from "@/domain/combat/optimizer/setShapePicks";
import type { MainStat, Slot } from "@/domain/enums";
import type { ArtifactData, ArtifactSetConfig } from "@/domain/models";

const SLOTS: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];
const set = (setId: string): ArtifactSetConfig => ({ type: "4pc", setId });

function pieces(
  id: string,
  setKey: string,
  mains: [MainStat, MainStat, MainStat]
): ArtifactData[] {
  const slotMains: MainStat[] = ["hp", "atk", ...mains];
  return SLOTS.map((slotKey, index) => ({
    id: `${id}-${slotKey}`,
    setKey,
    slotKey,
    level: 20,
    rarity: 5,
    mainStatKey: slotMains[index],
    lock: false,
    substats: {},
  }));
}

/** Values pieces by id, so picks are easy to predict. */
const byId = (values: Record<string, number>) => (artifact: ArtifactData) =>
  values[artifact.id] ?? 0;

describe("pickForChoice", () => {
  const gladiator = pieces("gladiator", "gladiators_finale", [
    "atk%",
    "atk%",
    "cr",
  ]);
  const shimenawa = pieces("shimenawa", "shimenawas_reminiscence", [
    "atk%",
    "atk%",
    "cr",
  ]);
  const wanderer = pieces("wanderer", "wanderers_troupe", ["em", "em", "em"]);
  const pool = [...gladiator, ...shimenawa, ...wanderer];

  it("takes four of the set and the best fifth piece", () => {
    // Wanderer's goblet beats every Gladiator piece in its slot.
    const value = byId({
      "gladiator-flower": 3,
      "gladiator-plume": 3,
      "gladiator-sands": 3,
      "gladiator-goblet": 1,
      "gladiator-circlet": 3,
      "wanderer-goblet": 5,
    });
    const picks = pickForChoice(
      rankPieces(pool, value, new Set()),
      set("gladiators_finale")
    );
    expect(picks && SLOTS.map((slot) => picks[slot].id)).toEqual([
      "gladiator-flower",
      "gladiator-plume",
      "gladiator-sands",
      "wanderer-goblet",
      "gladiator-circlet",
    ]);
  });

  it("forms a 2+2 from two different sets of the halves' groups", () => {
    const value = byId({
      "gladiator-flower": 5,
      "gladiator-plume": 5,
      "shimenawa-sands": 4,
      "shimenawa-goblet": 4,
      "wanderer-circlet": 9,
      "gladiator-circlet": 1,
    });
    const picks = pickForChoice(rankPieces(pool, value, new Set()), {
      type: "2pc+2pc",
      halfSetIds: ["atk%-18", "atk%-18"],
    });
    expect(picks && SLOTS.map((slot) => picks[slot].id)).toEqual([
      "gladiator-flower",
      "gladiator-plume",
      "shimenawa-sands",
      "shimenawa-goblet",
      "wanderer-circlet",
    ]);
  });

  it("cannot form a set whose pieces are taken or missing", () => {
    const ranked = rankPieces(
      pool,
      () => 1,
      new Set(["gladiator-flower", "gladiator-plume"])
    );
    expect(pickForChoice(ranked, set("gladiators_finale"))).toBeNull();
    expect(pickForChoice(ranked, set("noblesse_oblige"))).toBeNull();
    expect(pickForChoice(ranked, null)).not.toBeNull();
  });
});
