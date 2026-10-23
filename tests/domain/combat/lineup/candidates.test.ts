import { describe, expect, it } from "vitest";
import {
  candidateArtifactIds,
  candidateSetSlotUses,
  candidateStrength,
  canFieldTogether,
  fillAnyPieces,
  findContestedGear,
  reservedSetSlotPieces,
} from "@/domain/combat/lineup/candidates";
import type { Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import type { LineupCandidate } from "@/domain/team/lineupSolverTypes";
import type { Calibration, Encounter } from "@/domain/team/lineupTypes";

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

describe("candidateStrength", () => {
  const encounter: Encounter = {
    id: "boss",
    mode: "stygian",
    bossId: 1,
    enemyLevel: 100,
    res: {},
    resPhases: [],
    targets: "",
    downtimeSeconds: 0,
    timeBarSeconds: 120,
  };
  const calibration: Calibration = {
    id: "clear",
    templateId: "team",
    encounterId: "boss",
    reference: { capturedAt: 0, slots: [], artifactsByChar: {} },
    measuredSeconds: 140,
    downtimeSeconds: null,
  };
  const on = (id: string, templateId: string, ratio: number) => ({
    ...candidate(id, "diluc", false),
    templateId,
    encounterId: "boss",
    ratio,
  });

  it("ranks a re-run found later by its margin, not its ratio", () => {
    const strength = candidateStrength([calibration], [encounter]);
    expect(strength(on("searched", "team", 1.4))).toBeCloseTo(1.2, 10);
    // A re-run arrives after the first comparisons: still a margin.
    expect(strength(on("re-run", "team", 1.3))).toBeCloseTo(
      (1.3 * 120) / 140,
      10
    );
  });

  it("falls back to the ratio where no clear gives a margin", () => {
    const strength = candidateStrength([calibration], [encounter]);
    expect(strength(on("uncalibrated", "other", 1.3))).toBe(1.3);
  });
});

describe("reservedSetSlotPieces", () => {
  // The other team's member takes any Tenacity pieces: it needs a flower,
  // plume, sands and goblet of the set.
  const other = candidate("other", "bennett", true);
  const spareFlower = piece("spare-flower", TENACITY, "flower");
  const artifacts = [...Object.values(wornPieces("other")), spareFlower];
  const counts = {
    [`${TENACITY}:flower`]: 2,
    [`${TENACITY}:plume`]: 1,
    [`${TENACITY}:sands`]: 1,
    [`${TENACITY}:goblet`]: 1,
    "gladiators_finale:circlet": 1,
  };

  it("leaves the last pieces of a slot to members that take any pieces", () => {
    // Two flowers for one taker: a re-run may still use one.
    expect(reservedSetSlotPieces(other, artifacts, counts).sort()).toEqual([
      "other-goblet",
      "other-plume",
      "other-sands",
    ]);
  });

  it("does not reserve slots the other team fills with exact pieces", () => {
    const exact = candidate("exact", "bennett", false);
    expect(
      reservedSetSlotPieces(
        exact,
        [...Object.values(wornPieces("exact")), spareFlower],
        counts
      )
    ).toEqual([]);
  });
});
