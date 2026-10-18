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
} from "@/domain/team/lineupSolverTypes";
import type { Calibration, Encounter } from "@/domain/team/lineupTypes";
import { LINEUP_BINDING_CHECKS } from "./constants";

export function candidateArtifactIds(candidate: LineupCandidate): string[] {
  return candidate.members.flatMap((member) =>
    Object.values(member.artifacts).flatMap((artifact) =>
      artifact ? [artifact.id] : []
    )
  );
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
 * used twice, and no weapon by more members than there are copies.
 */
export function canFieldTogether(
  candidates: readonly LineupCandidate[],
  weaponCopies: Readonly<Record<string, number>>
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
  return true;
}

export interface ContestedGear {
  charIds: string[];
  artifactIds: string[];
  /** Weapons the two use more often than they are owned. */
  weaponIds: string[];
}

/** What keeps two candidates from being fielded together. */
export function findContestedGear(
  candidate: LineupCandidate,
  other: LineupCandidate,
  weaponCopies: Readonly<Record<string, number>>
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

/**
 * Gear the lineup uses that a candidate for another of its encounters also
 * uses, in the lineup's member order.
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
  return [...contested.values()];
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
