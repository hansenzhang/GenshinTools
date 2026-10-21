/**
 * Levelling advisor (docs/design/lineup-solver.md, P5): which unlevelled
 * pieces are worth levelling for a lineup's team, and what one more talent
 * or character level is worth.
 *
 * Roll odds are the game's documented mechanics, ported from Mistilteinn's
 * `upgradeDistribution` and `expectedRollsByStat`: one upgrade per +4
 * levels; below four lines an upgrade adds a line drawn by weight, otherwise
 * it raises one of the four uniformly; each roll is one of four tier values.
 *
 * A piece's fixed part (max-level main stat, its lines, a line the game has
 * shown) is scored exactly. Its rolls go through the member's marginal
 * damage per stat at that point, so their total gain is a convolution of
 * per-roll gains, exact up to the bin width.
 */

import { substatRollTiers } from "@/config/gameConstants";
import { toInternal } from "@/domain/build/artifact/scoring/utils";
import {
  allSlots,
  type Slot,
  type StatKey,
  type SubStat,
} from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import { getNextLevelTier } from "@/domain/reference/stats";
import type {
  LevellingPiece,
  LevellingStep,
  LineupMember,
} from "@/domain/team/lineupSolverTypes";
import type { SetAssignment } from "@/domain/team/setConfigExplorerTypes";
import { StatSheet } from "../damage/core/statSheet";
import type { TalentLevels, TeamSlotConfig } from "../damage/types";
import { getArtifactStats } from "../optimizer/artifactScoring";
import { memberStatWeights, type StatWeights } from "./accountEstimate";
import {
  LEVELLING_CHANCE_STEP,
  LEVELLING_GAIN_BIN,
  LEVELLING_MIN_GAIN,
  LEVELLING_SCREENED_PER_SLOT,
} from "./constants";
import { setChoiceKey } from "./setChoices";
import {
  evaluateAssignment,
  findUnmetMembers,
  formedSet,
  heldEvaluator,
  type SetScreenInput,
} from "./setConfigScreen";

// ─── Roll odds ───

/** Weight of each stat when an upgrade adds a line. */
const LINE_WEIGHTS: Record<SubStat, number> = {
  hp: 6,
  atk: 6,
  def: 6,
  "hp%": 4,
  "atk%": 4,
  "def%": 4,
  er: 4,
  em: 4,
  cr: 3,
  cd: 3,
};

const SUBSTATS = Object.keys(LINE_WEIGHTS) as SubStat[];

const MAX_LINES = 4;

const MAX_TALENT_LEVEL = 10;

/** Max level of a piece the advisor levels: 4★ and 5★ only. */
export function maxPieceLevel(rarity: number): number | null {
  return rarity === 5 ? 20 : rarity === 4 ? 16 : null;
}

/** Upgrades left: one per +4 level still ahead. */
export function upgradesLeft(artifact: ArtifactData): number {
  const max = maxPieceLevel(artifact.rarity);
  return max == null
    ? 0
    : Math.max(0, Math.floor(max / 4) - Math.floor(artifact.level / 4));
}

/** What levelling a piece leaves to chance. */
export interface PendingRolls {
  rarity: 4 | 5;
  mainStat: string;
  /** Lines once the lines the game has shown are activated. */
  lines: SubStat[];
  /** Upgrades still random. */
  rolls: number;
}

function currentLines(artifact: ArtifactData): SubStat[] {
  return (Object.keys(artifact.substats ?? {}) as SubStat[]).filter(
    (stat) => artifact.substats[stat] != null
  );
}

/** Lines the game has shown (GOOD's unactivated substats) that the next
 *  upgrades activate, in order. */
function shownLines(artifact: ArtifactData): SubStat[] {
  const lines = currentLines(artifact);
  const room = Math.min(upgradesLeft(artifact), MAX_LINES - lines.length);
  return (Object.keys(artifact.unactivatedSubstats ?? {}) as SubStat[])
    .filter(
      (stat) =>
        !lines.includes(stat) &&
        stat !== artifact.mainStatKey &&
        artifact.unactivatedSubstats?.[stat] != null
    )
    .slice(0, Math.max(0, room));
}

/** The piece at max level with its lines and the lines the game has shown:
 *  its fixed part, before any random roll. */
export function levelledPiece(artifact: ArtifactData): ArtifactData {
  const shown = shownLines(artifact);
  return {
    ...artifact,
    level: maxPieceLevel(artifact.rarity) ?? artifact.level,
    substats: {
      ...artifact.substats,
      ...Object.fromEntries(
        shown.map((stat) => [stat, artifact.unactivatedSubstats?.[stat]])
      ),
    },
    unactivatedSubstats: undefined,
  };
}

export function pendingRolls(artifact: ArtifactData): PendingRolls {
  const shown = shownLines(artifact);
  return {
    rarity: artifact.rarity === 4 ? 4 : 5,
    mainStat: artifact.mainStatKey,
    lines: [...currentLines(artifact), ...shown],
    rolls: upgradesLeft(artifact) - shown.length,
  };
}

/** Stats an upgrade may add as a line, with their draw weights. */
function linePool(
  mainStat: string,
  lines: readonly SubStat[]
): { stat: SubStat; p: number }[] {
  const pool = SUBSTATS.filter(
    (stat) => stat !== mainStat && !lines.includes(stat)
  );
  const total = pool.reduce((sum, stat) => sum + LINE_WEIGHTS[stat], 0);
  return pool.map((stat) => ({ stat, p: LINE_WEIGHTS[stat] / total }));
}

/** A stat's four roll values in stat-sheet units, lowest first. */
export function tierValues(stat: SubStat, rarity: 4 | 5): number[] {
  return substatRollTiers[rarity][stat].map((value) => toInternal(stat, value));
}

/**
 * Expected rolls each stat gets from the pending upgrades. A new line counts
 * as one roll on it, since it arrives with one tier value.
 */
export function expectedRollsByStat(
  pending: PendingRolls
): Partial<Record<SubStat, number>> {
  const out: Partial<Record<SubStat, number>> = {};
  const add = (stat: SubStat, amount: number) => {
    out[stat] = (out[stat] ?? 0) + amount;
  };
  const walk = (lines: readonly SubStat[], rolls: number, weight: number) => {
    if (rolls === 0) return;
    if (lines.length >= MAX_LINES) {
      // Uniform over the lines: rolls / lines each, by linearity.
      for (const stat of lines) add(stat, (weight * rolls) / lines.length);
      return;
    }
    for (const { stat, p } of linePool(pending.mainStat, lines)) {
      add(stat, weight * p);
      walk([...lines, stat], rolls - 1, weight * p);
    }
  };
  walk(pending.lines, pending.rolls, 1);
  return out;
}

/** A stat's mean roll value, in the piece's units. */
function meanRoll(stat: SubStat, rarity: 4 | 5): number {
  const tiers = substatRollTiers[rarity][stat];
  return tiers.reduce((sum, tier) => sum + tier, 0) / tiers.length;
}

/**
 * The piece at max level with its pending rolls at their expected value: its
 * mean stats once levelled. A piece at max level, or below 4★, is returned as
 * it is.
 */
export function expectedLevelledPiece(artifact: ArtifactData): ArtifactData {
  if (upgradesLeft(artifact) === 0) return artifact;
  const levelled = levelledPiece(artifact);
  const pending = pendingRolls(artifact);
  const substats = { ...levelled.substats };
  for (const [stat, rolls] of Object.entries(expectedRollsByStat(pending)) as [
    SubStat,
    number,
  ][])
    substats[stat] =
      (substats[stat] ?? 0) + rolls * meanRoll(stat, pending.rarity);
  return { ...levelled, substats };
}

// ─── Gain distributions ───

/** Probability by bin: bin k holds gains of about k · bin width. */
export type GainDistribution = Map<number, number>;

/** Probabilities below this are dropped while convolving. */
const NEGLIGIBLE = 1e-12;

function convolve(a: GainDistribution, b: GainDistribution): GainDistribution {
  const out: GainDistribution = new Map();
  for (const [ka, pa] of a)
    for (const [kb, pb] of b) {
      const p = pa * pb;
      if (p < NEGLIGIBLE) continue;
      out.set(ka + kb, (out.get(ka + kb) ?? 0) + p);
    }
  return out;
}

function addScaled(
  target: GainDistribution,
  source: GainDistribution,
  weight: number
): void {
  for (const [k, p] of source) target.set(k, (target.get(k) ?? 0) + p * weight);
}

/**
 * Distribution of the pending rolls' total gain. `tierGains` gives each
 * stat's gain for each of its four roll values.
 */
export function rollGainDistribution(
  pending: PendingRolls,
  tierGains: (stat: SubStat) => readonly number[],
  bin = LEVELLING_GAIN_BIN
): GainDistribution {
  const oneRoll = new Map<SubStat, GainDistribution>();
  const roll = (stat: SubStat) => {
    let distribution = oneRoll.get(stat);
    if (!distribution) {
      distribution = new Map();
      for (const gain of tierGains(stat)) {
        const k = Math.round(gain / bin);
        distribution.set(k, (distribution.get(k) ?? 0) + 0.25);
      }
      oneRoll.set(stat, distribution);
    }
    return distribution;
  };
  const memo = new Map<string, GainDistribution>();
  const walk = (lines: readonly SubStat[], rolls: number): GainDistribution => {
    if (rolls === 0) return new Map([[0, 1]]);
    const key = `${[...lines].sort().join(",")}|${rolls}`;
    const cached = memo.get(key);
    if (cached) return cached;
    let out: GainDistribution = new Map();
    if (lines.length >= MAX_LINES) {
      // The upgrade raises one of the lines, uniformly.
      const step: GainDistribution = new Map();
      for (const stat of lines) addScaled(step, roll(stat), 1 / lines.length);
      out = convolve(step, walk(lines, rolls - 1));
    } else {
      // The upgrade adds a line, drawn by weight, with one roll value.
      for (const { stat, p } of linePool(pending.mainStat, lines))
        addScaled(
          out,
          convolve(roll(stat), walk([...lines, stat], rolls - 1)),
          p
        );
    }
    memo.set(key, out);
    return out;
  };
  return walk(pending.lines, pending.rolls);
}

export interface LevellingOutcome {
  /** P(fixed gain + rolls' gain > bar). */
  beatChance: number;
  /** P(gain > 0). */
  gainChance: number;
  /** E[max(0, gain)]. */
  expectedGain: number;
}

export function summarizeOutcome(
  fixedGain: number,
  rolls: GainDistribution,
  bar: number,
  bin = LEVELLING_GAIN_BIN
): LevellingOutcome {
  let beatChance = 0;
  let gainChance = 0;
  let expectedGain = 0;
  for (const [k, p] of rolls) {
    const gain = fixedGain + k * bin;
    if (gain > bar) beatChance += p;
    if (gain > 0) {
      gainChance += p;
      expectedGain += p * gain;
    }
  }
  return {
    beatChance: Math.min(1, beatChance),
    gainChance: Math.min(1, gainChance),
    expectedGain,
  };
}

const chanceSteps = (chance: number) =>
  Math.round(chance / LEVELLING_CHANCE_STEP);

/** Whether the option has a chance, to the step, of beating the tie. */
export function beatsTie(piece: Pick<LevellingPiece, "beatChance">): boolean {
  return chanceSteps(piece.beatChance) >= 1;
}

/** Most likely to beat the current piece first; ties, and options that
 *  cannot beat it, by expected gain. */
export function compareLevellingPieces(
  a: LevellingPiece,
  b: LevellingPiece
): number {
  return (
    chanceSteps(b.beatChance) - chanceSteps(a.beatChance) ||
    b.expectedGain - a.expectedGain
  );
}

// ─── Advice ───

export interface LevellingInput {
  screen: SetScreenInput;
  /** The team's members as fielded, with their pieces. */
  members: readonly LineupMember[];
  /** Every owned piece. */
  artifacts: readonly ArtifactData[];
  /** Pieces another team of the lineup needs. */
  reservedIds: ReadonlySet<string>;
  /** Relative gain a piece has to exceed to beat the current one. */
  bar: number;
  /** Members' levels on the account, which configs score as their tier. */
  accountLevels: Readonly<Record<string, number>>;
}

type Pieces = Record<Slot, ArtifactData | null>;
type Sheets = Record<string, StatSheet>;

const sheetOf = (pieces: Partial<Pieces>) =>
  StatSheet.fromArtifacts(Object.values(pieces));

function linearValue(
  weights: StatWeights,
  stats: Partial<Record<StatKey, number>>
): number {
  let value = 0;
  for (const [key, amount] of Object.entries(stats))
    value += (weights[key as StatKey] ?? 0) * (amount ?? 0);
  return value;
}

function expectedRollValue(
  weights: StatWeights,
  pending: PendingRolls
): number {
  let value = 0;
  for (const [stat, rolls] of Object.entries(expectedRollsByStat(pending)) as [
    SubStat,
    number,
  ][])
    value +=
      (weights[stat] ?? 0) *
      rolls *
      toInternal(stat, meanRoll(stat, pending.rarity));
  return value;
}

/** The team as fielded: its sets, sheets and damage. */
interface Fielded {
  input: LevellingInput;
  assignment: SetAssignment;
  sheets: Sheets;
  damage: number;
  /** Members short of ER or CR already; a swap may not add to them. */
  unmet: ReadonlySet<string>;
}

/** Levelling `artifact` and wearing it in the member's slot. Null when the
 *  team cannot be scored or a member falls short of ER or CR. */
function scoreOption(
  team: Fielded,
  member: LineupMember,
  slot: Slot,
  artifact: ArtifactData
): LevellingPiece | null {
  const { screen, bar } = team.input;
  const sheets = {
    ...team.sheets,
    [member.charId]: sheetOf({
      ...member.artifacts,
      [slot]: levelledPiece(artifact),
    }),
  };
  if (
    findUnmetMembers(screen, team.assignment, sheets).some(
      (charId) => !team.unmet.has(charId)
    )
  )
    return null;
  const damage = evaluateAssignment(screen, team.assignment, sheets);
  const evalFn = heldEvaluator(screen, team.assignment, sheets);
  if (damage == null || !evalFn) return null;
  const weights = memberStatWeights(evalFn, sheets, member.charId);
  const pending = pendingRolls(artifact);
  const rolls = rollGainDistribution(pending, (stat) =>
    tierValues(stat, pending.rarity).map(
      (value) => ((weights[stat] ?? 0) * value) / team.damage
    )
  );
  return {
    charId: member.charId,
    slot,
    artifact,
    replaces: member.artifacts[slot] ?? null,
    toLevel: maxPieceLevel(artifact.rarity) ?? artifact.level,
    ...summarizeOutcome(damage / team.damage - 1, rolls, bar),
  };
}

/**
 * The member's best levelling option for a slot. Pieces that keep its sets
 * and nobody else needs are ranked by the gradient at the current build
 * (fixed part plus expected rolls); the best few and the worn piece are
 * scored exactly. Null when none can beat the current piece or is expected
 * to gain `LEVELLING_MIN_GAIN`.
 */
function bestForSlot(
  team: Fielded,
  member: LineupMember,
  slot: Slot,
  weights: StatWeights,
  wornBy: ReadonlyMap<string, string>
): LevellingPiece | null {
  const { artifacts, reservedIds } = team.input;
  const worn = member.artifacts[slot] ?? null;
  const sets = setChoiceKey(formedSet(member.artifacts));
  const wornValue = worn ? linearValue(weights, getArtifactStats(worn)) : 0;
  const ranked = artifacts
    .filter(
      (artifact) =>
        artifact.slotKey === slot &&
        upgradesLeft(artifact) > 0 &&
        !reservedIds.has(artifact.id) &&
        (artifact.id === worn?.id || !wornBy.has(artifact.id)) &&
        setChoiceKey(formedSet({ ...member.artifacts, [slot]: artifact })) ===
          sets
    )
    .map((artifact) => ({
      artifact,
      value:
        linearValue(weights, getArtifactStats(levelledPiece(artifact))) +
        expectedRollValue(weights, pendingRolls(artifact)) -
        wornValue,
    }))
    .sort((a, b) => b.value - a.value)
    .map(({ artifact }) => artifact);
  const screened = ranked.slice(0, LEVELLING_SCREENED_PER_SLOT);
  if (worn && ranked.includes(worn) && !screened.includes(worn))
    screened.push(worn);
  let best: LevellingPiece | null = null;
  for (const artifact of screened) {
    const option = scoreOption(team, member, slot, artifact);
    if (option && (!best || compareLevellingPieces(option, best) < 0))
      best = option;
  }
  return best && (beatsTie(best) || best.expectedGain >= LEVELLING_MIN_GAIN)
    ? best
    : null;
}

/** Lowest level whose stats sit between two tiers' rows. */
const MIN_OFF_TIER_LEVEL = 71;

/**
 * One level of each talent per member, and the member's next level: from its
 * account level to the tier it is scored at when the account level is below
 * it (Lv 89 → 90, a gain the margins already count), otherwise the next tier.
 */
function adviseSteps(team: Fielded): LevellingStep[] {
  const { screen, accountLevels } = team.input;
  const steps: LevellingStep[] = [];
  const damageWith = (charId: string, patch: Partial<TeamSlotConfig>) =>
    evaluateAssignment(
      {
        ...screen,
        configs: screen.configs.map((config) =>
          config.charId === charId ? { ...config, ...patch } : config
        ),
      },
      team.assignment,
      team.sheets
    );
  const gainWith = (charId: string, patch: Partial<TeamSlotConfig>) => {
    const damage = damageWith(charId, patch);
    return damage == null ? 0 : damage / team.damage - 1;
  };
  for (const config of screen.configs) {
    const { charId, charLevel, talentLevels } = config;
    const accountLevel = accountLevels[charId] ?? charLevel;
    if (accountLevel < charLevel && accountLevel >= MIN_OFF_TIER_LEVEL) {
      const below = damageWith(charId, { charLevel: accountLevel });
      steps.push({
        charId,
        kind: "level",
        from: accountLevel,
        to: charLevel,
        gain: below ? team.damage / below - 1 : 0,
        assumed: true,
      });
    } else {
      const nextLevel = getNextLevelTier(charLevel);
      if (nextLevel)
        steps.push({
          charId,
          kind: "level",
          from: charLevel,
          to: nextLevel,
          gain: gainWith(charId, { charLevel: nextLevel }),
          assumed: false,
        });
    }
    if (!talentLevels) continue;
    for (const kind of Object.keys(talentLevels) as (keyof TalentLevels)[]) {
      const from = talentLevels[kind];
      if (from >= MAX_TALENT_LEVEL) continue;
      steps.push({
        charId,
        kind,
        from,
        to: from + 1,
        gain: gainWith(charId, {
          talentLevels: { ...talentLevels, [kind]: from + 1 },
        }),
        assumed: false,
      });
    }
  }
  return steps.filter((step) => step.gain > 0).sort((a, b) => b.gain - a.gain);
}

/**
 * The best levelling option per member and slot, most likely to beat the
 * current piece first, and the talent and level steps that raise damage,
 * with the team's damage they are relative to. Members that take any pieces
 * of their set have no piece options. Null when the team cannot be scored.
 */
export function adviseLevelling(input: LevellingInput): {
  damage: number;
  pieces: LevellingPiece[];
  steps: LevellingStep[];
} | null {
  const { screen, members } = input;
  const assignment: SetAssignment = Object.fromEntries(
    members.map((member) => [member.charId, member.artifactSet])
  );
  const sheets: Sheets = Object.fromEntries(
    members.map((member) => [member.charId, sheetOf(member.artifacts)])
  );
  const damage = evaluateAssignment(screen, assignment, sheets);
  const evalFn = heldEvaluator(screen, assignment, sheets);
  if (damage == null || damage <= 0 || !evalFn) return null;
  const team: Fielded = {
    input,
    assignment,
    sheets,
    damage,
    unmet: new Set(findUnmetMembers(screen, assignment, sheets)),
  };
  const wornBy = new Map<string, string>();
  for (const member of members)
    for (const artifact of Object.values(member.artifacts))
      if (artifact) wornBy.set(artifact.id, member.charId);
  const pieces: LevellingPiece[] = [];
  for (const member of members) {
    if (member.anyPieces) continue;
    const weights = memberStatWeights(evalFn, sheets, member.charId);
    for (const slot of allSlots) {
      const best = bestForSlot(team, member, slot, weights, wornBy);
      if (best) pieces.push(best);
    }
  }
  return {
    damage,
    pieces: pieces.sort(compareLevellingPieces),
    steps: adviseSteps(team),
  };
}
