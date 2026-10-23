/**
 * Lineup solver job (docs/design/lineup-solver.md, P2).
 *
 * For each Abyss half a template has a recorded clear for, field the
 * template's compositions from the account, screen their sets with generated
 * artifacts under the half's enemy, optimize the finalists on the real
 * inventory and turn every result into a candidate with its model ratio r
 * to the recorded build. Then the best candidates of each chamber are re-run
 * without the gear the other half's best candidates need, so the pairing step
 * has conflict-free alternatives.
 *
 * Margins are left to the caller: they follow from r and the recorded clear
 * and bar, which can change without changing any candidate.
 */

import { TIER_LIST_SUPPORT_ARTIFACT_SETS } from "@/config/gameConstants";
import { getAllArtifacts } from "@/domain/build/artifact/inventory";
import {
  buildBuffOverrides,
  extractComboOverrides,
} from "@/domain/combat/damage/core/comboBuffOverrides";
import { StatSheet } from "@/domain/combat/damage/core/statSheet";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type {
  CalcContext,
  ComboFormula,
  TeamSlotConfig,
} from "@/domain/combat/damage/types";
import { resolveCalcContext } from "@/domain/combat/damage/utils";
import {
  candidateArtifactIds,
  candidateStrength,
  candidateWeaponUses,
  countSetSlotPieces,
  findContestedGear,
  reservedSetSlotPieces,
} from "@/domain/combat/lineup/candidates";
import {
  compositionObjective,
  countWeaponCopies,
  fieldComposition,
  resolveTeamObjective,
} from "@/domain/combat/lineup/compositions";
import {
  LINEUP_ANY_PIECES_PERCENT,
  LINEUP_MAX_DIVERSIFY_RUNS,
  LINEUP_MAX_RUNS,
  LINEUP_RANKED_COMPOSITIONS,
  LINEUP_SCREENED_COMPOSITIONS,
  SET_GENERATED_TIE_PERCENT,
  SET_MIN_RUN_MS,
} from "@/domain/combat/lineup/constants";
import { expectedLevelledPiece } from "@/domain/combat/lineup/levelling";
import {
  pickBestOutcome,
  selectFinalists,
} from "@/domain/combat/lineup/setAssignments";
import { assignmentKey } from "@/domain/combat/lineup/setChoices";
import {
  estimateOnAccount,
  evaluateAssignment,
  findPieceInsensitiveMembers,
  generateAssignmentSheets,
  makeAssignmentTeam,
  runSetConfigScreen,
  type SetScreenInput,
} from "@/domain/combat/lineup/setConfigScreen";
import { allSlots, type Slot, type StatKey } from "@/domain/enums";
import type { AccountData, ArtifactData } from "@/domain/models";
import { artifactsById } from "@/domain/reference/catalog";
import type {
  CharacterStatsMap,
  WeaponStatsMap,
} from "@/domain/reference/stats";
import {
  encounterCalcContext,
  findCalibration,
  getCharacterTraits,
  templateCompositions,
} from "@/domain/team/lineup";
import type {
  CandidateOrigin,
  LineupCandidate,
  LineupDiversifyPass,
  LineupIssue,
  LineupIssueReason,
  LineupMemberStats,
  LineupRunKind,
  LineupRunStart,
  LineupSolverMessage,
  LineupSolverRequest,
  LineupSolverResult,
  LineupSolverStage,
  LineupSolverTeam,
  LineupSolverTrace,
  LineupTaskTrace,
} from "@/domain/team/lineupSolverTypes";
import type {
  Calibration,
  Encounter,
  ReferenceBuild,
  TemplateComposition,
} from "@/domain/team/lineupTypes";
import type {
  SetAccountOutcome,
  SetAssignment,
  SetAssignmentOutcome,
} from "@/domain/team/setConfigExplorerTypes";
import {
  buildTeamSlotConfigs,
  detectEquippedSets,
} from "@/domain/team/teamConfigUtils";
import { teamSetUptimes } from "@/domain/team/teamDeltas";
import type { TeamComp, TeamSetupConfig } from "@/domain/team/types";
import { collectOwnedWeaponCopies } from "@/domain/team/weaponCopies";
import {
  optimizeAssignmentOnAccount,
  prepareTeamSetsJob,
  scorePieces,
  type TeamSetsJob,
} from "./setConfigExplorer";

type Report = (message: LineupSolverMessage) => void;
type ProgressMessage = Extract<LineupSolverMessage, { type: "progress" }>;
type ArtifactsByChar = Record<string, Record<Slot, ArtifactData | null>>;

/** One template against one encounter it has a recorded clear for. */
export interface Task {
  team: LineupSolverTeam;
  encounter: Encounter;
  calibration: Calibration;
}

/** How every composition of a task is scored. */
export interface TaskScoring {
  contexts: { optimize: CalcContext; display: CalcContext };
  /** The team's rotation. */
  objective: ComboFormula;
  userBuffOverrides: ReturnType<typeof extractComboOverrides>;
  /** The team's own members, whose lines joining members replace. */
  teamCharIds: string[];
}

/** What a candidate was optimized from, for re-runs. */
interface CandidateSource {
  task: Task;
  job: TeamSetsJob;
  assignment: SetAssignment;
  referenceDamage: number;
}

interface SolverState {
  request: LineupSolverRequest;
  report: Report;
  /** The stage's latest progress; a run's position is added to it. */
  progress: ProgressMessage | null;
  chars: CharacterStatsMap;
  weapons: WeaponStatsMap;
  weaponCopies: Record<string, number>;
  setSlotCounts: Record<string, number>;
  /** Pieces members whose pieces matter may use; null: every piece. */
  keeperIds: ReadonlySet<string> | null;
  /** With `levelToMax`, the real piece of each piece scored as levelled, by
   *  id; results carry these. */
  realPieces: ReadonlyMap<string, ArtifactData> | null;
  /** Real-inventory runs per task, and the time each gets (null: until
   *  done). */
  runCount: number;
  runMs: number | null;
  candidates: LineupCandidate[];
  issues: LineupIssue[];
  sources: Map<string, CandidateSource>;
  /** Candidates by gear, so the same build is listed once. */
  byGear: Map<string, LineupCandidate>;
  /** Re-runs done, by candidate and excluded pieces. */
  reruns: Map<string, LineupCandidate | null>;
  trace: LineupSolverTrace;
}

/** Screened assignments listed per composition in the trace. */
const TRACED_OUTCOMES = 8;

/** Stats the trace lists per member, besides the element's DMG bonus. */
const TRACED_STATS: StatKey[] = ["hp", "atk", "def", "em", "er", "cr", "cd"];

/** The request's encounters of its mode, Abyss halves in chamber order. */
function modeEncounters(request: LineupSolverRequest): Encounter[] {
  const encounters = request.encounters.filter(
    (encounter) => encounter.mode === request.mode
  );
  return encounters.sort((a, b) =>
    a.mode === "abyss" && b.mode === "abyss"
      ? a.chamber - b.chamber || a.half - b.half
      : 0
  );
}

/** Encounters that share the account at once: an Abyss chamber's halves,
 *  or a whole Stygian run. */
function encounterGroups(request: LineupSolverRequest): Encounter[][] {
  const encounters = modeEncounters(request);
  if (request.mode === "stygian")
    return encounters.length >= 2 ? [encounters] : [];
  const chambers = new Map<number, Encounter[]>();
  for (const encounter of encounters)
    if (encounter.mode === "abyss")
      chambers.set(encounter.chamber, [
        ...(chambers.get(encounter.chamber) ?? []),
        encounter,
      ]);
  return [...chambers.values()].filter((group) => group.length === 2);
}

function collectTasks(request: LineupSolverRequest): Task[] {
  const tasks: Task[] = [];
  for (const encounter of modeEncounters(request)) {
    for (const team of request.teams) {
      const calibration = findCalibration(
        request.calibrations,
        team.template.id,
        encounter.id
      );
      if (calibration) tasks.push({ team, encounter, calibration });
    }
  }
  return tasks;
}

/** Search and display contexts against the encounter's enemy. */
function encounterContexts(
  setupConfig: TeamSetupConfig,
  encounter: Encounter,
  clearSeconds: number
): { optimize: CalcContext; display: CalcContext } {
  const display = encounterCalcContext(
    encounter,
    resolveCalcContext(setupConfig.damage?.calcContext),
    clearSeconds
  );
  const crTargets = Object.entries(setupConfig.charConfigs ?? {}).flatMap(
    ([charId, config]) =>
      config.crMode === "target" && config.minCr != null
        ? [[charId, Math.round(config.minCr * 100)] as const]
        : []
  );
  return {
    optimize: {
      ...display,
      perCharCrTarget:
        crTargets.length > 0 ? Object.fromEntries(crTargets) : undefined,
    },
    display: { ...display, perCharCrTarget: undefined },
  };
}

function tryTeamBuild(
  configs: TeamSlotConfig[],
  setupConfig: TeamSetupConfig,
  context: CalcContext
): TeamBuild | null {
  if (configs.length === 0) return null;
  try {
    return new TeamBuild(
      configs,
      setupConfig.combatOptions ?? {},
      setupConfig.damage?.enemyAura,
      setupConfig.damage?.extraBuffs,
      undefined,
      context
    );
  } catch {
    return null;
  }
}

/** The task's enemy contexts and the team's rotation; null when the team
 *  has no rotation to score. */
export function taskScoring(
  task: Task,
  accountData: AccountData,
  comboOverrides: LineupSolverRequest["comboOverrides"]
): TaskScoring | null {
  const { teamComp, setupConfig } = task.team;
  const contexts = encounterContexts(
    setupConfig,
    task.encounter,
    task.calibration.measuredSeconds
  );
  const teamConfigs = buildTeamSlotConfigs(teamComp, setupConfig, accountData);
  const teamBuild = tryTeamBuild(teamConfigs, setupConfig, contexts.display);
  if (!teamBuild) return null;
  const objective = resolveTeamObjective(setupConfig.damage, teamBuild);
  if (objective.lines.length === 0) return null;
  return {
    contexts,
    objective,
    userBuffOverrides: extractComboOverrides(comboOverrides, objective.id),
    teamCharIds: teamConfigs.map((config) => config.charId),
  };
}

/** A composition fielded from the account with its share of the rotation;
 *  null when it cannot be fielded or scored. */
export function fieldScoredComposition(
  task: Task,
  scoring: TaskScoring,
  composition: TemplateComposition,
  accountData: AccountData
): { fielded: TeamComp; combo: ComboFormula } | null {
  const { template, teamComp, setupConfig } = task.team;
  const fielded = fieldComposition(
    template,
    teamComp,
    composition,
    accountData
  );
  if (!fielded) return null;
  const configs = buildTeamSlotConfigs(fielded, setupConfig, accountData);
  if (configs.length !== composition.length) return null;
  const team = tryTeamBuild(configs, setupConfig, scoring.contexts.display);
  const combo =
    team && compositionObjective(scoring.objective, team, scoring.teamCharIds);
  return combo ? { fielded, combo } : null;
}

/** Sets the recorded build's pieces form; unknown set keys count as none. */
function recordedSets(reference: ReferenceBuild): SetAssignment {
  return Object.fromEntries(
    reference.slots.map((slot) => [
      slot.charId,
      detectEquippedSets(
        (reference.artifactsByChar[slot.charId] ?? []).filter(
          (artifact) => !!artifactsById[artifact.setKey]
        )
      ),
    ])
  );
}

/** Model damage of the recorded build, scored with the sets its pieces form. */
function scoreReference(
  reference: ReferenceBuild,
  task: Task,
  objective: ComboFormula,
  teamCharIds: readonly string[],
  context: CalcContext,
  userBuffOverrides: ReturnType<typeof extractComboOverrides>
): number | null {
  const { setupConfig } = task.team;
  const sets = recordedSets(reference);
  const configs = reference.slots.map((slot) => ({
    ...slot,
    artifactSet: sets[slot.charId] ?? null,
  }));
  const team = tryTeamBuild(configs, setupConfig, context);
  if (!team) return null;
  const combo = compositionObjective(objective, team, teamCharIds);
  if (!combo) return null;
  const sheets = Object.fromEntries(
    configs.map((config) => [
      config.charId,
      StatSheet.fromArtifacts(reference.artifactsByChar[config.charId] ?? []),
    ])
  );
  try {
    const damage = team.getComboDamageResult(
      combo,
      sheets,
      context,
      buildBuffOverrides(
        combo.lines,
        team,
        sheets,
        context,
        userBuffOverrides,
        teamSetUptimes(setupConfig.damage)
      )
    ).totalDamage;
    return Number.isFinite(damage) && damage > 0 ? damage : null;
  } catch {
    return null;
  }
}

function candidateKey(candidate: LineupCandidate): string {
  return [
    candidate.templateId,
    candidate.encounterId,
    ...candidate.members.map(
      (member) =>
        `${member.charId}:${member.weaponId}:${member.refinement}:${Object.values(
          member.artifacts
        )
          .map((artifact) => artifact?.id ?? "")
          .join(",")}`
    ),
  ].join("|");
}

/** The scored pieces as a candidate, or the listed candidate with the same
 *  gear. Null when the pieces are unreachable. */
function addCandidate(
  state: SolverState,
  source: CandidateSource,
  configs: readonly TeamSlotConfig[],
  account: SetAccountOutcome,
  origin: CandidateOrigin
): LineupCandidate | null {
  if (account.damage == null) return null;
  const { task, referenceDamage } = source;
  const candidate: LineupCandidate = {
    id: `candidate-${state.candidates.length}`,
    templateId: task.team.template.id,
    encounterId: task.encounter.id,
    members: configs.map((config) => ({
      charId: config.charId,
      weaponId: config.weaponId,
      refinement: config.refinement,
      artifactSet: account.realized[config.charId] ?? null,
      artifacts: account.artifactsByChar[config.charId],
      anyPieces: false,
    })),
    damage: account.damage,
    ratio: account.damage / referenceDamage,
    origin,
  };
  const key = candidateKey(candidate);
  const listed = state.byGear.get(key);
  if (listed) return listed;
  const screen = { ...source.job.screen, configs: [...configs] };
  const sheets = Object.fromEntries(
    configs.map((config) => [
      config.charId,
      StatSheet.fromArtifacts(
        Object.values(account.artifactsByChar[config.charId] ?? {}).filter(
          (artifact): artifact is ArtifactData => artifact !== null
        )
      ),
    ])
  );
  const loose = new Set(
    findPieceInsensitiveMembers(
      screen,
      account.realized,
      sheets,
      LINEUP_ANY_PIECES_PERCENT
    )
  );
  for (const member of candidate.members)
    member.anyPieces = loose.has(member.charId);
  state.byGear.set(key, candidate);
  state.candidates.push(candidate);
  state.sources.set(candidate.id, source);
  state.trace.memberStats[candidate.id] = memberStats(
    state,
    screen,
    account.realized,
    sheets
  );
  return candidate;
}

/** Each member's final stats on the scored pieces, for the trace. */
function memberStats(
  state: SolverState,
  screen: SetScreenInput,
  realized: SetAssignment,
  sheets: Record<string, StatSheet>
): Record<string, LineupMemberStats> {
  try {
    const stats = makeAssignmentTeam(screen, realized).getTeamStats(
      sheets,
      screen.carryCharId,
      screen.displayContext
    );
    return Object.fromEntries(
      screen.configs.map(({ charId }) => {
        const sheet = stats[charId];
        const element = state.chars[charId]?.element;
        const keys: StatKey[] = element
          ? [...TRACED_STATS, `${element.toLowerCase()}%` as StatKey, "dmg%"]
          : [...TRACED_STATS, "dmg%"];
        return [
          charId,
          Object.fromEntries(
            keys.map((statKey) => [statKey, sheet?.get(statKey, null) ?? 0])
          ),
        ];
      })
    );
  } catch {
    return {};
  }
}

/**
 * The account with every piece below max level at its expected levelled
 * stats (`levelToMax`), and the real pieces of those it levelled, by id.
 */
function levelledAccount(account: AccountData): {
  account: AccountData;
  real: Map<string, ArtifactData>;
} {
  const real = new Map<string, ArtifactData>();
  const level = (artifact: ArtifactData) => {
    const levelled = expectedLevelledPiece(artifact);
    if (levelled !== artifact) real.set(artifact.id, artifact);
    return levelled;
  };
  return {
    account: {
      ...account,
      characters: account.characters.map((character) => ({
        ...character,
        artifacts: Object.fromEntries(
          Object.entries(character.artifacts).map(([slot, artifact]) => [
            slot,
            level(artifact),
          ])
        ),
      })),
      extraArtifacts: account.extraArtifacts.map(level),
    },
    real,
  };
}

/** The candidate wearing the real pieces of those scored as levelled. */
function withRealPieces(
  candidate: LineupCandidate,
  real: ReadonlyMap<string, ArtifactData>
): LineupCandidate {
  return {
    ...candidate,
    members: candidate.members.map((member) => ({
      ...member,
      artifacts: Object.fromEntries(
        allSlots.map((slot) => {
          const artifact = member.artifacts[slot];
          return [slot, artifact ? (real.get(artifact.id) ?? artifact) : null];
        })
      ) as Record<Slot, ArtifactData | null>,
    })),
  };
}

function snapshot(state: SolverState, partial: boolean): LineupSolverResult {
  const { realPieces } = state;
  return {
    candidates: realPieces
      ? state.candidates.map((candidate) =>
          withRealPieces(candidate, realPieces)
        )
      : [...state.candidates],
    issues: [...state.issues],
    weaponCopies: state.weaponCopies,
    setSlotCounts: state.setSlotCounts,
    trace: {
      tasks: [...state.trace.tasks],
      runs: [...state.trace.runs],
      inFlight: state.trace.inFlight,
      memberStats: { ...state.trace.memberStats },
      diversify: [...state.trace.diversify],
    },
    partial,
  };
}

/** Results so far, with the trace, so a stopped job can still be saved. */
function publish(state: SolverState): void {
  state.report({ type: "partial", result: snapshot(state, true) });
}

function reportProgress(state: SolverState, message: ProgressMessage): void {
  state.progress = message;
  state.report(message);
}

/** Optimize an assignment on the account and record the run in the trace. */
async function tracedRun(
  state: SolverState,
  run: Pick<PlannedRun, "kind" | "generatedDamage" | "accountEstimate">,
  source: CandidateSource,
  excludedIds: readonly string[],
  add: (outcome: SetAccountOutcome) => LineupCandidate | null
): Promise<LineupCandidate | null> {
  const { task, job, assignment } = source;
  const started: LineupRunStart = {
    kind: run.kind,
    templateId: task.team.template.id,
    encounterId: task.encounter.id,
    charIds: job.charIds,
    assignment,
    generatedDamage: run.generatedDamage,
    accountEstimate: run.accountEstimate,
    excludedArtifactCount: excludedIds.length,
    runMs: state.runMs,
    startedAt: Date.now(),
  };
  state.trace.inFlight = started;
  publish(state);
  const start = performance.now();
  const outcome = await optimizeAssignmentOnAccount(
    job,
    assignment,
    state.runMs,
    new Set(excludedIds),
    (position) => {
      if (state.progress)
        state.report({
          ...state.progress,
          run: { ...position, startedAt: started.startedAt },
        });
    }
  );
  const elapsedMs = performance.now() - start;
  // A member whose search timed out got a quick fill, not a search result.
  const timedOut = Object.values(outcome.failReasons).some(
    (reason) => reason.kind === "timeout"
  );
  const candidate = timedOut ? null : add(outcome);
  state.trace.runs.push({
    ...started,
    elapsedMs,
    damage: outcome.damage,
    realized: outcome.realized,
    failReasons: outcome.failReasons,
    unmetCharIds: outcome.unmetCharIds,
    saturatedCharIds: outcome.diagnostics?.saturatedCharIds ?? [],
    substatWeights: outcome.diagnostics?.substatWeights ?? {},
    phases: outcome.diagnostics?.phases ?? [],
    memberSearchMs: outcome.diagnostics?.memberSearchMs ?? {},
    candidateId: candidate?.id ?? null,
  });
  state.trace.inFlight = null;
  publish(state);
  if (state.progress) state.report(state.progress);
  return candidate;
}

interface ScreenedComposition {
  job: TeamSetsJob;
  /** Outcomes to optimize, best first. */
  order: number[];
  outcomes: SetAssignmentOutcome[];
  best: number;
}

/** A composition at its current sets, on generated artifacts and on the
 *  account's pieces. */
interface RankedComposition {
  job: TeamSetsJob;
  generatedDamage: number;
  accountEstimate: number | null;
}

/** Account estimate first; compositions the account cannot field at their
 *  current sets go last, by generated damage. */
function byStrength(a: RankedComposition, b: RankedComposition): number {
  if (a.accountEstimate != null && b.accountEstimate != null)
    return b.accountEstimate - a.accountEstimate;
  if (a.accountEstimate != null) return -1;
  if (b.accountEstimate != null) return 1;
  return b.generatedDamage - a.generatedDamage;
}

/**
 * Compositions worth screening: the strongest at their current sets, the
 * strongest without each member of it that some composition leaves out, then
 * the next strongest.
 */
function pickCompositions(ranked: readonly RankedComposition[]): TeamSetsJob[] {
  if (ranked.length === 0) return [];
  const picked = new Set([ranked[0]]);
  const avoidable = ranked[0].job.charIds.filter((charId) =>
    ranked.some(({ job }) => !job.charIds.includes(charId))
  );
  for (const charId of avoidable) {
    const without = ranked.find(({ job }) => !job.charIds.includes(charId));
    if (without) picked.add(without);
  }
  for (const entry of ranked) picked.add(entry);
  return [...picked]
    .slice(0, LINEUP_SCREENED_COMPOSITIONS)
    .map(({ job }) => job);
}

/** Screens a composition's sets and orders its finalists by their account
 *  estimate, best first. */
async function screenComposition(
  job: TeamSetsJob
): Promise<ScreenedComposition | null> {
  const output = await runSetConfigScreen(job.screen, () => {});
  if (!output) return null;
  const { outcomes, currentIndex } = output;
  const score = (outcome: SetAssignmentOutcome) =>
    outcome.accountEstimate ?? null;
  const best =
    pickBestOutcome(
      outcomes,
      outcomes.flatMap((outcome, i) => (score(outcome) == null ? [] : [i])),
      score,
      job.current,
      job.charIds,
      SET_GENERATED_TIE_PERCENT
    ) ?? currentIndex;
  const finalists = selectFinalists({
    outcomes,
    charIds: job.charIds,
    score,
    bestIndex: best,
    currentIndex,
    teamBuffSetIds: TIER_LIST_SUPPORT_ARTIFACT_SETS,
    pinned: {},
    max: LINEUP_MAX_RUNS,
  });
  // Longer budgets run further down the estimates.
  const rest = outcomes
    .flatMap((outcome, i) => (score(outcome) == null ? [] : [i]))
    .sort((a, b) => (score(outcomes[b]) ?? 0) - (score(outcomes[a]) ?? 0));
  return {
    job,
    outcomes,
    best,
    order: [...new Set([best, ...finalists, ...rest])],
  };
}

const sameMembers = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((charId) => b.includes(charId));

/**
 * The recorded build as a candidate, so no lineup does worse than what was
 * played. Only when its members are one of the template's compositions and
 * every piece is still on the account.
 */
function addRecordedCandidate(
  state: SolverState,
  task: Task,
  job: TeamSetsJob,
  referenceDamage: number
): void {
  const { reference } = task.calibration;
  const owned = new Set(
    getAllArtifacts(state.request.accountData).map((artifact) => artifact.id)
  );
  const pieces = Object.values(reference.artifactsByChar).flat();
  if (pieces.some((artifact) => !owned.has(artifact.id))) return;
  const sets = recordedSets(reference);
  const artifactsByChar: ArtifactsByChar = Object.fromEntries(
    reference.slots.map(({ charId }) => [
      charId,
      Object.fromEntries(
        allSlots.map((slot) => [
          slot,
          reference.artifactsByChar[charId]?.find(
            (artifact) => artifact.slotKey === slot
          ) ?? null,
        ])
      ) as Record<Slot, ArtifactData | null>,
    ])
  );
  addCandidate(
    state,
    { task, job, assignment: sets, referenceDamage },
    reference.slots.map((slot) => ({
      ...slot,
      artifactSet: sets[slot.charId] ?? null,
    })),
    {
      damage: referenceDamage,
      realized: sets,
      artifactsByChar,
      failReasons: {},
      unmetCharIds: [],
    },
    "recorded"
  );
}

/** A real-inventory run to make for a task. */
interface PlannedRun {
  kind: LineupRunKind;
  job: TeamSetsJob;
  assignment: SetAssignment;
  generatedDamage: number | null;
  accountEstimate: number | null;
}

async function generateTaskCandidates(
  state: SolverState,
  task: Task,
  progress: (stage: LineupSolverStage, done: number, total: number) => void
): Promise<LineupIssueReason | null> {
  const { request, chars } = state;
  const account = request.accountData;
  const { template, teamComp, setupConfig } = task.team;
  const scoring = taskScoring(task, account, request.comboOverrides);
  if (!scoring) return "no-objective";
  const { contexts, objective, userBuffOverrides, teamCharIds } = scoring;
  const { reference } = task.calibration;
  const referenceDamage = scoreReference(
    reference,
    task,
    objective,
    teamCharIds,
    contexts.display,
    userBuffOverrides
  );
  const referenceSets = recordedSets(reference);
  const taskTrace: LineupTaskTrace = {
    templateId: template.id,
    encounterId: task.encounter.id,
    referenceDamage,
    referenceSets,
    compositions: [],
    screenMs: 0,
    screens: [],
  };
  state.trace.tasks.push(taskTrace);
  if (referenceDamage == null) return "reference-unscored";

  /** A composition's set job; `openCharIds` may use pieces besides the
   *  keepers. Null when the calculator cannot build it. */
  const prepare = (
    fielded: TeamComp,
    combo: ComboFormula,
    openCharIds: readonly string[]
  ): TeamSetsJob | null => {
    try {
      const setup = prepareTeamSetsJob(
        {
          teamComp: fielded,
          setupConfig,
          accountData: account,
          objective: combo,
          userBuffOverrides,
          carryCharId: combo.lines[0].charId,
          optimizeContext: contexts.optimize,
          displayContext: contexts.display,
          settings: {
            useAccountArtifacts: true,
            lockedCharIds: [],
            pinned: {},
            // The lineup job times its own runs.
            timeBudgetSec: 0,
          },
          keepers: state.keeperIds
            ? { ids: state.keeperIds, openCharIds }
            : undefined,
        },
        chars
      );
      return setup.kind === "ready" ? setup.job : null;
    } catch {
      return null;
    }
  };

  const traits = (charId: string) => getCharacterTraits(charId, chars);
  const jobs: TeamSetsJob[] = [];
  for (const composition of templateCompositions(
    template,
    teamComp,
    traits
  ).slice(0, LINEUP_RANKED_COMPOSITIONS)) {
    const scored = fieldScoredComposition(task, scoring, composition, account);
    const job = scored && prepare(scored.fielded, scored.combo, []);
    if (job) jobs.push(job);
  }
  if (jobs.length === 0) return "no-composition";

  const screenStart = performance.now();
  const screenSteps =
    jobs.length + Math.min(jobs.length, LINEUP_SCREENED_COMPOSITIONS);
  const ranked: RankedComposition[] = [];
  for (const [index, initial] of jobs.entries()) {
    progress("screen", index, screenSteps);
    let job = initial;
    const sheets = await generateAssignmentSheets(job.screen, job.current);
    // Members whose pieces don't matter may wear any piece, kept or not.
    const open =
      sheets && state.keeperIds
        ? findPieceInsensitiveMembers(
            job.screen,
            job.current,
            sheets,
            LINEUP_ANY_PIECES_PERCENT
          )
        : [];
    const reopened =
      open.length > 0
        ? prepare(job.request.teamComp, job.request.objective, open)
        : null;
    if (reopened) jobs[index] = job = reopened;
    const generatedDamage = sheets
      ? evaluateAssignment(job.screen, job.current, sheets)
      : null;
    if (sheets && generatedDamage != null)
      ranked.push({
        job,
        generatedDamage,
        accountEstimate: estimateOnAccount(job.screen, job.current, sheets),
      });
  }
  ranked.sort(byStrength);
  const recordedJob = jobs.find((job) =>
    sameMembers(
      job.charIds,
      reference.slots.map((slot) => slot.charId)
    )
  );
  if (recordedJob)
    addRecordedCandidate(state, task, recordedJob, referenceDamage);
  taskTrace.compositions = ranked.map(
    ({ job, generatedDamage, accountEstimate }) => ({
      charIds: job.charIds,
      generatedDamage,
      accountEstimate,
    })
  );
  const picked = pickCompositions(ranked);
  if (picked.length === 0) return "no-composition";

  const screened: ScreenedComposition[] = [];
  for (const [index, job] of picked.entries()) {
    progress("screen", jobs.length + index, screenSteps);
    const entry = await screenComposition(job);
    if (entry) screened.push(entry);
  }
  taskTrace.screenMs = performance.now() - screenStart;
  if (screened.length === 0) return "no-composition";
  const bestEstimate = (entry: ScreenedComposition) =>
    entry.outcomes[entry.best].accountEstimate ?? Number.NEGATIVE_INFINITY;
  screened.sort((a, b) => bestEstimate(b) - bestEstimate(a));
  taskTrace.screens = screened.map((entry) => ({
    charIds: entry.job.charIds,
    outcomes: entry.order.slice(0, TRACED_OUTCOMES).map((index) => ({
      assignment: entry.outcomes[index].assignment,
      generatedDamage: entry.outcomes[index].generatedDamage ?? null,
      accountEstimate: entry.outcomes[index].accountEstimate ?? null,
    })),
  }));

  // The recorded sets on the account first, then round-robin: every
  // composition's best, then each one's next finalist.
  const runs: PlannedRun[] = recordedJob
    ? [
        {
          kind: "recorded-sets",
          job: recordedJob,
          assignment: referenceSets,
          generatedDamage: null,
          accountEstimate: null,
        },
      ]
    : [];
  // Keyed by members too: a joiner takes the slot of the member it replaces,
  // so two compositions can screen the same sets slot for slot.
  const runKey = (assignment: SetAssignment, charIds: readonly string[]) =>
    `${charIds.join(",")}:${assignmentKey(assignment, charIds)}`;
  const planned = new Set(
    runs.map((run) => runKey(run.assignment, run.job.charIds))
  );
  for (let rank = 0; runs.length < state.runCount; rank++) {
    const next = screened.filter((entry) => rank < entry.order.length);
    if (next.length === 0) break;
    for (const entry of next) {
      if (runs.length >= state.runCount) break;
      const outcome = entry.outcomes[entry.order[rank]];
      const key = runKey(outcome.assignment, entry.job.charIds);
      if (planned.has(key)) continue;
      planned.add(key);
      runs.push({
        kind: "search",
        job: entry.job,
        assignment: outcome.assignment,
        generatedDamage: outcome.generatedDamage ?? null,
        accountEstimate: outcome.accountEstimate ?? null,
      });
    }
  }

  for (const [done, run] of runs.entries()) {
    progress("optimize", done, runs.length);
    const source = {
      task,
      job: run.job,
      assignment: run.assignment,
      referenceDamage,
    };
    await tracedRun(state, run, source, [], (outcome) =>
      addCandidate(state, source, run.job.configs, outcome, "search")
    );
  }
  return state.candidates.some(
    (candidate) =>
      candidate.templateId === template.id &&
      candidate.encounterId === task.encounter.id
  )
    ? null
    : "no-candidate";
}

/**
 * The candidate's pieces with another owned weapon for each member whose
 * weapon `other` also needs and the account lacks copies for. Each member
 * takes the alternative of its weapon type that scores highest.
 */
function swapContestedWeapons(
  state: SolverState,
  candidate: LineupCandidate,
  other: LineupCandidate
): LineupCandidate | null {
  const source = state.sources.get(candidate.id);
  if (!source) return null;
  const contested = new Set(
    findContestedGear(candidate, other, state.weaponCopies).weaponIds
  );
  if (contested.size === 0) return null;
  const otherUses = candidateWeaponUses(other);
  const uses = candidateWeaponUses(candidate);
  const free = (weaponId: string) =>
    (uses[weaponId] ?? 0) + (otherUses[weaponId] ?? 0) <
    (state.weaponCopies[weaponId] ?? 0);
  const bestCopies = new Map<string, number>();
  for (const copy of collectOwnedWeaponCopies(state.request.accountData))
    bestCopies.set(
      copy.key,
      Math.max(copy.refinement, bestCopies.get(copy.key) ?? 0)
    );
  const artifactsByChar: ArtifactsByChar = Object.fromEntries(
    candidate.members.map((member) => [member.charId, member.artifacts])
  );
  let configs = source.job.configs.map((config) => {
    const member = candidate.members.find((m) => m.charId === config.charId);
    return member
      ? { ...config, weaponId: member.weaponId, refinement: member.refinement }
      : config;
  });
  let scored: SetAccountOutcome | null = null;
  for (const member of candidate.members) {
    if (!contested.has(member.weaponId)) continue;
    if (
      uses[member.weaponId] + (otherUses[member.weaponId] ?? 0) <=
      (state.weaponCopies[member.weaponId] ?? 0)
    )
      continue;
    const weaponType = state.chars[member.charId]?.weaponType;
    let best: { configs: TeamSlotConfig[]; outcome: SetAccountOutcome } | null =
      null;
    for (const [weaponId, refinement] of bestCopies) {
      if (
        weaponId === member.weaponId ||
        state.weapons[weaponId]?.type !== weaponType ||
        !free(weaponId)
      )
        continue;
      const next = configs.map((config) =>
        config.charId === member.charId
          ? { ...config, weaponId, refinement }
          : config
      );
      const outcome = scorePieces(
        { ...source.job.screen, configs: next },
        artifactsByChar,
        {}
      );
      if (
        outcome.damage != null &&
        outcome.damage > (best?.outcome.damage ?? Number.NEGATIVE_INFINITY)
      )
        best = { configs: next, outcome };
    }
    if (!best) return null;
    const chosen = best.configs.find(
      (config) => config.charId === member.charId
    )!;
    uses[member.weaponId]--;
    uses[chosen.weaponId] = (uses[chosen.weaponId] ?? 0) + 1;
    configs = best.configs;
    scored = best.outcome;
  }
  return scored
    ? addCandidate(state, source, configs, scored, "weapon-swapped")
    : null;
}

/**
 * The source's composition with `excludedIds` out of every member's pool:
 * sets are screened again, since the remaining pieces may not form the
 * original ones, and the best assignment is optimized.
 */
async function rerunWithout(
  state: SolverState,
  source: CandidateSource,
  excludedIds: readonly string[]
): Promise<LineupCandidate | null> {
  const { request } = source.job;
  const setup = prepareTeamSetsJob(
    {
      ...request,
      perCharExcludedArtifactIds: Object.fromEntries(
        source.job.charIds.map((charId) => [
          charId,
          [
            ...excludedIds,
            ...(request.perCharExcludedArtifactIds?.[charId] ?? []),
          ],
        ])
      ),
    },
    state.chars
  );
  if (setup.kind !== "ready") return null;
  const screened = await screenComposition(setup.job);
  if (!screened) return null;
  const { assignment, generatedDamage, accountEstimate } =
    screened.outcomes[screened.best];
  const rerun = { ...source, job: setup.job, assignment };
  return tracedRun(
    state,
    {
      kind: "pieces-excluded",
      generatedDamage: generatedDamage ?? null,
      accountEstimate: accountEstimate ?? null,
    },
    rerun,
    excludedIds,
    (outcome) =>
      addCandidate(state, rerun, setup.job.configs, outcome, "pieces-excluded")
  );
}

/** Candidates of one encounter worth keeping clear of: the best per
 *  template and composition. */
function leaders(
  candidates: readonly LineupCandidate[],
  encounterId: string,
  strength: (candidate: LineupCandidate) => number
): LineupCandidate[] {
  const best = new Map<string, LineupCandidate>();
  for (const candidate of candidates) {
    if (candidate.encounterId !== encounterId) continue;
    const key = `${candidate.templateId}|${candidate.members
      .map((member) => member.charId)
      .sort()
      .join(",")}`;
    const current = best.get(key);
    if (!current || strength(candidate) > strength(current))
      best.set(key, candidate);
  }
  return [...best.values()];
}

/** Candidates combined into one, to keep a re-run clear of all of them. */
function combined(candidates: readonly LineupCandidate[]): LineupCandidate {
  return {
    ...candidates[0],
    id: candidates.map((candidate) => candidate.id).join("+"),
    members: candidates.flatMap((candidate) => candidate.members),
  };
}

/**
 * The candidate kept clear of `other`'s pieces and the set slots its members
 * that take any pieces need (re-run), and of the weapon copies it needs
 * (swapped). Null when no version found fits beside `other` under the
 * lineup plan's limits. Candidates the re-run and swap give are added to
 * `found`.
 */
async function keepClear(
  state: SolverState,
  candidate: LineupCandidate,
  other: LineupCandidate,
  found: Set<string>
): Promise<LineupCandidate | null> {
  const source = state.sources.get(candidate.id);
  if (!source) return null;
  const fits = (entry: LineupCandidate) => {
    const left = findContestedGear(
      entry,
      other,
      state.weaponCopies,
      state.setSlotCounts
    );
    return left.artifactIds.length === 0 && left.setSlotKeys.length === 0;
  };
  const rerun = async (excluded: readonly string[]) => {
    const key = `${candidate.id}|${[...excluded].sort().join(",")}`;
    if (!state.reruns.has(key))
      state.reruns.set(key, await rerunWithout(state, source, excluded));
    const result = state.reruns.get(key) ?? null;
    if (result) found.add(result.id);
    return result;
  };
  let clear: LineupCandidate | null = candidate;
  if (!fits(candidate)) {
    // Kept clear of the other's own pieces first. A re-run that still
    // collides on set slots (the other's members that take any pieces need
    // the slot's last ones) stays a candidate: one more piece of the slot
    // would let it be fielded, which the plan's missing pieces report. The
    // re-run then leaves those slots to the other.
    const exact = candidateArtifactIds(other);
    clear = await rerun(exact);
    if (clear && !fits(clear)) {
      const reserved = reservedSetSlotPieces(
        other,
        getAllArtifacts(state.request.accountData),
        state.setSlotCounts
      );
      clear = reserved.length > 0 ? await rerun([...exact, ...reserved]) : null;
    }
  }
  if (!clear) return null;
  if (
    findContestedGear(clear, other, state.weaponCopies).weaponIds.length === 0
  )
    return fits(clear) ? clear : null;
  const swapped = swapContestedWeapons(state, clear, other);
  if (swapped) found.add(swapped.id);
  return swapped && fits(swapped) ? swapped : null;
}

/**
 * Leading candidates of different encounters in a group that share pieces,
 * weapon copies or a set's slots but no character, most promising first.
 */
function conflictingPairs(
  state: SolverState,
  group: readonly Encounter[],
  strength: (candidate: LineupCandidate) => number
): [LineupCandidate, LineupCandidate][] {
  const pairs: [LineupCandidate, LineupCandidate][] = [];
  group.forEach((first, index) => {
    for (const second of group.slice(index + 1))
      for (const a of leaders(state.candidates, first.id, strength))
        for (const b of leaders(state.candidates, second.id, strength)) {
          const contested = findContestedGear(
            a,
            b,
            state.weaponCopies,
            state.setSlotCounts
          );
          if (
            contested.charIds.length === 0 &&
            (contested.artifactIds.length > 0 ||
              contested.weaponIds.length > 0 ||
              contested.setSlotKeys.length > 0)
          )
            pairs.push([a, b]);
        }
  });
  return pairs.sort(
    ([a1, b1], [a2, b2]) =>
      Math.min(strength(a2), strength(b2)) -
      Math.min(strength(a1), strength(b1))
  );
}

/**
 * One lineup for the whole group, built encounter by encounter in order of
 * each one's best strength: every pick is the strongest candidate sharing no
 * character with the earlier picks, kept clear of their gear. A pick also
 * leaves the later encounters a candidate each with no character twice, when
 * it can. Returns the lineup, shorter than the group when a pick fails.
 */
async function chainLineup(
  state: SolverState,
  group: readonly Encounter[],
  strength: (candidate: LineupCandidate) => number,
  weakestFirst: boolean,
  step: () => void,
  found: Set<string>
): Promise<LineupCandidate[]> {
  const on = (encounterId: string) =>
    state.candidates.filter(
      (candidate) => candidate.encounterId === encounterId
    );
  const strongest = (candidates: readonly LineupCandidate[]) =>
    [...candidates].sort((a, b) => strength(b) - strength(a))[0];
  const charIds = (candidate: LineupCandidate) =>
    candidate.members.map((member) => member.charId);
  const best = (encounterId: string) => {
    const candidate = strongest(on(encounterId));
    return candidate ? strength(candidate) : 0;
  };
  const order = [...group].sort((a, b) => {
    const gap = best(a.id) - best(b.id);
    return weakestFirst ? gap : -gap;
  });
  /** Each encounter's distinct character sets, to search lineups over. */
  const rosters = order.map((encounter) => [
    ...new Map(
      on(encounter.id).map((candidate) => {
        const ids = charIds(candidate).sort();
        return [ids.join(","), ids];
      })
    ).values(),
  ]);
  /** Whether the encounters from `index` on can each still field a
   *  candidate with none of `taken` and no character twice. */
  const completable = (index: number, taken: ReadonlySet<string>): boolean =>
    index >= order.length ||
    rosters[index].some(
      (ids) =>
        !ids.some((id) => taken.has(id)) &&
        completable(index + 1, new Set([...taken, ...ids]))
    );
  const pick = (index: number, taken: ReadonlySet<string>) => {
    const free = on(order[index].id).filter(
      (candidate) => !charIds(candidate).some((id) => taken.has(id))
    );
    return (
      strongest(
        free.filter((candidate) =>
          completable(index + 1, new Set([...taken, ...charIds(candidate)]))
        )
      ) ?? strongest(free)
    );
  };
  const lineup: LineupCandidate[] = [];
  for (const index of order.keys()) {
    const taken = new Set(
      lineup.flatMap((chosen) => chosen.members.map((member) => member.charId))
    );
    const candidate = pick(index, taken);
    if (!candidate) return lineup;
    if (lineup.length === 0) {
      lineup.push(candidate);
      continue;
    }
    step();
    const clear = await keepClear(state, candidate, combined(lineup), found);
    if (!clear) return lineup;
    lineup.push(clear);
  }
  return lineup;
}

/**
 * Alternatives that keep clear of other encounters' gear. In each group,
 * leading candidates that share pieces or weapon copies but no character are
 * fixed both ways, the most promising pairs first. A group of three or more
 * also gets two encounter-by-encounter lineups, weakest and strongest first,
 * so at least one full lineup fits together: weakest first gives the floor
 * its best build, strongest first the others theirs.
 */
async function diversify(
  state: SolverState,
  progress: (done: number, total: number) => void
): Promise<void> {
  const strength = candidateStrength(
    state.request.calibrations,
    state.request.encounters
  );
  const groups = encounterGroups(state.request);
  const fixes = groups.map((group) =>
    conflictingPairs(state, group, strength)
      .flatMap(([a, b]) => [
        [a, b],
        [b, a],
      ])
      .slice(0, LINEUP_MAX_DIVERSIFY_RUNS)
  );
  const chainSteps = groups.reduce(
    (sum, group) => sum + (group.length >= 3 ? 2 * (group.length - 1) : 0),
    0
  );
  const total = fixes.flat().length + chainSteps;
  let done = 0;
  const step = () => progress(done++, total);

  for (const [index, group] of groups.entries()) {
    const record = (
      pass: LineupDiversifyPass,
      lineup: readonly LineupCandidate[],
      found: ReadonlySet<string>
    ) =>
      state.trace.diversify.push({
        pass,
        encounterIds: group.map((encounter) => encounter.id),
        lineupIds: lineup.map((candidate) => candidate.id),
        clearIds: [...found],
      });
    if (group.length >= 3)
      for (const weakestFirst of [true, false]) {
        const found = new Set<string>();
        const lineup = await chainLineup(
          state,
          group,
          strength,
          weakestFirst,
          step,
          found
        );
        record(
          weakestFirst ? "weakest-first" : "strongest-first",
          lineup,
          found
        );
      }
    if (fixes[index].length === 0) continue;
    const found = new Set<string>();
    for (const [candidate, other] of fixes[index]) {
      step();
      await keepClear(state, candidate, other, found);
    }
    record("pairs", [], found);
  }
}

export async function runLineupSolver(
  input: LineupSolverRequest,
  chars: CharacterStatsMap,
  weapons: WeaponStatsMap,
  report: Report
): Promise<void> {
  // Levelled once here, so every step scores the same pieces.
  const levelled = input.levelToMax ? levelledAccount(input.accountData) : null;
  const request = levelled
    ? { ...input, accountData: levelled.account }
    : input;
  const tasks = collectTasks(request);
  if (tasks.length === 0) {
    report({ type: "error", reason: "no-calibrations" });
    return;
  }
  const budgetMs =
    request.timeBudgetSec == null
      ? null
      : Math.max(1, request.timeBudgetSec) * 1000;
  const runCount =
    budgetMs == null
      ? LINEUP_MAX_RUNS
      : Math.min(
          LINEUP_MAX_RUNS,
          Math.max(1, Math.floor(budgetMs / SET_MIN_RUN_MS))
        );
  const state: SolverState = {
    request,
    report,
    progress: null,
    chars,
    weapons,
    weaponCopies: countWeaponCopies(request.accountData),
    setSlotCounts: countSetSlotPieces(getAllArtifacts(request.accountData)),
    // Recorded builds' pieces stay usable, so their sets can run again.
    keeperIds: request.keeperArtifactIds
      ? new Set([
          ...request.keeperArtifactIds,
          ...request.calibrations.flatMap((calibration) =>
            Object.values(calibration.reference.artifactsByChar).flatMap(
              (pieces) => pieces.map((artifact) => artifact.id)
            )
          ),
        ])
      : null,
    realPieces: levelled?.real ?? null,
    runCount,
    runMs: budgetMs == null ? null : budgetMs / runCount,
    candidates: [],
    issues: [],
    sources: new Map(),
    byGear: new Map(),
    reruns: new Map(),
    trace: {
      tasks: [],
      runs: [],
      inFlight: null,
      memberStats: {},
      diversify: [],
    },
  };

  for (const [index, task] of tasks.entries()) {
    let reason: LineupIssueReason | null;
    try {
      reason = await generateTaskCandidates(state, task, (stage, done, total) =>
        reportProgress(state, {
          type: "progress",
          stage,
          task: index,
          tasks: tasks.length,
          done,
          total,
        })
      );
    } catch {
      reason = "calculator-error";
      state.trace.inFlight = null;
    }
    if (reason)
      state.issues.push({
        templateId: task.team.template.id,
        encounterId: task.encounter.id,
        reason,
      });
    publish(state);
  }

  await diversify(state, (done, total) =>
    reportProgress(state, {
      type: "progress",
      stage: "diversify",
      task: tasks.length,
      tasks: tasks.length,
      done,
      total,
    })
  );
  report({ type: "result", result: snapshot(state, false) });
}
