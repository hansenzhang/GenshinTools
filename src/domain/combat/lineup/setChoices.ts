import { TIER_LIST_4STAR_SUPPORT_ARTIFACT_SET_IDS } from "@/config/gameConstants";
import type { Element } from "@/domain/enums";
import type { ArtifactSetConfig } from "@/domain/models";
import {
  allHalfSetIds,
  artifactHalfSetsById,
  artifactIdToHalfSetId,
  artifactsById,
} from "@/domain/reference/catalog";
import type { SetAssignment } from "@/domain/team/setConfigExplorerTypes";
import { buildArtifactSetChoiceCandidates } from "../analyzer/weaponChoice";
import { SET_SCREEN_EXCLUDED_HALF_SET_IDS } from "./constants";

const ELEMENT_HALF_SET_PATTERN =
  /^(pyro|hydro|electro|cryo|anemo|geo|dendro)%-15$/;

/** Canonical key: set id, sorted two-piece groups joined by "+", or "none". */
export function setChoiceKey(choice: ArtifactSetConfig | null): string {
  if (!choice) return "none";
  if (choice.type === "4pc") return choice.setId;
  return [...choice.halfSetIds].sort().join("+");
}

export function assignmentKey(
  assignment: SetAssignment,
  charIds: readonly string[]
): string {
  return charIds
    .map((charId) => setChoiceKey(assignment[charId] ?? null))
    .join("|");
}

export function sameSetChoice(
  a: ArtifactSetConfig | null,
  b: ArtifactSetConfig | null
): boolean {
  return setChoiceKey(a) === setChoiceKey(b);
}

/** Five-star four-piece sets plus the four-star support sets. */
export function buildFourPieceChoices(): ArtifactSetConfig[] {
  const setIds = new Set([
    ...buildArtifactSetChoiceCandidates().flatMap(({ artifactSet }) =>
      artifactSet.type === "4pc" ? [artifactSet.setId] : []
    ),
    ...TIER_LIST_4STAR_SUPPORT_ARTIFACT_SET_IDS.filter(
      (setId) => artifactsById[setId]
    ),
  ]);
  return [...setIds].map((setId) => ({ type: "4pc", setId }));
}

export function countFiveStarSetsInHalfSet(halfSetId: string): number {
  return (artifactHalfSetsById[halfSetId]?.setIds ?? []).filter(
    (setId) => artifactsById[setId]?.rarity === 5
  ).length;
}

function isScreenedHalfSet(halfSetId: string, element: Element): boolean {
  if (SET_SCREEN_EXCLUDED_HALF_SET_IDS.has(halfSetId)) return false;
  const elementMatch = ELEMENT_HALF_SET_PATTERN.exec(halfSetId);
  return !elementMatch || elementMatch[1] === element.toLowerCase();
}

/**
 * Unordered 2+2 pairs of damage-relevant two-piece groups for one member.
 * Only groups with a five-star set are listed, since generated artifacts
 * for a four-star set would downgrade the whole build. A same-group pair
 * needs two different concrete sets.
 */
export function buildTwoPlusTwoChoices(
  element: Element,
  concreteSetCount: (halfSetId: string) => number = countFiveStarSetsInHalfSet
): ArtifactSetConfig[] {
  const halfSetIds = allHalfSetIds.filter(
    (halfSetId) =>
      isScreenedHalfSet(halfSetId, element) &&
      countFiveStarSetsInHalfSet(halfSetId) > 0
  );
  const choices: ArtifactSetConfig[] = [];
  for (let i = 0; i < halfSetIds.length; i++) {
    for (let j = i; j < halfSetIds.length; j++) {
      if (i === j && concreteSetCount(halfSetIds[i]) < 2) continue;
      choices.push({
        type: "2pc+2pc",
        halfSetIds: [halfSetIds[i], halfSetIds[j]],
      });
    }
  }
  return choices;
}

/** Whether the choice grants Energy Recharge through a set bonus. */
export function isErBearing(choice: ArtifactSetConfig | null): boolean {
  if (!choice) return false;
  if (choice.type === "4pc")
    return artifactIdToHalfSetId[choice.setId] === "er-20";
  return choice.halfSetIds.includes("er-20");
}
