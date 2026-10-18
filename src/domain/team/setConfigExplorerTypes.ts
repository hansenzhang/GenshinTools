import type {
  BuffActivationMap,
  CalcContext,
  ComboFormula,
} from "@/domain/combat/damage/types";
import type { Slot } from "@/domain/enums";
import type {
  AccountData,
  ArtifactData,
  ArtifactSetConfig,
} from "@/domain/models";
import type {
  ArtifactInventoryReuseMode,
  ReservedArtifactTeam,
} from "./artifactInventory";
import type {
  OptFailReason,
  OptPhase,
  TeamComp,
  TeamSetupConfig,
} from "./types";

/** Set goal per member, keyed by character id; `null` means no set goal. */
export type SetAssignment = Record<string, ArtifactSetConfig | null>;

export interface SetConfigExplorerSettings {
  /** Optimize finalists on the account's artifacts. */
  useAccountArtifacts: boolean;
  /** Members whose current set goal is kept. */
  lockedCharIds: string[];
  /** Choices always compared, per member. */
  pinned: Record<string, ArtifactSetConfig[]>;
  /** Total time for the real-inventory stage. */
  timeBudgetSec: number;
}

export interface SetConfigExplorerRequest {
  teamComp: TeamComp;
  setupConfig: TeamSetupConfig;
  accountData: AccountData | null;
  /** Combo lines with count > 0; buff defaults are rebuilt per assignment. */
  objective: ComboFormula;
  /** User buff activations for the objective, keyed by formula. */
  userBuffOverrides?: Record<string, BuffActivationMap>;
  carryCharId: string;
  /** Context used to search (includes per-character CR targets). */
  optimizeContext: CalcContext;
  /** Context used for every displayed damage number. */
  displayContext: CalcContext;
  settings: SetConfigExplorerSettings;
  perCharExcludedArtifactIds?: Record<string, string[]>;
  /** Pieces members may use, except `openCharIds`, who may use any. */
  keepers?: { ids: ReadonlySet<string>; openCharIds: readonly string[] };
  inventoryReservations?: {
    teams: Record<string, ReservedArtifactTeam>;
    reuseMode: ArtifactInventoryReuseMode;
    standaloneIds: string[];
  };
}

export interface SetAccountOutcome {
  /** Damage of the found pieces with the sets they form; null if unreachable. */
  damage: number | null;
  /** Sets the found pieces actually form. */
  realized: SetAssignment;
  artifactsByChar: Record<string, Record<Slot, ArtifactData | null>>;
  failReasons: Record<string, OptFailReason>;
  /** Members below their ER/CR requirement. */
  unmetCharIds: string[];
  /** What the optimizer reported, when the pieces came from a run. */
  diagnostics?: SetRunDiagnostics;
}

export interface SetRunDiagnostics {
  /** Members filled from leftover pieces, since their stats don't move damage. */
  saturatedCharIds: string[];
  /** Substat weights each member's pieces were ranked with. */
  substatWeights: Record<string, Record<string, number>>;
  /** Where the run's time went, in order. */
  phases: OptRunSpan[];
  /** Time from the run's start until each member's per-character search
   *  finished. Only parallel searches report it. */
  memberSearchMs: Record<string, number>;
}

/**
 * Time from one optimizer step to the next. `init` is setup before the
 * per-character search, `phase1` that search with its contested-piece
 * re-runs, `phase2` team allocation, and each `phase3` span one refinement
 * round (`round` from 1); the last also covers the final swaps and fills.
 */
export interface OptRunSpan {
  phase: OptPhase;
  round: number | null;
  ms: number;
}

/** Where a running optimization is; `searching` lists members whose
 *  per-character search is still running. */
export interface OptRunPosition {
  phase: OptPhase;
  round: number | null;
  searching: string[];
}

export interface SetAssignmentOutcome {
  assignment: SetAssignment;
  key: string;
  /** Team damage with fixed baseline sheets. */
  screenDamage: number;
  /** Team damage with generated artifacts fitted to this assignment. */
  generatedDamage?: number;
  /** Team damage on the account's best pieces for these sets; null when the
   *  account cannot form them or meet ER/CR. Absent when not estimated. */
  accountEstimate?: number | null;
  /** Members whose generated artifacts miss their ER requirement. */
  generatedErShortCharIds?: string[];
  account?: SetAccountOutcome;
}

export type SetOutcomeBasis = "screen" | "generated" | "account";

export interface SetChoiceRow {
  charId: string;
  choice: ArtifactSetConfig | null;
  key: string;
  /** Best evaluated assignment that gives this member this choice. */
  outcomeIndex: number;
  /** Highest stage that assignment reached. */
  basis: SetOutcomeBasis;
  pinned: boolean;
}

export interface SetConfigExplorerResult {
  basis: "generated" | "account";
  outcomes: SetAssignmentOutcome[];
  charIds: string[];
  currentIndex: number;
  bestIndex: number;
  rowsByChar: Record<string, SetChoiceRow[]>;
  /** Equipped pieces' damage when they are all available; floors "current". */
  equippedDamage: number | null;
  tiePercent: number;
  evaluated: number;
  skipped: number;
  partial: boolean;
}

export type SetConfigExplorerStage =
  | "screen"
  | "joint"
  | "generate"
  | "optimize";

export type SetConfigExplorerFailure =
  | "no-objective"
  | "no-account"
  | "no-members"
  | "no-results"
  | "calculator-error";

export type SetConfigExplorerMessage =
  | {
      type: "progress";
      stage: SetConfigExplorerStage;
      done: number;
      total: number;
    }
  | { type: "partial"; result: SetConfigExplorerResult }
  | { type: "result"; result: SetConfigExplorerResult }
  | { type: "error"; reason: SetConfigExplorerFailure; details?: string };
