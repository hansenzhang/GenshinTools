/**
 * Screening stages of the team set explorer (docs/design/lineup-solver.md, P1).
 *
 * A. Personal screen: with fixed baseline sheets, score every set choice for
 *    each member while teammates keep their current sets.
 * B. Joint screen: score every combination of the members' shortlists.
 * C. Generated re-score: fit generated artifacts to the best assignments and
 *    each member's best choices, then score them again.
 *
 * With account pools, A also keeps each member's best choices on its own
 * pieces, and C estimates every re-scored assignment on the account's pieces
 * (`estimateOnAccount`), since generated artifacts rate every set as if its
 * pieces were ideal.
 *
 * Every displayed number uses the display context and buff defaults rebuilt
 * for that assignment; searches use the optimize context.
 */

import { TIER_LIST_SUPPORT_ARTIFACT_SETS } from "@/config/gameConstants";
import { AVG_SUBSTAT_ROLL } from "@/domain/build/artifact/scoring/constants";
import type { Element, Slot } from "@/domain/enums";
import type { ArtifactData, ArtifactSetConfig } from "@/domain/models";
import { artifactsById } from "@/domain/reference/catalog";
import type {
  SetAssignment,
  SetAssignmentOutcome,
  SetConfigExplorerStage,
} from "@/domain/team/setConfigExplorerTypes";
import {
  deriveSetKeysFromConfigs,
  detectEquippedSets,
} from "@/domain/team/teamConfigUtils";
import { buildBuffOverrides } from "../damage/core/comboBuffOverrides";
import { StatSheet } from "../damage/core/statSheet";
import { TeamBuild } from "../damage/core/teamBuild";
import type {
  BuffActivationMap,
  CalcContext,
  ComboFormula,
  ExtraBuff,
  OptionMap,
  SetUptimeSettings,
  TeamSlotConfig,
} from "../damage/types";
import { runGenerator } from "../generator/generator";
import {
  type PieceSet,
  pickForChoice,
  rankPieces,
} from "../optimizer/setShapePicks";
import {
  memberStatWeights,
  pieceValue,
  type StatWeights,
  statSensitivity,
} from "./accountEstimate";
import {
  SET_ACCOUNT_ESTIMATE_PASSES,
  SET_ACCOUNT_REQUIREMENT_RETRIES,
  SET_GENERATED_REFINE_COUNT,
  SET_JOINT_ASSIGNMENT_CAP,
  SET_NO_EFFECT_RELATIVE,
  SET_SCREEN_TOP_ACCOUNT,
  SET_SCREEN_TOP_FOUR_PIECE,
  SET_SCREEN_TOP_TWO_PLUS_TWO,
  SET_WITNESS_CHOICES_PER_MEMBER,
} from "./constants";
import {
  enumerateJointAssignments,
  type MemberChoices,
  type RankedChoice,
  selectWitnesses,
  trimChoicesToCap,
} from "./setAssignments";
import {
  assignmentKey,
  buildFourPieceChoices,
  buildTwoPlusTwoChoices,
  isErBearing,
  setChoiceKey,
} from "./setChoices";

export interface SetRequirement {
  minEr: number;
  minCr: number;
}

export interface SetScreenInput {
  /** Members with their current set goals. */
  configs: TeamSlotConfig[];
  /** Active combo lines only (count > 0, formula exists). */
  combo: ComboFormula;
  userBuffOverrides?: Record<string, BuffActivationMap>;
  setUptimes?: SetUptimeSettings;
  combatOptions: OptionMap;
  enemyAura?: Element;
  extraBuffs?: ExtraBuff[];
  optimizeContext: CalcContext;
  displayContext: CalcContext;
  carryCharId: string;
  requirements: Record<string, SetRequirement>;
  elements: Record<string, Element>;
  lockedCharIds: ReadonlySet<string>;
  pinned: Readonly<Record<string, readonly ArtifactSetConfig[]>>;
  /** Sheets kept as they are in every stage (members locked to saved pieces). */
  fixedSheets?: Record<string, StatSheet>;
  /** Whether a member could wear the choice from the account's pieces. */
  canWear?: (charId: string, choice: ArtifactSetConfig | null) => boolean;
  /** Whether members sharing sets could all wear them at once. */
  isJointlyFeasible?: (assignment: SetAssignment) => boolean;
  /** Each member's account pieces; with them, assignments are also
   *  estimated on the account. */
  pools?: Readonly<Record<string, readonly ArtifactData[]>>;
}

export interface SetScreenOutput {
  charIds: string[];
  outcomes: SetAssignmentOutcome[];
  currentIndex: number;
  evaluated: number;
  skipped: number;
}

export type SetScreenProgress = (
  stage: SetConfigExplorerStage,
  done: number,
  total: number
) => void;

function applyAssignment(
  configs: readonly TeamSlotConfig[],
  assignment: SetAssignment
): TeamSlotConfig[] {
  return configs.map((config) => ({
    ...config,
    artifactSet:
      config.charId in assignment
        ? (assignment[config.charId] ?? null)
        : config.artifactSet,
  }));
}

export function makeAssignmentTeam(
  input: SetScreenInput,
  assignment: SetAssignment
): TeamBuild {
  return new TeamBuild(
    applyAssignment(input.configs, assignment),
    input.combatOptions,
    input.enemyAura,
    input.extraBuffs,
    undefined,
    input.displayContext
  );
}

/** Display damage of an assignment on given sheets; null if it cannot be built. */
export function evaluateAssignment(
  input: SetScreenInput,
  assignment: SetAssignment,
  sheets: Record<string, StatSheet>
): number | null {
  try {
    const team = makeAssignmentTeam(input, assignment);
    const overrides = buildBuffOverrides(
      input.combo.lines,
      team,
      sheets,
      input.displayContext,
      input.userBuffOverrides,
      input.setUptimes
    );
    const damage = team.getComboDamageResult(
      input.combo,
      sheets,
      input.displayContext,
      overrides
    ).totalDamage;
    return Number.isFinite(damage) ? damage : null;
  } catch {
    return null;
  }
}

/** Members whose stats on these sheets miss their ER requirement. */
export function findErShortMembers(
  input: SetScreenInput,
  assignment: SetAssignment,
  sheets: Record<string, StatSheet>
): string[] {
  const team = makeAssignmentTeam(input, assignment);
  return input.configs.flatMap((config) => {
    const minEr = input.requirements[config.charId]?.minEr ?? 0;
    if (minEr <= 0) return [];
    const stats = team.getTeamStats(
      sheets,
      config.charId,
      input.displayContext
    )[config.charId];
    const er = stats?.get("er", null) ?? 0;
    return er + 1e-6 < minEr ? [config.charId] : [];
  });
}

/** Requirement stats each member misses on these sheets, by member. */
function unmetStats(
  input: SetScreenInput,
  assignment: SetAssignment,
  sheets: Record<string, StatSheet>
): Record<string, ("er" | "cr")[]> {
  const team = makeAssignmentTeam(input, assignment);
  const unmet: Record<string, ("er" | "cr")[]> = {};
  for (const { charId } of input.configs) {
    const requirement = input.requirements[charId];
    if (!requirement?.minEr && !requirement?.minCr) continue;
    const stats = team.getTeamStats(sheets, charId, input.displayContext)[
      charId
    ];
    const short = (["er", "cr"] as const).filter(
      (stat) =>
        (stats?.get(stat, null) ?? 0) + 1e-6 <
        (stat === "er" ? requirement.minEr : requirement.minCr)
    );
    if (short.length > 0) unmet[charId] = short;
  }
  return unmet;
}

/** Members whose stats on these sheets miss their ER or CR requirement. */
export function findUnmetMembers(
  input: SetScreenInput,
  assignment: SetAssignment,
  sheets: Record<string, StatSheet>
): string[] {
  return Object.keys(unmetStats(input, assignment, sheets));
}

function pieceSheet(pieces: PieceSet): StatSheet {
  return StatSheet.fromArtifacts(Object.values(pieces));
}

/** Sets the pieces form; unknown set keys count as no set. */
export function formedSet(
  pieces: Partial<Record<Slot, ArtifactData | null>>
): ArtifactSetConfig | null {
  return detectEquippedSets(
    Object.values(pieces).filter(
      (artifact) => !!artifact && !!artifactsById[artifact.setKey]
    )
  );
}

/** Damage of the team with the assignment's buff defaults held, for
 *  marginals. Null when the assignment cannot be built. */
export function heldEvaluator(
  input: SetScreenInput,
  assignment: SetAssignment,
  sheets: Record<string, StatSheet>
): ((sheets: Record<string, StatSheet>) => number) | null {
  try {
    const team = makeAssignmentTeam(input, assignment);
    const overrides = buildBuffOverrides(
      input.combo.lines,
      team,
      sheets,
      input.displayContext,
      input.userBuffOverrides,
      input.setUptimes
    );
    return (next) =>
      team.getComboDamageResult(
        input.combo,
        next,
        input.displayContext,
        overrides
      ).totalDamage;
  } catch {
    return null;
  }
}

/** Every member's best pieces for its choice, the members whose pieces
 *  matter most first; no piece twice. Null when one cannot form its sets. */
function pickTeamPieces(
  pools: Readonly<Record<string, readonly ArtifactData[]>>,
  assignment: SetAssignment,
  weights: Record<string, StatWeights>
): Record<string, PieceSet> | null {
  const order = Object.keys(weights).sort(
    (a, b) => statSensitivity(weights[b]) - statSensitivity(weights[a])
  );
  const taken = new Set<string>();
  const picks: Record<string, PieceSet> = {};
  for (const charId of order) {
    const ranked = rankPieces(
      pools[charId] ?? [],
      (artifact) => pieceValue(artifact, weights[charId]),
      taken
    );
    const chosen = pickForChoice(ranked, assignment[charId] ?? null);
    if (!chosen) return null;
    picks[charId] = chosen;
    for (const artifact of Object.values(chosen)) taken.add(artifact.id);
  }
  return picks;
}

/**
 * Team damage with each member on the account's best pieces for its set
 * choice and the sets those pieces form. Pieces are valued by marginal damage
 * at `operatingSheets` (generated artifacts for this assignment), then again
 * at the pieces first picked. A member short of ER or CR re-picks with that
 * stat valued higher. Null without pools, or when the account cannot form
 * the sets or meet the requirements.
 */
export function estimateOnAccount(
  input: SetScreenInput,
  assignment: SetAssignment,
  operatingSheets: Record<string, StatSheet>
): number | null {
  const { pools } = input;
  if (!pools) return null;
  const evalFn = heldEvaluator(input, assignment, operatingSheets);
  if (!evalFn) return null;
  const charIds = input.configs
    .map((config) => config.charId)
    .filter((charId) => !input.fixedSheets?.[charId]);
  const boosts: Record<string, StatWeights> = {};
  let sheets = operatingSheets;
  let formed = assignment;
  const passes = SET_ACCOUNT_ESTIMATE_PASSES + SET_ACCOUNT_REQUIREMENT_RETRIES;
  for (let pass = 0; pass < passes; pass++) {
    const weights: Record<string, StatWeights> = {};
    for (const charId of charIds)
      weights[charId] = {
        ...memberStatWeights(evalFn, sheets, charId),
        ...boosts[charId],
      };
    const picks = pickTeamPieces(pools, assignment, weights);
    if (!picks) return null;
    sheets = { ...operatingSheets };
    formed = { ...assignment };
    for (const [charId, pieces] of Object.entries(picks)) {
      sheets[charId] = pieceSheet(pieces);
      formed[charId] = formedSet(pieces);
    }
    if (pass + 1 < SET_ACCOUNT_ESTIMATE_PASSES) continue;
    const unmet = unmetStats(input, formed, sheets);
    if (Object.keys(unmet).length === 0)
      return evaluateAssignment(input, formed, sheets);
    // One roll of the short stat is worth all of the member's other rolls,
    // then twice that on each retry.
    for (const [charId, stats] of Object.entries(unmet)) {
      const sensitivity = statSensitivity(weights[charId] ?? {});
      for (const stat of stats) {
        const previous = boosts[charId]?.[stat];
        boosts[charId] = {
          ...boosts[charId],
          [stat]: previous
            ? previous * 2
            : (sensitivity || 1) / AVG_SUBSTAT_ROLL[stat],
        };
      }
    }
  }
  return null;
}

/**
 * Members whose pieces don't meaningfully matter: without any of their own
 * artifact stats, team damage drops by less than `tolerancePercent`, and
 * their ER/CR requirement still holds. Only their set counts, so any pieces
 * that form it serve.
 */
export function findPieceInsensitiveMembers(
  input: SetScreenInput,
  assignment: SetAssignment,
  sheets: Record<string, StatSheet>,
  tolerancePercent: number
): string[] {
  const evalFn = heldEvaluator(input, assignment, sheets);
  const full = evalFn?.(sheets) ?? 0;
  if (!evalFn || full <= 0) return [];
  return input.configs.flatMap(({ charId }) => {
    const emptied = { ...sheets, [charId]: new StatSheet([]) };
    const kept = evalFn(emptied) >= full * (1 - tolerancePercent / 100);
    return kept && !(charId in unmetStats(input, assignment, emptied))
      ? [charId]
      : [];
  });
}

/**
 * One member's set choices on its own account pieces, teammates on the given
 * sheets, best first. Pieces are valued once, at those sheets.
 */
function rankChoicesOnAccount(
  input: SetScreenInput,
  charId: string,
  current: SetAssignment,
  sheets: Record<string, StatSheet>,
  choices: readonly ArtifactSetConfig[]
): { choice: ArtifactSetConfig; damage: number }[] {
  const pool = input.pools?.[charId];
  const evalFn = pool && heldEvaluator(input, current, sheets);
  if (!pool || !evalFn) return [];
  const weights = memberStatWeights(evalFn, sheets, charId);
  const ranked = rankPieces(
    pool,
    (artifact) => pieceValue(artifact, weights),
    new Set()
  );
  return choices
    .flatMap((choice) => {
      const pieces = pickForChoice(ranked, choice);
      if (!pieces) return [];
      const damage = evaluateAssignment(
        input,
        { ...current, [charId]: formedSet(pieces) },
        { ...sheets, [charId]: pieceSheet(pieces) }
      );
      return damage == null ? [] : [{ choice, damage }];
    })
    .sort((a, b) => b.damage - a.damage);
}

/** Generated artifacts fitted to the assignment, with fixed sheets kept. */
export async function generateAssignmentSheets(
  input: SetScreenInput,
  assignment: SetAssignment
): Promise<Record<string, StatSheet> | null> {
  const configs = applyAssignment(input.configs, assignment);
  const team = new TeamBuild(
    configs,
    input.combatOptions,
    input.enemyAura,
    input.extraBuffs,
    undefined,
    input.optimizeContext
  );
  let sheets: Record<string, StatSheet> | null = null;
  try {
    for await (const update of runGenerator({
      teamBuild: team,
      carryCharId: input.carryCharId,
      combo: input.combo,
      calcContext: input.optimizeContext,
      perChar: input.requirements,
      setKeysByChar: deriveSetKeysFromConfigs(configs),
    }))
      if (update.done) sheets = update.sheetsByChar;
  } catch {
    return null;
  }
  return sheets ? { ...sheets, ...input.fixedSheets } : null;
}

function currentAssignment(input: SetScreenInput): SetAssignment {
  return Object.fromEntries(
    input.configs.map((config) => [config.charId, config.artifactSet ?? null])
  );
}

/** A member's shortlist, and its best choices on its own account pieces. */
function shortlistMember(
  input: SetScreenInput,
  charId: string,
  current: SetAssignment,
  sheets: Record<string, StatSheet>,
  currentDamage: number,
  count: () => void
): { member: MemberChoices; accountPicks: ArtifactSetConfig[] } {
  const canWear = (choice: ArtifactSetConfig | null) =>
    input.canWear?.(charId, choice) ?? true;
  const ranked = new Map<string, RankedChoice>();
  const add = (
    choice: ArtifactSetConfig | null,
    score: number,
    isProtected: boolean
  ) => {
    const key = setChoiceKey(choice);
    const existing = ranked.get(key);
    ranked.set(key, {
      choice,
      key,
      score: Math.max(score, existing?.score ?? Number.NEGATIVE_INFINITY),
      protected: isProtected || (existing?.protected ?? false),
    });
  };
  const ownChoice = current[charId] ?? null;
  add(ownChoice, currentDamage, true);
  const shortlist = (accountPicks: ArtifactSetConfig[] = []) => ({
    member: { charId, choices: [...ranked.values()] },
    accountPicks,
  });
  if (input.lockedCharIds.has(charId)) return shortlist();

  const scored = (choices: ArtifactSetConfig[]) =>
    choices
      .filter(canWear)
      .flatMap((choice) => {
        count();
        const damage = evaluateAssignment(
          input,
          { ...current, [charId]: choice },
          sheets
        );
        return damage == null ? [] : [{ choice, damage }];
      })
      .sort((a, b) => b.damage - a.damage);
  const fourPiece = scored(buildFourPieceChoices());
  const twoPlusTwo = scored(buildTwoPlusTwoChoices(input.elements[charId]));
  const all = [...fourPiece, ...twoPlusTwo];
  const noEffect = all.every(
    ({ damage }) =>
      Math.abs(damage - currentDamage) <=
      SET_NO_EFFECT_RELATIVE * Math.abs(currentDamage)
  );
  const damageOf = (choice: ArtifactSetConfig | null) =>
    all.find((entry) => setChoiceKey(entry.choice) === setChoiceKey(choice))
      ?.damage ?? currentDamage;

  for (const choice of input.pinned[charId] ?? [])
    add(choice, damageOf(choice), true);
  // A support whose set changes nothing keeps it rather than churning.
  if (noEffect) return shortlist();

  for (const config of input.configs) {
    const teammateChoice = config.artifactSet ?? null;
    if (config.charId !== charId && teammateChoice && canWear(teammateChoice))
      add(teammateChoice, damageOf(teammateChoice), true);
  }
  for (const { choice, damage } of fourPiece.slice(
    0,
    SET_SCREEN_TOP_FOUR_PIECE
  ))
    add(choice, damage, false);
  for (const { choice, damage } of twoPlusTwo.slice(
    0,
    SET_SCREEN_TOP_TWO_PLUS_TWO
  ))
    add(choice, damage, false);
  if ((input.requirements[charId]?.minEr ?? 0) > 1) {
    const erChoice = all.find(({ choice }) => isErBearing(choice));
    if (erChoice) add(erChoice.choice, erChoice.damage, true);
  }
  const accountPicks = rankChoicesOnAccount(
    input,
    charId,
    current,
    sheets,
    all.map(({ choice }) => choice)
  )
    .slice(0, SET_SCREEN_TOP_ACCOUNT)
    .map(({ choice }) => choice);
  for (const choice of accountPicks) add(choice, damageOf(choice), true);
  return shortlist(accountPicks);
}

/** Stages A–C. Returns null when even the current sets cannot be scored. */
export async function runSetConfigScreen(
  input: SetScreenInput,
  report: SetScreenProgress
): Promise<SetScreenOutput | null> {
  const charIds = input.configs.map((config) => config.charId);
  const current = currentAssignment(input);
  const baseline = await generateAssignmentSheets(input, current);
  if (!baseline) return null;
  const currentDamage = evaluateAssignment(input, current, baseline);
  if (currentDamage == null) return null;

  let evaluated = 0;
  let skipped = 0;
  const shortlists: MemberChoices[] = [];
  // Each member's best choices on its own pieces get a re-score like pinned
  // ones, even when ideal pieces rate them low.
  const witnessed: Record<string, readonly ArtifactSetConfig[]> = {
    ...input.pinned,
  };
  for (const [index, charId] of charIds.entries()) {
    const { member, accountPicks } = shortlistMember(
      input,
      charId,
      current,
      baseline,
      currentDamage,
      () => {
        evaluated++;
      }
    );
    shortlists.push(member);
    witnessed[charId] = [...(witnessed[charId] ?? []), ...accountPicks];
    report("screen", index + 1, charIds.length);
  }

  const outcomes: SetAssignmentOutcome[] = [];
  const seen = new Set<string>();
  const addOutcome = (assignment: SetAssignment, screenDamage: number) => {
    const key = assignmentKey(assignment, charIds);
    if (seen.has(key)) return;
    seen.add(key);
    outcomes.push({ assignment, key, screenDamage });
  };
  addOutcome(current, currentDamage);
  const joint = enumerateJointAssignments(
    trimChoicesToCap(shortlists, SET_JOINT_ASSIGNMENT_CAP)
  );
  for (const [index, assignment] of joint.entries()) {
    if (seen.has(assignmentKey(assignment, charIds))) continue;
    if (input.isJointlyFeasible && !input.isJointlyFeasible(assignment)) {
      skipped++;
      continue;
    }
    evaluated++;
    const damage = evaluateAssignment(input, assignment, baseline);
    if (damage == null) skipped++;
    else addOutcome(assignment, damage);
    if ((index + 1) % 100 === 0) report("joint", index + 1, joint.length);
  }
  report("joint", joint.length, joint.length);

  const witnesses = selectWitnesses({
    outcomes,
    charIds,
    score: (outcome) => outcome.screenDamage,
    topCount: SET_GENERATED_REFINE_COUNT,
    perMember: SET_WITNESS_CHOICES_PER_MEMBER,
    pinned: witnessed,
    currentIndex: 0,
    teamBuffSetIds: TIER_LIST_SUPPORT_ARTIFACT_SETS,
  });
  for (const [done, index] of witnesses.entries()) {
    const outcome = outcomes[index];
    const sheets = await generateAssignmentSheets(input, outcome.assignment);
    const damage = sheets
      ? evaluateAssignment(input, outcome.assignment, sheets)
      : null;
    evaluated++;
    if (sheets && damage != null) {
      outcome.generatedDamage = damage;
      const short = findErShortMembers(input, outcome.assignment, sheets);
      if (short.length > 0) outcome.generatedErShortCharIds = short;
      if (input.pools)
        outcome.accountEstimate = estimateOnAccount(
          input,
          outcome.assignment,
          sheets
        );
    } else skipped++;
    report("generate", done + 1, witnesses.length);
  }

  return { charIds, outcomes, currentIndex: 0, evaluated, skipped };
}
