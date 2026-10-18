import type { BuffActivationMap } from "@/domain/combat/damage/types";
import type { Slot } from "@/domain/enums";
import type {
  AccountData,
  ArtifactData,
  ArtifactSetConfig,
} from "@/domain/models";
import type { Calibration, Encounter, TeamTemplate } from "./lineupTypes";
import type { TeamComp, TeamSetupConfig } from "./types";

// ─── Candidates ───

/** One member of a candidate team, with the gear it was scored on. */
export interface LineupMember {
  charId: string;
  weaponId: string;
  refinement: number;
  /** Sets the pieces form. */
  artifactSet: ArtifactSetConfig | null;
  artifacts: Record<Slot, ArtifactData | null>;
}

/**
 * How a candidate was found: the set search, a re-run without pieces a team
 * on the other half uses, or the same pieces with a weapon that team needs
 * replaced.
 */
export type CandidateOrigin = "search" | "pieces-excluded" | "weapon-swapped";

/**
 * One way to field a template against an encounter from the account, with
 * its calibrated margin. Members, pieces and weapon copies are exclusive
 * within a lineup.
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
  /** r · (T_req − D) / (T_meas − D); 1 meets the bar exactly. */
  margin: number;
  /** Predicted seconds spent dealing damage: (T_meas − D) / r. */
  activeSeconds: number;
  downtimeSeconds: number;
  barSeconds: number;
  origin: CandidateOrigin;
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
}

// ─── Solver job ───

export interface LineupSolverTeam {
  template: TeamTemplate;
  teamComp: TeamComp;
  setupConfig: TeamSetupConfig;
}

export interface LineupSolverRequest {
  accountData: AccountData;
  encounters: Encounter[];
  teams: LineupSolverTeam[];
  calibrations: Calibration[];
  /** User buff activations by combo, as the buff override store keys them. */
  comboOverrides: Record<string, BuffActivationMap>;
  /** Real-inventory time per template and encounter. */
  timeBudgetSec: number;
}

/** Why a template's calibrated encounter produced no candidates. */
export type LineupIssueReason =
  | "no-bar"
  | "downtime-too-long"
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

export interface LineupSolverResult {
  candidates: LineupCandidate[];
  issues: LineupIssue[];
  /** Owned copies per weapon, which bound how many members can use one. */
  weaponCopies: Record<string, number>;
  partial: boolean;
}

export type LineupSolverStage = "screen" | "optimize" | "diversify";

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
    }
  | { type: "partial"; result: LineupSolverResult }
  | { type: "result"; result: LineupSolverResult }
  | { type: "error"; reason: LineupSolverFailure; details?: string };
