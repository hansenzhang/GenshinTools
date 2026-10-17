import { describe, expect, it } from "vitest";
import {
  canWearSetConfig,
  countSetSlots,
  isAssignmentJointlyFeasible,
  ownedConcreteSetCount,
} from "@/domain/combat/lineup/setFeasibility";
import type { Rarity, Slot } from "@/domain/enums";
import type { ArtifactData, ArtifactSetConfig } from "@/domain/models";
import { makeArt } from "../../../fixtures/optimizerHelpers";

function pieces(
  setKey: string,
  slots: Slot[],
  rarity: Rarity = 5
): ArtifactData[] {
  return slots.map((slot) => ({ ...makeArt(slot, setKey), rarity }));
}

const ALL: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];

describe("canWearSetConfig", () => {
  it("needs four distinct slots for a 4pc", () => {
    const three = countSetSlots(
      pieces("noblesse_oblige", ["flower", "flower", "plume", "sands"])
    );
    expect(
      canWearSetConfig({ type: "4pc", setId: "noblesse_oblige" }, three)
    ).toBe(false);
    const four = countSetSlots(
      pieces("noblesse_oblige", ["flower", "plume", "sands", "goblet"])
    );
    expect(
      canWearSetConfig({ type: "4pc", setId: "noblesse_oblige" }, four)
    ).toBe(true);
    expect(canWearSetConfig(null, countSetSlots([]))).toBe(true);
  });

  it("needs two different concrete sets that fill four slots for a 2+2", () => {
    const twoTwo: ArtifactSetConfig = {
      type: "2pc+2pc",
      halfSetIds: ["atk%-18", "atk%-18"],
    };
    // Two ATK sets, but both only in flower/plume: cannot fill four slots.
    const crowded = countSetSlots([
      ...pieces("gladiators_finale", ["flower", "plume"]),
      ...pieces("shimenawas_reminiscence", ["flower", "plume"]),
    ]);
    expect(canWearSetConfig(twoTwo, crowded)).toBe(false);
    const spread = countSetSlots([
      ...pieces("gladiators_finale", ["flower", "plume"]),
      ...pieces("shimenawas_reminiscence", ["sands", "goblet"]),
    ]);
    expect(canWearSetConfig(twoTwo, spread)).toBe(true);
    // One concrete set alone is not a 2+2 of the same group.
    const single = countSetSlots(pieces("gladiators_finale", ALL));
    expect(canWearSetConfig(twoTwo, single)).toBe(false);
    expect(ownedConcreteSetCount("atk%-18", spread)).toBe(2);
  });

  it("counts four-star pieces toward a two-piece group and ignores lower rarity", () => {
    const mixed = countSetSlots([
      ...pieces("gladiators_finale", ["flower", "plume"]),
      ...pieces("the_exile", ["sands", "goblet"], 4),
      ...pieces("scholar", ["sands", "goblet"], 3),
    ]);
    expect(
      canWearSetConfig(
        { type: "2pc+2pc", halfSetIds: ["atk%-18", "er-20"] },
        mixed
      )
    ).toBe(true);
    expect(ownedConcreteSetCount("er-20", mixed)).toBe(1);
  });
});

describe("isAssignmentJointlyFeasible", () => {
  const noblesse = { type: "4pc", setId: "noblesse_oblige" } as const;

  it("needs about eight pieces for two wearers of one 4pc", () => {
    const five = countSetSlots(pieces("noblesse_oblige", ALL));
    expect(isAssignmentJointlyFeasible({ a: noblesse, b: null }, five)).toBe(
      true
    );
    expect(
      isAssignmentJointlyFeasible({ a: noblesse, b: noblesse }, five)
    ).toBe(false);
    const eight = countSetSlots(
      pieces("noblesse_oblige", [...ALL, "flower", "plume", "sands"])
    );
    expect(
      isAssignmentJointlyFeasible({ a: noblesse, b: noblesse }, eight)
    ).toBe(true);
  });
});
