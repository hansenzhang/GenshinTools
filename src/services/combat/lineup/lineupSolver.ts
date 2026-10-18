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
  calibrateCandidates,
  candidateArtifactIds,
  candidateWeaponUses,
  findContestedGear,
} from "@/domain/combat/lineup/candidates";
import {
  compositionObjective,
  countWeaponCopies,
  fieldComposition,
  resolveTeamObjective,
} from "@/domain/combat/lineup/compositions";
import {
  LINEUP_MAX_DIVERSIFY_RUNS,
  LINEUP_MAX_RUNS,
  LINEUP_RANKED_COMPOSITIONS,
  LINEUP_SCREENED_COMPOSITIONS,
  SET_GENERATED_TIE_PERCENT,
  SET_MIN_RUN_MS,
} from "@/domain/combat/lineup/constants";
import {
  pickBestOutcome,
  selectFinalists,
} from "@/domain/combat/lineup/setAssignments";
import {
  evaluateAssignment,
  generateAssignmentSheets,
  runSetConfigScreen,
} from "@/domain/combat/lineup/setConfigScreen";
import type { Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
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
  LineupIssue,
  LineupIssueReason,
  LineupSolverMessage,
  LineupSolverRequest,
  LineupSolverResult,
  LineupSolverStage,
  LineupSolverTeam,
} from "@/domain/team/lineupSolverTypes";
import type {
  Calibration,
  Encounter,
  ReferenceBuild,
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
import type { TeamSetupConfig } from "@/domain/team/types";
import { collectOwnedWeaponCopies } from "@/domain/team/weaponCopies";
import {
  optimizeAssignmentOnAccount,
  prepareTeamSetsJob,
  scorePieces,
  type TeamSetsJob,
} from "./setConfigExplorer";

type Report = (message: LineupSolverMessage) => void;
type ArtifactsByChar = Record<string, Record<Slot, ArtifactData | null>>;

/** One template against one encounter it has a recorded clear for. */
interface Task {
  team: LineupSolverTeam;
  encounter: Encounter;
  calibration: Calibration;
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
  chars: CharacterStatsMap;
  weapons: WeaponStatsMap;
  weaponCopies: Record<string, number>;
  /** Real-inventory runs per task, and the time each gets. */
  runCount: number;
  runMs: number;
  candidates: LineupCandidate[];
  issues: LineupIssue[];
  sources: Map<string, CandidateSource>;
  /** Candidates by gear, so the same build is listed once. */
  byGear: Map<string, LineupCandidate>;
  /** Re-runs done, by candidate and excluded pieces. */
  reruns: Map<string, LineupCandidate | null>;
}

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
  encounter: Encounter
): { optimize: CalcContext; display: CalcContext } {
  const display = encounterCalcContext(
    encounter,
    resolveCalcContext(setupConfig.damage?.calcContext)
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

/** Model damage of the recorded build, scored with the sets its pieces form. */
function scoreReference(
  reference: ReferenceBuild,
  task: Task,
  objective: ComboFormula,
  singleFormula: boolean,
  teamCharIds: readonly string[],
  context: CalcContext,
  userBuffOverrides: ReturnType<typeof extractComboOverrides>
): number | null {
  const { setupConfig } = task.team;
  const configs = reference.slots.map((slot) => {
    const pieces = reference.artifactsByChar[slot.charId] ?? [];
    return {
      ...slot,
      artifactSet: detectEquippedSets(
        pieces.filter((artifact) => !!artifactsById[artifact.setKey])
      ),
    };
  });
  const team = tryTeamBuild(configs, setupConfig, context);
  if (!team) return null;
  const combo = compositionObjective(
    objective,
    singleFormula,
    team,
    teamCharIds
  );
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
      buildBuffOverrides(combo.lines, team, sheets, context, userBuffOverrides)
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
    })),
    damage: account.damage,
    ratio: account.damage / referenceDamage,
    origin,
  };
  const key = candidateKey(candidate);
  const listed = state.byGear.get(key);
  if (listed) return listed;
  state.byGear.set(key, candidate);
  state.candidates.push(candidate);
  state.sources.set(candidate.id, source);
  return candidate;
}

interface ScreenedComposition {
  job: TeamSetsJob;
  /** Outcomes to optimize, best first. */
  order: number[];
  outcomes: SetAssignmentOutcome[];
  best: number;
}

/**
 * Compositions worth screening: the best on generated artifacts at their
 * current sets, the best without each member of it that some composition
 * leaves out, then the next best.
 */
function pickCompositions(
  ranked: readonly { job: TeamSetsJob; damage: number }[]
): TeamSetsJob[] {
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

/** Screens a composition's sets and orders its finalists, best first. */
async function screenComposition(
  job: TeamSetsJob
): Promise<ScreenedComposition | null> {
  const output = await runSetConfigScreen(job.screen, () => {});
  if (!output) return null;
  const { outcomes, currentIndex } = output;
  const score = (outcome: SetAssignmentOutcome) =>
    outcome.generatedDamage ?? null;
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
  return {
    job,
    outcomes,
    best,
    order: [best, ...finalists.filter((i) => i !== best)],
  };
}

async function generateTaskCandidates(
  state: SolverState,
  task: Task,
  progress: (stage: LineupSolverStage, done: number, total: number) => void
): Promise<LineupIssueReason | null> {
  const { request, chars } = state;
  const account = request.accountData;
  const { template, teamComp, setupConfig } = task.team;
  const contexts = encounterContexts(setupConfig, task.encounter);
  const teamConfigs = buildTeamSlotConfigs(teamComp, setupConfig, account);
  const teamBuild = tryTeamBuild(teamConfigs, setupConfig, contexts.display);
  if (!teamBuild) return "no-objective";
  const objective = resolveTeamObjective(setupConfig.damage, teamBuild);
  if (objective.lines.length === 0) return "no-objective";
  const singleFormula =
    (setupConfig.damage?.formulaMode ?? "single") === "single";
  const userBuffOverrides = extractComboOverrides(
    request.comboOverrides,
    objective.id
  );
  const teamCharIds = teamConfigs.map((config) => config.charId);
  const referenceDamage = scoreReference(
    task.calibration.reference,
    task,
    objective,
    singleFormula,
    teamCharIds,
    contexts.display,
    userBuffOverrides
  );
  if (referenceDamage == null) return "reference-unscored";

  const traits = (charId: string) => getCharacterTraits(charId, chars);
  const jobs: TeamSetsJob[] = [];
  for (const composition of templateCompositions(
    template,
    teamComp,
    traits
  ).slice(0, LINEUP_RANKED_COMPOSITIONS)) {
    const fielded = fieldComposition(template, teamComp, composition, account);
    if (!fielded) continue;
    const configs = buildTeamSlotConfigs(fielded, setupConfig, account);
    if (configs.length !== composition.length) continue;
    const team = tryTeamBuild(configs, setupConfig, contexts.display);
    const combo =
      team && compositionObjective(objective, singleFormula, team, teamCharIds);
    if (!combo) continue;
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
            timeBudgetSec: request.timeBudgetSec,
          },
        },
        chars
      );
      if (setup.kind === "ready") jobs.push(setup.job);
    } catch {
      /* A composition the calculator cannot build is skipped. */
    }
  }
  if (jobs.length === 0) return "no-composition";

  const screenSteps =
    jobs.length + Math.min(jobs.length, LINEUP_SCREENED_COMPOSITIONS);
  const ranked: { job: TeamSetsJob; damage: number }[] = [];
  for (const [index, job] of jobs.entries()) {
    progress("screen", index, screenSteps);
    const sheets = await generateAssignmentSheets(job.screen, job.current);
    const damage = sheets
      ? evaluateAssignment(job.screen, job.current, sheets)
      : null;
    if (damage != null) ranked.push({ job, damage });
  }
  ranked.sort((a, b) => b.damage - a.damage);
  const picked = pickCompositions(ranked);
  if (picked.length === 0) return "no-composition";

  const screened: ScreenedComposition[] = [];
  for (const [index, job] of picked.entries()) {
    progress("screen", jobs.length + index, screenSteps);
    const entry = await screenComposition(job);
    if (entry) screened.push(entry);
  }
  if (screened.length === 0) return "no-composition";
  screened.sort(
    (a, b) =>
      (b.outcomes[b.best].generatedDamage ?? 0) -
      (a.outcomes[a.best].generatedDamage ?? 0)
  );

  // Round-robin: every composition's best, then each one's next finalist.
  const runs: { entry: ScreenedComposition; index: number }[] = [];
  for (let rank = 0; runs.length < state.runCount; rank++) {
    const next = screened.filter((entry) => rank < entry.order.length);
    if (next.length === 0) break;
    for (const entry of next)
      if (runs.length < state.runCount)
        runs.push({ entry, index: entry.order[rank] });
  }

  let found = 0;
  for (const [done, { entry, index }] of runs.entries()) {
    progress("optimize", done, runs.length);
    const assignment = entry.outcomes[index].assignment;
    const outcome = await optimizeAssignmentOnAccount(
      entry.job,
      assignment,
      state.runMs
    );
    const source = { task, job: entry.job, assignment, referenceDamage };
    if (addCandidate(state, source, entry.job.configs, outcome, "search"))
      found++;
  }
  return found > 0 ? null : "no-candidate";
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
  const assignment = screened.outcomes[screened.best].assignment;
  const outcome = await optimizeAssignmentOnAccount(
    setup.job,
    assignment,
    state.runMs,
    new Set(excludedIds)
  );
  return addCandidate(
    state,
    { ...source, job: setup.job, assignment },
    setup.job.configs,
    outcome,
    "pieces-excluded"
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
 * The candidate kept clear of `other`'s pieces (re-run) and of the weapon
 * copies it needs (swapped). Null when a clear version cannot be found.
 */
async function keepClear(
  state: SolverState,
  candidate: LineupCandidate,
  other: LineupCandidate
): Promise<LineupCandidate | null> {
  const source = state.sources.get(candidate.id);
  if (!source) return null;
  let clear: LineupCandidate | null = candidate;
  if (
    findContestedGear(candidate, other, state.weaponCopies).artifactIds.length >
    0
  ) {
    const excluded = candidateArtifactIds(other);
    const key = `${candidate.id}|${[...excluded].sort().join(",")}`;
    if (!state.reruns.has(key))
      state.reruns.set(key, await rerunWithout(state, source, excluded));
    clear = state.reruns.get(key) ?? null;
  }
  if (!clear) return null;
  return findContestedGear(clear, other, state.weaponCopies).weaponIds.length >
    0
    ? swapContestedWeapons(state, clear, other)
    : clear;
}

/**
 * Leading candidates of different encounters in a group that share pieces
 * or weapon copies but no character, most promising first.
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
          const contested = findContestedGear(a, b, state.weaponCopies);
          if (
            contested.charIds.length === 0 &&
            (contested.artifactIds.length > 0 || contested.weaponIds.length > 0)
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
 * leaves alone characters every candidate of a later encounter needs, when
 * it can.
 */
async function chainLineup(
  state: SolverState,
  group: readonly Encounter[],
  strength: (candidate: LineupCandidate) => number,
  weakestFirst: boolean,
  step: () => void
): Promise<void> {
  const on = (encounterId: string) =>
    state.candidates.filter(
      (candidate) => candidate.encounterId === encounterId
    );
  const strongest = (candidates: readonly LineupCandidate[]) =>
    [...candidates].sort((a, b) => strength(b) - strength(a))[0];
  /** Characters in every candidate of the encounter. */
  const required = (encounterId: string) => {
    const [first, ...rest] = on(encounterId).map(
      (candidate) => new Set(candidate.members.map((member) => member.charId))
    );
    return first
      ? [...first].filter((charId) => rest.every((set) => set.has(charId)))
      : [];
  };
  const order = [...group].sort((a, b) => {
    const gap =
      (strongest(on(a.id)) ? strength(strongest(on(a.id))) : 0) -
      (strongest(on(b.id)) ? strength(strongest(on(b.id))) : 0);
    return weakestFirst ? gap : -gap;
  });
  const pick = (index: number, taken: ReadonlySet<string>) => {
    const free = on(order[index].id).filter(
      (candidate) =>
        !candidate.members.some((member) => taken.has(member.charId))
    );
    const reserved = new Set(
      order.slice(index + 1).flatMap((encounter) => required(encounter.id))
    );
    return (
      strongest(
        free.filter(
          (candidate) =>
            !candidate.members.some((member) => reserved.has(member.charId))
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
    if (!candidate) return;
    if (lineup.length === 0) {
      lineup.push(candidate);
      continue;
    }
    step();
    const clear = await keepClear(state, candidate, combined(lineup));
    if (!clear) return;
    lineup.push(clear);
  }
}

/**
 * Alternatives that keep clear of other encounters' gear. In each group,
 * leading candidates that share pieces or weapon copies but no character are
 * fixed both ways, the most promising pairs first. A group of three or more
 * also gets two encounter-by-encounter lineups, weakest and strongest first,
 * so at least one full lineup fits together.
 */
async function diversify(
  state: SolverState,
  progress: (done: number, total: number) => void
): Promise<void> {
  // Margins where the clears give one, so encounters compare; r otherwise.
  const margins = new Map(
    calibrateCandidates(
      state.candidates,
      state.request.calibrations,
      state.request.encounters
    ).map((candidate) => [candidate.id, candidate.margin])
  );
  const strength = (candidate: LineupCandidate) =>
    margins.get(candidate.id) ?? candidate.ratio;
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
    if (group.length >= 3)
      for (const weakestFirst of [true, false])
        await chainLineup(state, group, strength, weakestFirst, step);
    for (const [candidate, other] of fixes[index]) {
      step();
      await keepClear(state, candidate, other);
    }
  }
}

export async function runLineupSolver(
  request: LineupSolverRequest,
  chars: CharacterStatsMap,
  weapons: WeaponStatsMap,
  report: Report
): Promise<void> {
  const tasks = collectTasks(request);
  if (tasks.length === 0) {
    report({ type: "error", reason: "no-calibrations" });
    return;
  }
  const budgetMs = Math.max(1, request.timeBudgetSec) * 1000;
  const runCount = Math.min(
    LINEUP_MAX_RUNS,
    Math.max(1, Math.floor(budgetMs / SET_MIN_RUN_MS))
  );
  const state: SolverState = {
    request,
    chars,
    weapons,
    weaponCopies: countWeaponCopies(request.accountData),
    runCount,
    runMs: budgetMs / runCount,
    candidates: [],
    issues: [],
    sources: new Map(),
    byGear: new Map(),
    reruns: new Map(),
  };
  const snapshot = (partial: boolean): LineupSolverResult => ({
    candidates: [...state.candidates],
    issues: [...state.issues],
    weaponCopies: state.weaponCopies,
    partial,
  });

  for (const [index, task] of tasks.entries()) {
    let reason: LineupIssueReason | null;
    try {
      reason = await generateTaskCandidates(state, task, (stage, done, total) =>
        report({
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
    }
    if (reason)
      state.issues.push({
        templateId: task.team.template.id,
        encounterId: task.encounter.id,
        reason,
      });
    report({ type: "partial", result: snapshot(true) });
  }

  await diversify(state, (done, total) =>
    report({
      type: "progress",
      stage: "diversify",
      task: tasks.length,
      tasks: tasks.length,
      done,
      total,
    })
  );
  report({ type: "result", result: snapshot(false) });
}
