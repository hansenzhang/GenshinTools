import type { BuffActivationMap } from "@/domain/combat/damage/types";
import type { Slot } from "@/domain/enums";
import type {
  AccountData,
  ArtifactData,
  ArtifactSetConfig,
} from "@/domain/models";
import type {
  Calibration,
  Encounter,
  EncounterMode,
  TeamTemplate,
} from "./lineupTypes";
import type {
  OptRunPosition,
  OptRunSpan,
  SetAssignment,
} from "./setConfigExplorerTypes";
import type { OptFailReason, TeamComp, TeamSetupConfig } from "./types";

// ─── Candidates ───

/** One member of a candidate team, with the gear it was scored on. */
export interface LineupMember {
  charId: string;
  weaponId: string;
  refinement: number;
  /** Sets the pieces form. */
  artifactSet: ArtifactSetConfig | null;
  artifacts: Record<Slot, ArtifactData | null>;
  /** Only the set matters: the member's stats don't move damage, so any
   *  pieces that form its set serve, and its own pieces aren't contested. */
  anyPieces: boolean;
}

/**
 * How a candidate was found: the recorded build itself, the set search, a
 * re-run without pieces a team on the other half uses, or the same pieces
 * with a weapon that team needs replaced.
 */
export type CandidateOrigin =
  | "recorded"
  | "search"
  | "pieces-excluded"
  | "weapon-swapped";

/**
 * One way to field a template against an encounter from the account.
 * Members, pieces and weapon copies are exclusive within a lineup.
 */
export interface LineupCandidate {
  id: string;
  templateId: string;
  encounterId: string;
  members: LineupMember[];
  /** Rotation damage under the encounter's enemy. */
  damage: number;
  /** Model DPS ratio r against the calibrated reference build. Both share
   *  the template's rotation seconds, so this is the damage ratio. */
  ratio: number;
  origin: CandidateOrigin;
}

/** A candidate's predicted clear against the recorded clear and the bar. */
export interface CandidateClear {
  /** r · (T_req − D) / (T_meas − D); 1 meets the bar exactly. */
  margin: number;
  /** Predicted seconds spent dealing damage: (T_meas − D) / r. */
  activeSeconds: number;
  downtimeSeconds: number;
  barSeconds: number;
}

export type CalibratedCandidate = LineupCandidate & CandidateClear;

// ─── Explaining a lineup ───

/** A character, piece or weapon a lineup uses. */
export interface LineupGear {
  kind: "character" | "artifact" | "weapon";
  /** Character id, artifact id or weapon key. */
  id: string;
}

/**
 * Gear the lineup uses that another encounter's candidates also want, with
 * the lineup's margin after losing it: the gear removed, or one weapon copy
 * fewer. Null when no lineup is left.
 */
export interface BindingItem extends LineupGear {
  marginWithout: number | null;
}

// ─── Abyss plans ───

/**
 * Per half: each half's margin is compared, weakest first. Shared: both
 * halves count against one chamber timer, so only the summed time matters.
 */
export type AbyssTimerRule = "per-half" | "shared";

/** Candidates fielded together in one chamber. */
export interface AbyssPairing {
  /** Candidate id per half; null where the chamber has no candidate there. */
  firstId: string | null;
  secondId: string | null;
  /** The weaker half's margin, or the chamber margin under a shared timer. */
  margin: number;
}

export interface AbyssChamberPlan {
  chamber: number;
  firstEncounterId: string | null;
  secondEncounterId: string | null;
  /** Best first; empty when no candidates can be fielded together. */
  pairings: AbyssPairing[];
  /** Each half's best margin on its own, ignoring the other half. */
  bestAlone: { first: number | null; second: number | null };
  /** Contested gear of the best pairing, most costly to lose first. */
  binding: BindingItem[];
}

// ─── Stygian plans ───

/**
 * Leximin: the weakest boss's margin as high as possible, then the next.
 * Shortfall: when no lineup clears every boss, the smallest total shortfall.
 */
export type StygianPlanKind = "leximin" | "shortfall";

/** Three teams locked for a whole Stygian run, one per boss. */
export interface StygianPlan {
  kind: StygianPlanKind;
  /** Chosen candidate per encounter id. */
  candidateIds: Record<string, string>;
  /** Lowest margin among the bosses. */
  weakest: number;
}

export interface StygianPlanRequest {
  encounterIds: string[];
  candidates: CalibratedCandidate[];
  weaponCopies: Record<string, number>;
  /** Owned pieces per set and slot; without them, members that take any
   *  pieces of a set are not bounded. */
  setSlotCounts?: Record<string, number>;
  tiePercent: number;
}

/** One more piece of a set and slot that members taking any pieces of the
 *  set need, and the best weakest margin with it. Any stats will do. */
export interface MissingPiece {
  setKey: string;
  slot: Slot;
  /** Pieces of the set and slot owned now. */
  owned: number;
  marginWith: number;
}

export interface StygianPlanResult {
  /** The shortfall plan when no lineup clears and it differs, then the
   *  leximin plan. */
  plans: StygianPlan[];
  /** Encounters without a candidate; the plans leave them out. */
  missingEncounterIds: string[];
  /** Contested gear of the leximin plan, most costly to lose first. */
  binding: BindingItem[];
  /** Pieces that would raise the weakest margin past the tie, most first. */
  missingPieces: MissingPiece[];
}

export type StygianPlanMessage =
  | { type: "result"; id: number; result: StygianPlanResult }
  | { type: "error"; id: number; details: string };

// ─── Levelling advice ───

/** Levelling one piece to max level and wearing it in a member's slot. */
export interface LevellingPiece {
  charId: string;
  slot: Slot;
  /** The piece to level, as it is now. */
  artifact: ArtifactData;
  /** The piece the member wears in that slot now; the same piece when it
   *  is the one to level. */
  replaces: ArtifactData | null;
  toLevel: number;
  /** Chance the team's damage rises by more than the margin tie. */
  beatChance: number;
  /** Chance the team's damage rises at all. */
  gainChance: number;
  /** E[max(0, gain)]: the expected relative damage gain when a result
   *  worse than the current piece is not worn. */
  expectedGain: number;
}

export type LevellingStepKind = "level" | "auto" | "skill" | "burst";

/** One character level tier or one talent level up; certain. */
export interface LevellingStep {
  charId: string;
  kind: LevellingStepKind;
  from: number;
  to: number;
  /** Relative damage gain. */
  gain: number;
  /** The lineup already scores the member at `to`: the account level is
   *  below its tier (Lv 89 counts as 90), so margins include this gain. */
  assumed: boolean;
}

export interface LevellingAdvice {
  candidateId: string;
  /** The team's damage on its pieces as they are: the candidate's damage,
   *  unless the run scored pieces as levelled. */
  damage: number;
  /** Best option per member and slot, most likely to beat the current piece
   *  first, then options under the tie by expected gain. */
  pieces: LevellingPiece[];
  /** Steps that raise damage, largest gain first. */
  steps: LevellingStep[];
}

export interface LevellingRequest {
  /** The run the candidate came from: account, teams, encounters, clears. */
  solver: LineupSolverRequest;
  candidate: LineupCandidate;
  /** The lineup's other teams; their exact pieces stay where they are. */
  others: LineupCandidate[];
}

export type LevellingMessage =
  | { type: "result"; id: number; advice: LevellingAdvice | null }
  | { type: "error"; id: number; details: string };

// ─── Solver job ───

export interface LineupSolverTeam {
  template: TeamTemplate;
  teamComp: TeamComp;
  setupConfig: TeamSetupConfig;
}

export interface LineupSolverRequest {
  /** Which encounters the run fields candidates for. */
  mode: EncounterMode;
  accountData: AccountData;
  encounters: Encounter[];
  teams: LineupSolverTeam[];
  calibrations: Calibration[];
  /** User buff activations by combo, as the buff override store keys them. */
  comboOverrides: Record<string, BuffActivationMap>;
  /** Real-inventory time per template and encounter; null runs every
   *  finalist until its search finishes. */
  timeBudgetSec: number | null;
  /** Pieces members whose pieces matter may use (locked, recommended to
   *  lock, or in a recorded build); absent uses every piece. Members whose
   *  pieces don't matter may always use any piece. */
  keeperArtifactIds?: string[];
  /** Score every 4★ and 5★ piece below max level as levelled, with its
   *  expected rolls; absent scores pieces as they are. Results still carry
   *  the real pieces. */
  levelToMax?: boolean;
}

/** Why a template's calibrated encounter produced no candidates. */
export type LineupIssueReason =
  | "no-objective"
  | "reference-unscored"
  | "no-composition"
  | "no-candidate"
  | "calculator-error";

export interface LineupIssue {
  templateId: string;
  encounterId: string;
  reason: LineupIssueReason;
}

// ─── Solver trace ───

/** Why the job optimized an assignment on the account: the recorded build's
 *  sets, a search finalist, or a re-run without pieces another encounter's
 *  candidate uses. */
export type LineupRunKind = "recorded-sets" | "search" | "pieces-excluded";

/** A real-inventory optimization as it starts. */
export interface LineupRunStart {
  kind: LineupRunKind;
  templateId: string;
  encounterId: string;
  charIds: string[];
  assignment: SetAssignment;
  /** Team damage on generated artifacts fitted to the assignment. */
  generatedDamage: number | null;
  /** Team damage on the account's best pieces for the assignment. */
  accountEstimate: number | null;
  /** Pieces kept out of every member's pool. */
  excludedArtifactCount: number;
  /** Time the run was given; null when it ran until done. */
  runMs: number | null;
  /** When it started (epoch ms). */
  startedAt: number;
}

/** One real-inventory optimization, as the debug export reports it. */
export interface LineupRunTrace extends LineupRunStart {
  elapsedMs: number;
  /** Where the time went, in order. */
  phases: OptRunSpan[];
  /** Time until each member's per-character search finished, when the
   *  searches ran in parallel. */
  memberSearchMs: Record<string, number>;
  /** Damage of the pieces found, with the sets they form; null if unreachable. */
  damage: number | null;
  realized: SetAssignment;
  failReasons: Record<string, OptFailReason>;
  unmetCharIds: string[];
  /** Members the optimizer filled from leftover pieces. */
  saturatedCharIds: string[];
  /** Substat weights each member's pieces were ranked with. */
  substatWeights: Record<string, Record<string, number>>;
  /** The candidate it gave, or the listed one with the same gear. */
  candidateId: string | null;
}

/** One template against one encounter, before its real-inventory runs. */
export interface LineupTaskTrace {
  templateId: string;
  encounterId: string;
  referenceDamage: number | null;
  /** Sets the recorded build's pieces form. */
  referenceSets: SetAssignment;
  /** Compositions at their current sets, strongest on the account first. */
  compositions: {
    charIds: string[];
    generatedDamage: number;
    accountEstimate: number | null;
  }[];
  /** Time spent ranking compositions and screening their sets. */
  screenMs: number;
  /** Screened compositions with their finalists, in the order runs are
   *  taken. */
  screens: {
    charIds: string[];
    outcomes: {
      assignment: SetAssignment;
      generatedDamage: number | null;
      accountEstimate: number | null;
    }[];
  }[];
}

/** Final stats of a member, universal values under the encounter. */
export type LineupMemberStats = Record<string, number>;

/** Which diversify pass kept candidates clear of each other's gear: a
 *  boss-by-boss lineup, weakest or strongest boss first, or the pairwise
 *  fixes. */
export type LineupDiversifyPass = "weakest-first" | "strongest-first" | "pairs";

/** What one diversify pass of one encounter group found. */
export interface LineupDiversifyTrace {
  pass: LineupDiversifyPass;
  encounterIds: string[];
  /** A boss-by-boss lineup's candidates in pick order; shorter than the
   *  group when a pick had no candidate clear of the earlier ones. Empty for
   *  the pairwise fixes. */
  lineupIds: string[];
  /** Candidates its re-runs and weapon swaps gave, including ones an earlier
   *  pass had already found. */
  clearIds: string[];
}

export interface LineupSolverTrace {
  tasks: LineupTaskTrace[];
  runs: LineupRunTrace[];
  /** The run in progress, so a stopped job shows where it was. */
  inFlight: LineupRunStart | null;
  /** Stats per candidate id, then per member. */
  memberStats: Record<string, Record<string, LineupMemberStats>>;
  diversify: LineupDiversifyTrace[];
}

export interface LineupSolverResult {
  candidates: LineupCandidate[];
  issues: LineupIssue[];
  /** Owned copies per weapon, which bound how many members can use one. */
  weaponCopies: Record<string, number>;
  /** Owned pieces per set and slot (`setSlotKey`), which bound members
   *  that take any pieces of a set. */
  setSlotCounts: Record<string, number>;
  /** How the candidates were found, for the debug export. */
  trace: LineupSolverTrace;
  partial: boolean;
}

/** The plan a lineup run's results were shown with. */
export type LineupDebugPlan =
  | { mode: "abyss"; chambers: AbyssChamberPlan[] }
  | { mode: "stygian"; result: StygianPlanResult | null };

/**
 * A lineup run saved for troubleshooting: its inputs, which replay on their
 * own (the request carries the account), and what it found.
 */
export interface LineupDebugExport {
  format: string;
  version: number;
  exportedAt: string;
  request: LineupSolverRequest;
  result: LineupSolverResult;
  /** Candidates with margins from the clears at export time. */
  calibrated: CalibratedCandidate[];
  plan: LineupDebugPlan;
}

/** A debug export read back: the run, or why it cannot be shown. */
export type LineupDebugRead =
  | { kind: "run"; data: LineupDebugExport }
  | { kind: "not-export" }
  | { kind: "unsupported-version"; version: number };

export type LineupSolverStage = "screen" | "optimize" | "diversify";

/** Where the real-inventory run in progress is, and when it started
 *  (epoch ms). */
export interface LineupRunProgress extends OptRunPosition {
  startedAt: number;
}

export type LineupSolverFailure = "no-calibrations" | "calculator-error";

export type LineupSolverMessage =
  | {
      type: "progress";
      stage: LineupSolverStage;
      /** Template–encounter pair in progress, and how many there are. */
      task: number;
      tasks: number;
      done: number;
      total: number;
      /** Set while a real-inventory run is in progress. */
      run?: LineupRunProgress;
    }
  | { type: "partial"; result: LineupSolverResult }
  | { type: "result"; result: LineupSolverResult }
  | { type: "error"; reason: LineupSolverFailure; details?: string };
