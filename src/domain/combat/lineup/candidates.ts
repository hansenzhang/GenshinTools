import { allSlots, type Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import { artifactIdToHalfSetId } from "@/domain/reference/catalog";
import {
  calibratedMargin,
  calibrationTimes,
  findCalibration,
} from "@/domain/team/lineup";
import type {
  BindingItem,
  CalibratedCandidate,
  LineupCandidate,
  LineupGear,
  LineupMember,
} from "@/domain/team/lineupSolverTypes";
import type { Calibration, Encounter } from "@/domain/team/lineupTypes";
import { LINEUP_BINDING_CHECKS } from "./constants";

/** Pieces the candidate needs exactly; members that take any pieces of
 *  their set are left out. */
export function candidateArtifactIds(candidate: LineupCandidate): string[] {
  return candidate.members.flatMap((member) =>
    member.anyPieces
      ? []
      : Object.values(member.artifacts).flatMap((artifact) =>
          artifact ? [artifact.id] : []
        )
  );
}

export function setSlotKey(setKey: string, slot: Slot): string {
  return `${setKey}:${slot}`;
}

/** Owned pieces per set and slot. */
export function countSetSlotPieces(
  artifacts: readonly ArtifactData[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const artifact of artifacts) {
    const key = setSlotKey(artifact.setKey, artifact.slotKey);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Slots a member that takes any pieces has to fill from its set: four of a
 * 4pc set, two of each set of a 2+2, keyed by `setSlotKey`. Its fifth piece
 * can be anything.
 */
function anyPieceSlots(member: LineupMember): string[] {
  const { artifactSet } = member;
  if (!artifactSet) return [];
  const inSet = (setKey: string) =>
    artifactSet.type === "4pc"
      ? setKey === artifactSet.setId
      : artifactSet.halfSetIds.includes(artifactIdToHalfSetId[setKey] ?? "");
  const perSet = artifactSet.type === "4pc" ? 4 : 2;
  const counted: Record<string, number> = {};
  const keys: string[] = [];
  for (const slot of allSlots) {
    const setKey = member.artifacts[slot]?.setKey;
    if (!setKey || !inSet(setKey) || (counted[setKey] ?? 0) >= perSet) continue;
    counted[setKey] = (counted[setKey] ?? 0) + 1;
    keys.push(setSlotKey(setKey, slot));
  }
  return keys;
}

/** Set and slot keys the candidate's members that take any pieces need. */
export function anyPieceSetSlots(candidate: LineupCandidate): string[] {
  return [
    ...new Set(
      candidate.members.flatMap((member) =>
        member.anyPieces ? anyPieceSlots(member) : []
      )
    ),
  ];
}

/**
 * Pieces per set and slot the candidate takes from the account: its exact
 * pieces, plus what members that take any pieces need from their sets.
 */
export function candidateSetSlotUses(
  candidate: LineupCandidate
): Record<string, number> {
  const uses: Record<string, number> = {};
  for (const member of candidate.members) {
    const keys = member.anyPieces
      ? anyPieceSlots(member)
      : Object.values(member.artifacts).flatMap((artifact) =>
          artifact ? [setSlotKey(artifact.setKey, artifact.slotKey)] : []
        );
    for (const key of keys) uses[key] = (uses[key] ?? 0) + 1;
  }
  return uses;
}

/**
 * Pieces a re-run kept clear of `other` must leave alone besides `other`'s
 * own: every piece of a set and slot where, after `other`'s pieces, no more
 * are owned than its members that take any pieces still need there.
 */
export function reservedSetSlotPieces(
  other: LineupCandidate,
  artifacts: readonly ArtifactData[],
  setSlotCounts: Readonly<Record<string, number>>
): string[] {
  const demand: Record<string, number> = {};
  for (const member of other.members)
    if (member.anyPieces)
      for (const key of anyPieceSlots(member))
        demand[key] = (demand[key] ?? 0) + 1;
  const taken = new Set(candidateArtifactIds(other));
  const takenPerKey: Record<string, number> = {};
  for (const artifact of artifacts)
    if (taken.has(artifact.id)) {
      const key = setSlotKey(artifact.setKey, artifact.slotKey);
      takenPerKey[key] = (takenPerKey[key] ?? 0) + 1;
    }
  const full = new Set(
    Object.keys(demand).filter(
      (key) =>
        (setSlotCounts[key] ?? 0) - (takenPerKey[key] ?? 0) - demand[key] < 1
    )
  );
  return artifacts.flatMap((artifact) =>
    !taken.has(artifact.id) &&
    full.has(setSlotKey(artifact.setKey, artifact.slotKey))
      ? [artifact.id]
      : []
  );
}

/**
 * The lineup with concrete pieces for members that take any pieces of their
 * set: the ones they were scored with while nobody else in the lineup needs
 * them, otherwise the lowest-level free piece of the same set and slot.
 */
export function fillAnyPieces<T extends LineupCandidate>(
  lineup: readonly T[],
  artifacts: readonly ArtifactData[]
): T[] {
  const used = new Set(lineup.flatMap(candidateArtifactIds));
  const filled = lineup.map((candidate) => ({
    ...candidate,
    members: candidate.members.map((member) => ({
      ...member,
      artifacts: { ...member.artifacts },
    })),
  }));
  const loose = filled.flatMap((candidate) =>
    candidate.members.filter((member) => member.anyPieces)
  );
  const clashing: { member: LineupMember; slot: Slot }[] = [];
  for (const member of loose)
    for (const slot of allSlots) {
      const artifact = member.artifacts[slot];
      if (!artifact) continue;
      if (used.has(artifact.id)) clashing.push({ member, slot });
      else used.add(artifact.id);
    }
  const spare = [...artifacts].sort((a, b) => a.level - b.level);
  for (const { member, slot } of clashing) {
    const setKey = member.artifacts[slot]?.setKey;
    const onSet = anyPieceSlots(member).includes(
      setSlotKey(setKey ?? "", slot)
    );
    const free = spare.find(
      (artifact) =>
        artifact.slotKey === slot &&
        !used.has(artifact.id) &&
        (!onSet || artifact.setKey === setKey)
    );
    if (!free) continue;
    used.add(free.id);
    member.artifacts[slot] = free;
  }
  return filled;
}

/** Members using each weapon. */
export function candidateWeaponUses(
  candidate: LineupCandidate
): Record<string, number> {
  const uses: Record<string, number> = {};
  for (const { weaponId } of candidate.members)
    uses[weaponId] = (uses[weaponId] ?? 0) + 1;
  return uses;
}

/**
 * Whether the candidates can be fielded at once: no character or piece is
 * used twice, no weapon by more members than there are copies, and, with
 * `setSlotCounts`, no set and slot by more members than there are pieces.
 */
export function canFieldTogether(
  candidates: readonly LineupCandidate[],
  weaponCopies: Readonly<Record<string, number>>,
  setSlotCounts?: Readonly<Record<string, number>>
): boolean {
  const charIds = new Set<string>();
  const artifactIds = new Set<string>();
  const weaponUses: Record<string, number> = {};
  for (const candidate of candidates) {
    for (const member of candidate.members) {
      if (charIds.has(member.charId)) return false;
      charIds.add(member.charId);
      weaponUses[member.weaponId] = (weaponUses[member.weaponId] ?? 0) + 1;
      if (weaponUses[member.weaponId] > (weaponCopies[member.weaponId] ?? 0))
        return false;
    }
    for (const id of candidateArtifactIds(candidate)) {
      if (artifactIds.has(id)) return false;
      artifactIds.add(id);
    }
  }
  return (
    !setSlotCounts || overusedSetSlots(candidates, setSlotCounts).length === 0
  );
}

/** Set and slot keys the candidates together take more pieces of than are
 *  owned. */
export function overusedSetSlots(
  candidates: readonly LineupCandidate[],
  setSlotCounts: Readonly<Record<string, number>>
): string[] {
  const uses: Record<string, number> = {};
  for (const candidate of candidates)
    for (const [key, count] of Object.entries(candidateSetSlotUses(candidate)))
      uses[key] = (uses[key] ?? 0) + count;
  return Object.keys(uses).filter(
    (key) => uses[key] > (setSlotCounts[key] ?? 0)
  );
}

export interface ContestedGear {
  charIds: string[];
  artifactIds: string[];
  /** Weapons the two use more often than they are owned. */
  weaponIds: string[];
  /** Set and slot keys the two take more pieces of than are owned, as when
   *  a member that takes any pieces needs a slot the other's pieces fill;
   *  empty without `setSlotCounts`. */
  setSlotKeys: string[];
}

/** What keeps two candidates from being fielded together. */
export function findContestedGear(
  candidate: LineupCandidate,
  other: LineupCandidate,
  weaponCopies: Readonly<Record<string, number>>,
  setSlotCounts?: Readonly<Record<string, number>>
): ContestedGear {
  const otherCharIds = new Set(other.members.map((member) => member.charId));
  const otherArtifactIds = new Set(candidateArtifactIds(other));
  const uses = candidateWeaponUses(candidate);
  const otherUses = candidateWeaponUses(other);
  return {
    charIds: candidate.members.flatMap((member) =>
      otherCharIds.has(member.charId) ? [member.charId] : []
    ),
    artifactIds: candidateArtifactIds(candidate).filter((id) =>
      otherArtifactIds.has(id)
    ),
    weaponIds: Object.keys(uses).filter(
      (weaponId) =>
        uses[weaponId] + (otherUses[weaponId] ?? 0) >
        (weaponCopies[weaponId] ?? 0)
    ),
    setSlotKeys: setSlotCounts
      ? overusedSetSlots([candidate, other], setSlotCounts)
      : [],
  };
}

/**
 * Candidates with their predicted clear against the current recorded clears
 * and bars; candidates whose clear gives no margin are left out.
 */
export function calibrateCandidates(
  candidates: readonly LineupCandidate[],
  calibrations: readonly Calibration[],
  encounters: readonly Encounter[]
): CalibratedCandidate[] {
  const encountersById = new Map(
    encounters.map((encounter) => [encounter.id, encounter])
  );
  return candidates.flatMap((candidate) => {
    const encounter = encountersById.get(candidate.encounterId);
    const calibration =
      encounter &&
      findCalibration(calibrations, candidate.templateId, encounter.id);
    if (!calibration) return [];
    const readout = calibratedMargin(candidate.ratio, calibration, encounter);
    const times = calibrationTimes(calibration, encounter);
    if (readout.kind !== "margin" || !times) return [];
    return [
      {
        ...candidate,
        margin: readout.margin,
        activeSeconds: (times.measured - times.downtime) / candidate.ratio,
        downtimeSeconds: times.downtime,
        barSeconds: times.bar,
      },
    ];
  });
}

/**
 * How strong a candidate is, comparable across encounters: its margin where
 * the clears give one, its damage ratio otherwise. Candidates found after
 * the first call (re-runs) get their margin when first asked, so they rank
 * on the same scale as the ones they compete with.
 */
export function candidateStrength(
  calibrations: readonly Calibration[],
  encounters: readonly Encounter[]
): (candidate: LineupCandidate) => number {
  const margins = new Map<string, number | null>();
  return (candidate) => {
    if (!margins.has(candidate.id))
      margins.set(
        candidate.id,
        calibrateCandidates([candidate], calibrations, encounters)[0]?.margin ??
          null
      );
    return margins.get(candidate.id) ?? candidate.ratio;
  };
}

/**
 * Whether a margin counts as tied with a better one: within `tiePercent` of
 * it, and on the same side of 1, since clearing the bar is never a tie with
 * missing it.
 */
export function marginsTied(
  value: number,
  best: number,
  tiePercent: number
): boolean {
  return value >= best * (1 - tiePercent / 100) && (best < 1 || value >= 1);
}

/** The lowest margin still tied with `best`. */
export function tiedMarginFloor(best: number, tiePercent: number): number {
  const floor = best * (1 - tiePercent / 100);
  return best >= 1 ? Math.max(1, floor) : floor;
}

function gearOf(candidate: LineupCandidate): LineupGear[] {
  return [
    ...candidate.members.flatMap((member): LineupGear[] => [
      { kind: "character", id: member.charId },
      { kind: "weapon", id: member.weaponId },
    ]),
    ...candidateArtifactIds(candidate).map(
      (id): LineupGear => ({ kind: "artifact", id })
    ),
  ];
}

const gearKey = (gear: LineupGear) => `${gear.kind}:${gear.id}`;

const GEAR_ORDER: Record<LineupGear["kind"], number> = {
  character: 0,
  weapon: 1,
  artifact: 2,
};

/**
 * Gear the lineup uses that a candidate for another of its encounters also
 * uses: characters, then weapons, then pieces.
 */
export function contestedGear(
  lineup: readonly LineupCandidate[],
  candidates: readonly LineupCandidate[]
): LineupGear[] {
  const encounterIds = new Set(lineup.map((c) => c.encounterId));
  const contested = new Map<string, LineupGear>();
  for (const chosen of lineup) {
    const elsewhere = new Set(
      candidates
        .filter(
          (candidate) =>
            candidate.encounterId !== chosen.encounterId &&
            encounterIds.has(candidate.encounterId)
        )
        .flatMap((candidate) => gearOf(candidate).map(gearKey))
    );
    for (const gear of gearOf(chosen))
      if (elsewhere.has(gearKey(gear))) contested.set(gearKey(gear), gear);
  }
  return [...contested.values()].sort(
    (a, b) => GEAR_ORDER[a.kind] - GEAR_ORDER[b.kind]
  );
}

/**
 * The candidates and copies left without some gear: candidates using a
 * removed character or piece drop out; a removed weapon loses one copy.
 */
export function withoutGear<T extends LineupCandidate>(
  candidates: readonly T[],
  weaponCopies: Readonly<Record<string, number>>,
  gear: LineupGear
): { candidates: T[]; weaponCopies: Record<string, number> } {
  if (gear.kind === "weapon")
    return {
      candidates: [...candidates],
      weaponCopies: {
        ...weaponCopies,
        [gear.id]: Math.max(0, (weaponCopies[gear.id] ?? 0) - 1),
      },
    };
  return {
    candidates: candidates.filter((candidate) =>
      gear.kind === "character"
        ? !candidate.members.some((member) => member.charId === gear.id)
        : !candidateArtifactIds(candidate).includes(gear.id)
    ),
    weaponCopies: { ...weaponCopies },
  };
}

/**
 * The lineup's contested gear with the best margin left after losing each,
 * most costly first. Gear whose loss costs nothing is left out.
 * `solve` returns the best margin over the remaining candidates, or null
 * when no lineup is left.
 */
export function findBindingItems<T extends LineupCandidate>(
  lineup: readonly T[],
  candidates: readonly T[],
  weaponCopies: Readonly<Record<string, number>>,
  margin: number,
  solve: (
    candidates: readonly T[],
    weaponCopies: Readonly<Record<string, number>>
  ) => number | null
): BindingItem[] {
  return contestedGear(lineup, candidates)
    .slice(0, LINEUP_BINDING_CHECKS)
    .flatMap((gear) => {
      const left = withoutGear(candidates, weaponCopies, gear);
      const marginWithout = solve(left.candidates, left.weaponCopies);
      return marginWithout == null || marginWithout < margin - 1e-9
        ? [{ ...gear, marginWithout }]
        : [];
    })
    .sort(
      (a, b) =>
        (a.marginWithout ?? Number.NEGATIVE_INFINITY) -
        (b.marginWithout ?? Number.NEGATIVE_INFINITY)
    );
}
