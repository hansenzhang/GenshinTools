import { describe, expect, it } from "vitest";
import type { BuildMatchResult } from "@/domain/build/artifact/scoring/artifactScore";
import { prepareSlotData } from "@/domain/combat/optimizer/artifactScoring";
import type { Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";

const SLOTS: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];

// Scores pieces by their CR substat alone.
const byCr = { statWeights: { cr: 1 } } as unknown as BuildMatchResult;

function piece(id: string, setKey: string, slotKey: Slot, cr: number) {
  return {
    id,
    setKey,
    slotKey,
    level: 0,
    rarity: 4,
    mainStatKey: slotKey === "flower" ? "hp" : "atk",
    lock: true,
    substats: { cr },
  } as ArtifactData;
}

/** Per slot: `strong` high-CR off-set pieces, then 3 weak pieces of `setKey`. */
function inventory(setKey: string, strong: number): ArtifactData[] {
  return SLOTS.flatMap((slot) => [
    ...Array.from({ length: strong }, (_, i) =>
      piece(`${slot}-strong-${i}`, "gladiators_finale", slot, 10 + i)
    ),
    ...[1, 2, 3].map((i) => piece(`${slot}-${setKey}-${i}`, setKey, slot, i)),
  ]);
}

const setPieces = (setKey: string, slots: ReturnType<typeof prepareSlotData>) =>
  slots.map((slot) => slot.bySet.get(setKey)?.length ?? 0);

describe("prepareSlotData", () => {
  it("keeps the set goal's unlevelled pieces for a carry", () => {
    const arts = inventory("instructor", 60);
    const prepare = (goal: Parameters<typeof prepareSlotData>[7]) =>
      prepareSlotData(arts, undefined, byCr, 1, 0, null, true, goal);
    expect(setPieces("instructor", prepare(null))).toEqual([0, 0, 0, 0, 0]);
    const kept = prepare({ type: "4pc", setId: "instructor" });
    expect(setPieces("instructor", kept)).toEqual([3, 3, 3, 3, 3]);
    // Off-set pieces still stop at the cut.
    expect(kept[0].allArtifacts).toHaveLength(53);
  });

  it("keeps the top pieces of each half of a 2+2 goal under a slot cap", () => {
    // Instructor counts toward the EM half; Gladiator's Finale toward ATK%.
    const arts = inventory("instructor", 20);
    const slots = prepareSlotData(arts, undefined, byCr, 1, 5, null, false, {
      type: "2pc+2pc",
      halfSetIds: ["em-80", "atk%-18"],
    });
    expect(setPieces("instructor", slots)).toEqual([3, 3, 3, 3, 3]);
    expect(slots[0].allArtifacts).toHaveLength(8);
  });
});
