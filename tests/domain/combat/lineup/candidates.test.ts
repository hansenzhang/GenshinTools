import { describe, expect, it } from "vitest";
import {
  candidateArtifactIds,
  candidateSetSlotUses,
  canFieldTogether,
  fillAnyPieces,
  findContestedGear,
} from "@/domain/combat/lineup/candidates";
import type { Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import type { LineupCandidate } from "@/domain/team/lineupSolverTypes";

const SLOTS: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];
const TENACITY = "tenacity_of_the_millelith";

function piece(id: string, setKey: string, slotKey: Slot, level = 20) {
  return {
    id,
    setKey,
    slotKey,
    level,
    rarity: 5,
    mainStatKey: "hp",
    lock: false,
    substats: {},
  } satisfies ArtifactData;
}

/** Four Tenacity pieces and a Gladiator circlet, ids prefixed by `id`. */
function wornPieces(id: string): Record<Slot, ArtifactData> {
  return Object.fromEntries(
    SLOTS.map((slot) => [
      slot,
      slot === "circlet"
        ? piece(`${id}-circlet`, "gladiators_finale", slot)
        : piece(`${id}-${slot}`, TENACITY, slot),
    ])
  ) as Record<Slot, ArtifactData>;
}

function candidate(
  id: string,
  charId: string,
  anyPieces: boolean,
  artifacts = wornPieces(id)
): LineupCandidate {
  return {
    id,
    templateId: id,
    encounterId: id,
    members: [
      {
        charId,
        weaponId: `${id}-weapon`,
        refinement: 1,
        artifactSet: { type: "4pc", setId: TENACITY },
        artifacts,
        anyPieces,
      },
    ],
    damage: 1,
    ratio: 1,
    origin: "search",
  };
}

const copies = { "a-weapon": 1, "b-weapon": 1 };

describe("members that take any pieces", () => {
  it("count their set's slots, not their own pieces", () => {
    const loose = candidate("a", "diona", true);
    expect(candidateArtifactIds(loose)).toEqual([]);
    expect(candidateSetSlotUses(loose)).toEqual({
      [`${TENACITY}:flower`]: 1,
      [`${TENACITY}:plume`]: 1,
      [`${TENACITY}:sands`]: 1,
      [`${TENACITY}:goblet`]: 1,
    });
    expect(candidateSetSlotUses(candidate("b", "ineffa", false))).toEqual({
      [`${TENACITY}:flower`]: 1,
      [`${TENACITY}:plume`]: 1,
      [`${TENACITY}:sands`]: 1,
      [`${TENACITY}:goblet`]: 1,
      "gladiators_finale:circlet": 1,
    });
  });

  it("can share pieces while the set has enough for everyone", () => {
    // Both wear the same pieces; one only needs the set.
    const shared = wornPieces("shared");
    const lineup = [
      candidate("a", "diona", true, shared),
      candidate("b", "ineffa", false, shared),
    ];
    expect(canFieldTogether(lineup, copies)).toBe(true);
    const counts = (perSlot: number) => ({
      ...Object.fromEntries(
        SLOTS.map((slot) => [`${TENACITY}:${slot}`, perSlot])
      ),
      "gladiators_finale:circlet": 1,
    });
    expect(canFieldTogether(lineup, copies, counts(2))).toBe(true);
    expect(canFieldTogether(lineup, copies, counts(1))).toBe(false);
    // No piece is contested, but the set's slots run short.
    const [loose, exact] = lineup;
    expect(findContestedGear(loose, exact, copies, counts(1))).toMatchObject({
      artifactIds: [],
      setSlotKeys: SLOTS.filter((slot) => slot !== "circlet").map(
        (slot) => `${TENACITY}:${slot}`
      ),
    });
    expect(
      findContestedGear(loose, exact, copies, counts(2)).setSlotKeys
    ).toEqual([]);
  });

  it("get free pieces of their set when the lineup needs theirs", () => {
    const shared = wornPieces("shared");
    const spare = [
      piece("spare-flower-high", TENACITY, "flower", 20),
      piece("spare-flower-low", TENACITY, "flower", 4),
      ...SLOTS.filter((slot) => slot !== "flower").map((slot) =>
        piece(`spare-${slot}`, TENACITY, slot, 0)
      ),
    ];
    const [loose, exact] = fillAnyPieces(
      [
        candidate("a", "diona", true, shared),
        candidate("b", "ineffa", false, shared),
      ],
      [...Object.values(shared), ...spare]
    );
    expect(exact.members[0].artifacts).toEqual(shared);
    const filled = loose.members[0].artifacts;
    // The lowest-level free piece of the set; any free one for the fifth.
    expect(filled.flower?.id).toBe("spare-flower-low");
    expect(filled.sands?.id).toBe("spare-sands");
    expect(filled.circlet?.id).toBe("spare-circlet");
    const ids = SLOTS.map((slot) => filled[slot]?.id);
    expect(ids.some((id) => id?.startsWith("shared"))).toBe(false);
  });
});
