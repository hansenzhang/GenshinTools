import type { TeamSlotConfig } from "@/domain/combat/damage/types";
import type { Element, ElementalOrPhysical } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";

// ─── Encounters ───

export type EncounterMode = "abyss" | "stygian";

interface EncounterBase {
  id: string;
  enemyLevel: number;
  /** Base RES per element as fractions (0.1 = 10%). Missing elements use
   *  DEFAULT_ENCOUNTER_RES. */
  res: Partial<Record<ElementalOrPhysical, number>>;
  /** Free-text note on target count, waves and grouping. */
  targets: string;
  /** Estimated seconds in a clear without damage: waves, travel, immune phases. */
  downtimeSeconds: number;
  /** Longest clear that still meets the bar, in seconds: the third-star
   *  remaining-time condition for an Abyss half, the time limit for a
   *  Stygian boss. Null until entered. */
  timeBarSeconds: number | null;
}

/** One half of a Spiral Abyss chamber. */
export interface AbyssEncounter extends EncounterBase {
  mode: "abyss";
  chamber: number;
  half: 1 | 2;
}

/** One Stygian Onslaught boss. */
export interface StygianEncounter extends EncounterBase {
  mode: "stygian";
  /** Boss in the Stygian Onslaught archive the level and RES came from. */
  bossId: number;
}

export type Encounter = AbyssEncounter | StygianEncounter;

// ─── Team templates ───

/** A composition must field at least `min` characters of a kind. */
export type CompositionRule =
  | { kind: "element"; element: Element; min: number }
  | { kind: "moonsign"; min: number };

/**
 * A team that may vary in its flex slots. The linked Analysis team supplies
 * the core characters, rotation, rotation seconds, buffs and settings.
 */
export interface TeamTemplate {
  id: string;
  teamId: string;
  /** Alternatives per team slot (index 0–3), in addition to the team's own
   *  character in that slot. Slots without alternatives are core. */
  flexBySlot: string[][];
  rules: CompositionRule[];
}

/** One character per filled team slot, in slot order. */
export type TemplateComposition = string[];

// ─── Calibration ───

/** The equipment a measured clear was played with, saved by value. */
export interface ReferenceBuild {
  capturedAt: number;
  slots: TeamSlotConfig[];
  artifactsByChar: Record<string, ArtifactData[]>;
}

/**
 * One measured clear of a template's team against an encounter. It anchors
 * the template's model DPS to the encounter's bar.
 */
export interface Calibration {
  id: string;
  templateId: string;
  encounterId: string;
  reference: ReferenceBuild;
  /** Measured clear time T_meas in seconds. */
  measuredSeconds: number;
  /** Downtime D of this clear; null uses the encounter's estimate. */
  downtimeSeconds: number | null;
}

export interface CalibrationTimes {
  measured: number;
  downtime: number;
  bar: number;
}
