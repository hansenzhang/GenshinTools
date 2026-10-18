/**
 * The most valuable pieces that form a set choice: four of the set plus the
 * best fifth for a 4pc, two each of two sets from the halves' groups for a
 * 2+2, the best per slot without a set. Shared by the optimizer's fill for
 * members whose stats don't matter and the lineup's account estimate.
 */

import { allSlots, type Slot } from "@/domain/enums";
import type { ArtifactData, ArtifactSetConfig } from "@/domain/models";
import { artifactHalfSetsById } from "@/domain/reference/catalog";

export type PieceSet = Record<Slot, ArtifactData>;

interface Valued {
  artifact: ArtifactData;
  value: number;
}

/** A member's best pieces per slot, overall and per set. */
export interface RankedPieces {
  best: Partial<Record<Slot, Valued>>;
  bySet: Record<Slot, Map<string, Valued>>;
}

export function rankPieces(
  pool: readonly ArtifactData[],
  value: (artifact: ArtifactData) => number,
  taken: ReadonlySet<string>
): RankedPieces {
  const ranked: RankedPieces = {
    best: {},
    bySet: Object.fromEntries(
      allSlots.map((slot) => [slot, new Map<string, Valued>()])
    ) as RankedPieces["bySet"],
  };
  for (const artifact of pool) {
    if (taken.has(artifact.id)) continue;
    const slot = artifact.slotKey;
    const entry = { artifact, value: value(artifact) };
    const best = ranked.best[slot];
    if (!best || entry.value > best.value) ranked.best[slot] = entry;
    const bySet = ranked.bySet[slot];
    const ofSet = bySet.get(artifact.setKey);
    if (!ofSet || entry.value > ofSet.value) bySet.set(artifact.setKey, entry);
  }
  return ranked;
}

/** Slot splits of a 2+2: two slots for each set, one free slot. */
const TWO_PLUS_TWO_SPLITS: { first: Slot[]; second: Slot[]; free: Slot }[] =
  allSlots.flatMap((free) => {
    const rest = allSlots.filter((slot) => slot !== free);
    return [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ].map(([a, b]) => ({
      first: [rest[a], rest[b]],
      second: rest.filter((_, index) => index !== a && index !== b),
      free,
    }));
  });

function sum(entries: (Valued | undefined)[]): number | null {
  let total = 0;
  for (const entry of entries) {
    if (!entry) return null;
    total += entry.value;
  }
  return total;
}

/**
 * The most valuable pieces that form the choice: four of the set and the best
 * fifth for a 4pc, two each of two sets in the halves' groups for a 2+2, the
 * best per slot without a set. Null when the pool cannot form it.
 */
export function pickForChoice(
  ranked: RankedPieces,
  choice: ArtifactSetConfig | null
): PieceSet | null {
  const { best, bySet } = ranked;
  let picks: Partial<Record<Slot, Valued>> | null = null;
  let top = Number.NEGATIVE_INFINITY;
  const consider = (candidate: Partial<Record<Slot, Valued>>) => {
    const total = sum(allSlots.map((slot) => candidate[slot]));
    if (total != null && total > top) {
      top = total;
      picks = candidate;
    }
  };
  if (!choice) consider(best);
  else if (choice.type === "4pc")
    for (const free of allSlots)
      consider(
        Object.fromEntries(
          allSlots.map((slot) => [
            slot,
            slot === free ? best[slot] : bySet[slot].get(choice.setId),
          ])
        )
      );
  else {
    const [firstSets, secondSets] = choice.halfSetIds.map(
      (halfSetId) => artifactHalfSetsById[halfSetId]?.setIds ?? []
    );
    for (const first of firstSets)
      for (const second of secondSets) {
        if (first === second) continue;
        for (const split of TWO_PLUS_TWO_SPLITS)
          consider({
            ...Object.fromEntries(
              split.first.map((slot) => [slot, bySet[slot].get(first)])
            ),
            ...Object.fromEntries(
              split.second.map((slot) => [slot, bySet[slot].get(second)])
            ),
            [split.free]: best[split.free],
          });
      }
  }
  const chosen = picks as Partial<Record<Slot, Valued>> | null;
  return chosen
    ? (Object.fromEntries(
        allSlots.map((slot) => [slot, chosen[slot]!.artifact])
      ) as PieceSet)
    : null;
}
