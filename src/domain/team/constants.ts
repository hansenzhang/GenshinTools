import type { StatKey } from "@/domain/enums";

export const CUSTOM_STAT_OPTIONS: StatKey[] = [
  "atk",
  "hp",
  "def",
  "em",
  "atk%",
  "hp%",
  "def%",
  "er",
  "cr",
  "cd",
  "pyro%",
  "hydro%",
  "anemo%",
  "electro%",
  "dendro%",
  "cryo%",
  "geo%",
  "phys%",
  "dmg%",
  "reactionDmg%",
  "baseDmg%",
  "baseDmg",
  "defReduction%",
  "defIgnore%",
  "resReduction%",
];

/** RES of most enemies; an encounter uses it for elements it does not list. */
export const DEFAULT_ENCOUNTER_RES = 0.1;

/** Stygian Onslaught Fearless difficulty: tier 5 in the boss archive. */
export const STYGIAN_FEARLESS_TIER = 5;
