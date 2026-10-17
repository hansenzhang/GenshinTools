import { allSlots, type Slot } from "@/domain/enums";
import type { ArtifactData, ArtifactSetConfig } from "@/domain/models";
import { artifactHalfSetsById } from "@/domain/reference/catalog";
import type { SetAssignment } from "@/domain/team/setConfigExplorerTypes";

/** Piece count per set key and slot in an artifact pool. */
export type SetSlotCounts = ReadonlyMap<string, Readonly<Record<Slot, number>>>;

export function countSetSlots(pool: readonly ArtifactData[]): SetSlotCounts {
  const counts = new Map<string, Record<Slot, number>>();
  for (const artifact of pool) {
    if (artifact.rarity < 4) continue;
    let bySlot = counts.get(artifact.setKey);
    if (!bySlot) {
      bySlot = { flower: 0, plume: 0, sands: 0, goblet: 0, circlet: 0 };
      counts.set(artifact.setKey, bySlot);
    }
    bySlot[artifact.slotKey]++;
  }
  return counts;
}

function slotsWithPieces(counts: SetSlotCounts, setKey: string): Set<Slot> {
  const bySlot = counts.get(setKey);
  return new Set(bySlot ? allSlots.filter((slot) => bySlot[slot] > 0) : []);
}

/** Concrete sets of a two-piece group with pieces in at least two slots. */
export function ownedConcreteSetCount(
  halfSetId: string,
  counts: SetSlotCounts
): number {
  return (artifactHalfSetsById[halfSetId]?.setIds ?? []).filter(
    (setKey) => slotsWithPieces(counts, setKey).size >= 2
  ).length;
}

/**
 * Whether one member can wear the set config from this pool.
 * A 4pc needs pieces in four slots. A 2+2 needs two different concrete sets
 * that can fill two slots each without sharing one (Hall's condition).
 */
export function canWearSetConfig(
  choice: ArtifactSetConfig | null,
  counts: SetSlotCounts
): boolean {
  if (!choice) return true;
  if (choice.type === "4pc")
    return slotsWithPieces(counts, choice.setId).size >= 4;
  const [first, second] = choice.halfSetIds.map(
    (halfSetId) => artifactHalfSetsById[halfSetId]?.setIds ?? []
  );
  for (const firstKey of first) {
    const firstSlots = slotsWithPieces(counts, firstKey);
    if (firstSlots.size < 2) continue;
    for (const secondKey of second) {
      if (secondKey === firstKey) continue;
      const secondSlots = slotsWithPieces(counts, secondKey);
      if (secondSlots.size < 2) continue;
      if (new Set([...firstSlots, ...secondSlots]).size >= 4) return true;
    }
  }
  return false;
}

/**
 * Whether members sharing a 4pc set can all wear it from one pool:
 * k wearers need Σ over slots of min(pieces, k) ≥ 4k.
 */
export function isAssignmentJointlyFeasible(
  assignment: SetAssignment,
  counts: SetSlotCounts
): boolean {
  const wearers = new Map<string, number>();
  for (const choice of Object.values(assignment)) {
    if (choice?.type !== "4pc") continue;
    wearers.set(choice.setId, (wearers.get(choice.setId) ?? 0) + 1);
  }
  for (const [setId, k] of wearers) {
    if (k < 2) continue;
    const bySlot = counts.get(setId);
    if (!bySlot) return false;
    const capacity = allSlots.reduce(
      (sum, slot) => sum + Math.min(bySlot[slot], k),
      0
    );
    if (capacity < 4 * k) return false;
  }
  return true;
}
