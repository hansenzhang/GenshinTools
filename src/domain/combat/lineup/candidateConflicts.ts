import type { LineupCandidate } from "@/domain/team/lineupSolverTypes";

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
