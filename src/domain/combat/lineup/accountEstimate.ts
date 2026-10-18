/**
 * Valuing a member's real pieces (docs/design/lineup-solver.md, P3 fixes).
 * Generated artifacts show what a set does with ideal pieces; the account's
 * own pieces, valued here and picked by `pickForChoice`, show what it does on
 * this account, so a set owned only as fodder ranks where it belongs.
 *
 * Pieces are valued in damage units: the member's marginal damage per stat
 * point at an operating point, times the piece's stats.
 */

import { MAIN_STAT_VALUES_5STAR } from "@/config/gameConstants";
import { AVG_SUBSTAT_ROLL } from "@/domain/build/artifact/scoring/constants";
import { toInternal } from "@/domain/build/artifact/scoring/utils";
import type { StatKey } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import { StatSheet } from "../damage/core/statSheet";
import { getArtifactStats } from "../optimizer/artifactScoring";

/** Marginal damage per internal unit of each stat. */
export type StatWeights = Partial<Record<StatKey, number>>;

/** Stats only main stats carry; substats are stepped by one average roll. */
const MAIN_ONLY_KEYS = [
  "pyro%",
  "hydro%",
  "anemo%",
  "electro%",
  "dendro%",
  "cryo%",
  "geo%",
  "phys%",
  "heal%",
] as const satisfies readonly StatKey[];

/** A main-only stat is stepped by this share of its 5★ +20 value. */
const MAIN_STEP_SHARE = 0.25;

const STEPS: [StatKey, number][] = [
  ...(Object.entries(AVG_SUBSTAT_ROLL) as [StatKey, number][]),
  ...MAIN_ONLY_KEYS.map((key): [StatKey, number] => [
    key,
    toInternal(key, MAIN_STAT_VALUES_5STAR[key]) * MAIN_STEP_SHARE,
  ]),
];

/**
 * The member's marginal damage per internal stat unit at these sheets, with
 * teammates held. Stats that don't raise damage are left out.
 */
export function memberStatWeights(
  evalFn: (sheets: Record<string, StatSheet>) => number,
  sheets: Record<string, StatSheet>,
  charId: string
): StatWeights {
  const base = evalFn(sheets);
  const own = sheets[charId] ?? new StatSheet([]);
  const weights: StatWeights = {};
  for (const [key, step] of STEPS) {
    const gain =
      evalFn({ ...sheets, [charId]: own.withDelta(key, step) }) - base;
    if (gain > 0) weights[key] = gain / step;
  }
  return weights;
}

/** Damage one average roll of every substat adds: how much pieces matter. */
export function statSensitivity(weights: StatWeights): number {
  return (Object.entries(AVG_SUBSTAT_ROLL) as [StatKey, number][]).reduce(
    (sum, [key, roll]) => sum + (weights[key] ?? 0) * roll,
    0
  );
}

export function pieceValue(artifact: ArtifactData, weights: StatWeights) {
  let value = 0;
  for (const [key, amount] of Object.entries(getArtifactStats(artifact)))
    value += (weights[key as StatKey] ?? 0) * (amount ?? 0);
  return value;
}
