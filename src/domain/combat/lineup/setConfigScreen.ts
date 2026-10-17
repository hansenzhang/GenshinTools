/**
 * Screening stages of the team set explorer (docs/design/lineup-solver.md, P1).
 *
 * A. Personal screen: with fixed baseline sheets, score every set choice for
 *    each member while teammates keep their current sets.
 * B. Joint screen: score every combination of the members' shortlists.
 * C. Generated re-score: fit generated artifacts to the best assignments and
 *    each member's best choices, then score them again.
 *
 * Every displayed number uses the display context and buff defaults rebuilt
 * for that assignment; searches use the optimize context.
 */

import type { Element } from "@/domain/enums";
import type { ArtifactSetConfig } from "@/domain/models";
import type {
  SetAssignment,
  SetAssignmentOutcome,
  SetConfigExplorerStage,
} from "@/domain/team/setConfigExplorerTypes";
import { deriveSetKeysFromConfigs } from "@/domain/team/teamConfigUtils";
import { buildBuffOverrides } from "../damage/core/comboBuffOverrides";
import type { StatSheet } from "../damage/core/statSheet";
import { TeamBuild } from "../damage/core/teamBuild";
import type {
  BuffActivationMap,
  CalcContext,
  ComboFormula,
  ExtraBuff,
  OptionMap,
  TeamSlotConfig,
} from "../damage/types";
import { runGenerator } from "../generator/generator";
import {
  SET_GENERATED_REFINE_COUNT,
  SET_JOINT_ASSIGNMENT_CAP,
  SET_NO_EFFECT_RELATIVE,
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
      input.userBuffOverrides
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

function shortlistMember(
  input: SetScreenInput,
  charId: string,
  current: SetAssignment,
  sheets: Record<string, StatSheet>,
  currentDamage: number,
  count: () => void
): MemberChoices {
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
  if (input.lockedCharIds.has(charId))
    return { charId, choices: [...ranked.values()] };

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
  if (noEffect) return { charId, choices: [...ranked.values()] };

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
  return { charId, choices: [...ranked.values()] };
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
  for (const [index, charId] of charIds.entries()) {
    shortlists.push(
      shortlistMember(input, charId, current, baseline, currentDamage, () => {
        evaluated++;
      })
    );
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
    pinned: input.pinned,
    currentIndex: 0,
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
    } else skipped++;
    report("generate", done + 1, witnesses.length);
  }

  return { charIds, outcomes, currentIndex: 0, evaluated, skipped };
}
