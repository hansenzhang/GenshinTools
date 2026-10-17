import type { BuffActivationMap } from "@/domain/combat/damage/types";
import type { ArtifactSetConfig } from "@/domain/models";
import { artifactIdToHalfSetId } from "@/domain/reference/catalog";
import type {
  SetAssignment,
  SetAssignmentOutcome,
  SetChoiceRow,
  SetOutcomeBasis,
} from "@/domain/team/setConfigExplorerTypes";
import { setChoiceKey } from "./setChoices";

export interface RankedChoice {
  choice: ArtifactSetConfig | null;
  key: string;
  score: number;
  /** Current, teammate, locked and pinned choices survive trimming. */
  protected: boolean;
}

export interface MemberChoices {
  charId: string;
  choices: RankedChoice[];
}

export type OutcomeScore = (outcome: SetAssignmentOutcome) => number | null;

function productSize(members: readonly MemberChoices[]): number {
  return members.reduce((size, member) => size * member.choices.length, 1);
}

/**
 * Drop the weakest unprotected choices until the joint product fits the cap,
 * always trimming the member with the most unprotected choices first.
 */
export function trimChoicesToCap(
  members: readonly MemberChoices[],
  cap: number
): MemberChoices[] {
  const trimmed = members.map((member) => ({
    charId: member.charId,
    choices: [...member.choices].sort((a, b) => b.score - a.score),
  }));
  while (productSize(trimmed) > cap) {
    let target: MemberChoices | null = null;
    let targetCount = 0;
    for (const member of trimmed) {
      const count = member.choices.filter((choice) => !choice.protected).length;
      if (count > targetCount) {
        target = member;
        targetCount = count;
      }
    }
    if (!target) break;
    let dropIndex = target.choices.length - 1;
    while (target.choices[dropIndex].protected) dropIndex--;
    target.choices.splice(dropIndex, 1);
  }
  return trimmed;
}

export function enumerateJointAssignments(
  members: readonly MemberChoices[]
): SetAssignment[] {
  let assignments: SetAssignment[] = [{}];
  for (const member of members) {
    const next: SetAssignment[] = [];
    for (const partial of assignments)
      for (const { choice } of member.choices)
        next.push({ ...partial, [member.charId]: choice });
    assignments = next;
  }
  return members.length > 0 ? assignments : [];
}

export function countAssignmentChanges(
  a: SetAssignment,
  b: SetAssignment,
  charIds: readonly string[]
): number {
  return charIds.filter(
    (charId) =>
      setChoiceKey(a[charId] ?? null) !== setChoiceKey(b[charId] ?? null)
  ).length;
}

export function isWithinTie(
  damage: number,
  best: number,
  tiePercent: number
): boolean {
  return best > 0 && ((best - damage) / best) * 100 <= tiePercent;
}

/**
 * The highest-scoring outcome; among outcomes tied with it, the one that
 * changes the fewest members from the current sets.
 */
export function pickBestOutcome(
  outcomes: readonly SetAssignmentOutcome[],
  indices: readonly number[],
  score: OutcomeScore,
  current: SetAssignment,
  charIds: readonly string[],
  tiePercent: number
): number | null {
  let top = Number.NEGATIVE_INFINITY;
  for (const index of indices)
    top = Math.max(top, score(outcomes[index]) ?? top);
  if (!Number.isFinite(top)) return null;
  let best: number | null = null;
  let bestChanges = Number.POSITIVE_INFINITY;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const index of indices) {
    const value = score(outcomes[index]);
    if (value == null || !isWithinTie(value, top, tiePercent)) continue;
    const changes = countAssignmentChanges(
      outcomes[index].assignment,
      current,
      charIds
    );
    if (
      changes < bestChanges ||
      (changes === bestChanges && value > bestScore)
    ) {
      best = index;
      bestChanges = changes;
      bestScore = value;
    }
  }
  return best;
}

/** For each member and choice, the best-scoring outcome giving it that choice. */
export function bestOutcomePerChoice(
  outcomes: readonly SetAssignmentOutcome[],
  charIds: readonly string[],
  score: OutcomeScore
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>(
    charIds.map((charId) => [charId, new Map()])
  );
  outcomes.forEach((outcome, index) => {
    const value = score(outcome);
    if (value == null) return;
    for (const charId of charIds) {
      const byChoice = result.get(charId)!;
      const key = setChoiceKey(outcome.assignment[charId] ?? null);
      const previous = byChoice.get(key);
      if (previous == null || value > (score(outcomes[previous]) ?? 0))
        byChoice.set(key, index);
    }
  });
  return result;
}

function pinnedOutcomeIndices(
  perChoice: Map<string, Map<string, number>>,
  pinned: Readonly<Record<string, readonly ArtifactSetConfig[]>>
): number[] {
  return Object.entries(pinned).flatMap(([charId, choices]) =>
    choices.flatMap((choice) => {
      const index = perChoice.get(charId)?.get(setChoiceKey(choice));
      return index == null ? [] : [index];
    })
  );
}

function rankedChoiceIndices(
  outcomes: readonly SetAssignmentOutcome[],
  byChoice: Map<string, number>,
  score: OutcomeScore
): number[] {
  return [...byChoice.values()].sort(
    (a, b) => (score(outcomes[b]) ?? 0) - (score(outcomes[a]) ?? 0)
  );
}

/**
 * Outcomes worth re-scoring with generated artifacts: the best screened
 * assignments, each member's top choices, pinned choices and the current sets.
 */
export function selectWitnesses(input: {
  outcomes: readonly SetAssignmentOutcome[];
  charIds: readonly string[];
  score: OutcomeScore;
  topCount: number;
  perMember: number;
  pinned: Readonly<Record<string, readonly ArtifactSetConfig[]>>;
  currentIndex: number;
}): number[] {
  const { outcomes, charIds, score } = input;
  const perChoice = bestOutcomePerChoice(outcomes, charIds, score);
  const ranked = outcomes
    .map((_, index) => index)
    .filter((index) => score(outcomes[index]) != null)
    .sort((a, b) => (score(outcomes[b]) ?? 0) - (score(outcomes[a]) ?? 0));
  const selected = new Set<number>([input.currentIndex]);
  for (const index of ranked.slice(0, input.topCount)) selected.add(index);
  for (const charId of charIds)
    for (const index of rankedChoiceIndices(
      outcomes,
      perChoice.get(charId)!,
      score
    ).slice(0, input.perMember))
      selected.add(index);
  for (const index of pinnedOutcomeIndices(perChoice, input.pinned))
    selected.add(index);
  return [...selected];
}

/**
 * Assignments to optimize on the real inventory, in priority order:
 * the best; pinned choices; the best with each team-buff set of the best
 * moved to another member; each member's best different choice. The current
 * sets are excluded because they always run as the baseline.
 */
export function selectFinalists(input: {
  outcomes: readonly SetAssignmentOutcome[];
  charIds: readonly string[];
  score: OutcomeScore;
  bestIndex: number;
  currentIndex: number;
  teamBuffSetIds: ReadonlySet<string>;
  pinned: Readonly<Record<string, readonly ArtifactSetConfig[]>>;
  max: number;
}): number[] {
  const { outcomes, charIds, score, bestIndex } = input;
  const perChoice = bestOutcomePerChoice(outcomes, charIds, score);
  const best = outcomes[bestIndex].assignment;
  const ordered: number[] = [bestIndex];
  const pinned = pinnedOutcomeIndices(perChoice, input.pinned);
  ordered.push(...pinned);

  const byScore = outcomes
    .map((_, index) => index)
    .filter((index) => score(outcomes[index]) != null)
    .sort((a, b) => (score(outcomes[b]) ?? 0) - (score(outcomes[a]) ?? 0));
  for (const charId of charIds) {
    const choice = best[charId];
    if (choice?.type !== "4pc" || !input.teamBuffSetIds.has(choice.setId))
      continue;
    const moved = byScore.find((index) => {
      const other = outcomes[index].assignment;
      return (
        setChoiceKey(other[charId] ?? null) !== choice.setId &&
        charIds.some(
          (otherId) =>
            otherId !== charId &&
            setChoiceKey(other[otherId] ?? null) === choice.setId
        )
      );
    });
    if (moved != null) ordered.push(moved);
  }
  for (const charId of charIds) {
    const bestKey = setChoiceKey(best[charId] ?? null);
    const runnerUp = byScore.find(
      (index) =>
        setChoiceKey(outcomes[index].assignment[charId] ?? null) !== bestKey
    );
    if (runnerUp != null) ordered.push(runnerUp);
  }

  const result: number[] = [];
  for (const index of ordered) {
    if (index === input.currentIndex || result.includes(index)) continue;
    if (result.length >= input.max && !pinned.includes(index)) continue;
    result.push(index);
  }
  return result;
}

const BASIS_RANK: Record<SetOutcomeBasis, number> = {
  screen: 0,
  generated: 1,
  account: 2,
};

export function outcomeBasis(outcome: SetAssignmentOutcome): SetOutcomeBasis {
  if (outcome.account) return "account";
  if (outcome.generatedDamage != null) return "generated";
  return "screen";
}

/** Damage on the outcome's highest basis; null when that basis is unreachable. */
export function outcomeDamage(outcome: SetAssignmentOutcome): number | null {
  if (outcome.account) return outcome.account.damage;
  return outcome.generatedDamage ?? outcome.screenDamage;
}

function rowRank(outcome: SetAssignmentOutcome): [number, number] {
  const damage = outcomeDamage(outcome);
  // Reachable real-inventory results first, then unreachable ones, then estimates.
  const basis =
    BASIS_RANK[outcomeBasis(outcome)] * 2 + (damage == null ? 0 : 1);
  return [basis, damage ?? Number.NEGATIVE_INFINITY];
}

function compareRank(a: [number, number], b: [number, number]): number {
  return b[0] - a[0] || b[1] - a[1];
}

/** Per member, every choice seen with the best evaluated assignment for it. */
export function buildChoiceRows(
  outcomes: readonly SetAssignmentOutcome[],
  charIds: readonly string[],
  pinned: Readonly<Record<string, readonly ArtifactSetConfig[]>>
): Record<string, SetChoiceRow[]> {
  const rowsByChar: Record<string, SetChoiceRow[]> = {};
  for (const charId of charIds) {
    const pinnedKeys = new Set((pinned[charId] ?? []).map(setChoiceKey));
    const bestByKey = new Map<string, number>();
    outcomes.forEach((outcome, index) => {
      const key = setChoiceKey(outcome.assignment[charId] ?? null);
      const previous = bestByKey.get(key);
      if (
        previous == null ||
        compareRank(rowRank(outcome), rowRank(outcomes[previous])) < 0
      )
        bestByKey.set(key, index);
    });
    rowsByChar[charId] = [...bestByKey.entries()]
      .map(([key, outcomeIndex]) => ({
        charId,
        choice: outcomes[outcomeIndex].assignment[charId] ?? null,
        key,
        outcomeIndex,
        basis: outcomeBasis(outcomes[outcomeIndex]),
        pinned: pinnedKeys.has(key),
      }))
      .sort((a, b) =>
        compareRank(
          rowRank(outcomes[a.outcomeIndex]),
          rowRank(outcomes[b.outcomeIndex])
        )
      );
  }
  return rowsByChar;
}

/** Set-bonus identities a member provides with this choice, as "type:id". */
function setBuffSources(choice: ArtifactSetConfig | null): Set<string> {
  if (!choice) return new Set();
  if (choice.type === "2pc+2pc")
    return new Set(choice.halfSetIds.map((id) => `artifactHalfSet:${id}`));
  const halfSetId = artifactIdToHalfSetId[choice.setId];
  return new Set([
    `artifactSet:${choice.setId}`,
    ...(halfSetId ? [`artifactHalfSet:${halfSetId}`] : []),
  ]);
}

/**
 * User buff activations that stop applying when sets move: override keys
 * name the providing member (`provider\u0003type\u0000id…`), so a set bonus
 * moved to another member falls back to its default activation.
 */
export function findOrphanedSetOverrideKeys(
  userOverrides: Readonly<Record<string, BuffActivationMap>> | undefined,
  from: SetAssignment,
  to: SetAssignment
): string[] {
  const orphaned = new Set<string>();
  for (const activations of Object.values(userOverrides ?? {})) {
    for (const buffKey of Object.keys(activations)) {
      const [provider, identity] = buffKey.split("\u0003");
      if (!provider || !identity || !(provider in from)) continue;
      const [type, id] = identity.split("\u0000");
      const source = `${type}:${id}`;
      if (
        setBuffSources(from[provider] ?? null).has(source) &&
        !setBuffSources(to[provider] ?? null).has(source)
      )
        orphaned.add(buffKey);
    }
  }
  return [...orphaned];
}
