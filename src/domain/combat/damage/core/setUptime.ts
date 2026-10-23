/**
 * Uptime of timed artifact set effects (see docs/design/lineup-solver.md,
 * "Decision: set uptime from rotation length", and
 * docs/design/lineup-solver-next.md, "Decision: continuous set uptime").
 *
 * A set effect with a `duration` is up a share of the rotation. The share is
 * the user's per-set override, or a default derived from the team's rotation
 * length and how often the wearer fires the trigger. Damage prices a share `u`
 * as `u · hits` on every part the buff reaches.
 */

import type {
  AbilityType,
  BuffActivationMap,
  BuffSource,
  ComboLine,
  FormulaEntry,
  SetUptimeSettings,
} from "../types";
import { isPartOffField } from "./fieldState";
import type { IndexedBuff } from "./teamBuffLedger";

/** One timed set effect worn in the team. */
export type TimedSetEffect = {
  setId: string;
  wearerId: string;
  duration: number;
  /** Uptime without a user override. */
  defaultUptime: number;
  /** Uptime used for damage. */
  uptime: number;
};

const DRIVER_ABILITIES: ReadonlySet<AbilityType> = new Set([
  "normal",
  "charge",
  "plunge",
]);

/** Abilities whose casts fire a trigger: E → Skill, Q → Burst, anything
 *  else (reactions, hits, Elemental DMG) → either. */
function triggerAbilities(triggers: readonly string[] | undefined) {
  const e = triggers?.includes("E") ?? false;
  const q = triggers?.includes("Q") ?? false;
  if (e === q) return new Set<AbilityType>(["skill", "burst"]);
  return new Set<AbilityType>([e ? "skill" : "burst"]);
}

/** Uptime of an effect its wearer keeps refreshing (an on-field driver, or a
 *  member whose off-field hits fire it): short of full for the gaps between
 *  refreshes and swaps. */
const CONTINUOUS_UPTIME = 0.8;

/** What a timed effect lasts and what fires it. */
export type TimedTrigger = Pick<
  BuffSource,
  "duration" | "triggers" | "castTrigger"
> & { duration: number };

/** The wearer drives: an on-field Normal, Charged or Plunge line. */
function drivesOnField(
  wearerId: string,
  lines: readonly ComboLine[],
  formulaIndex: ReadonlyMap<string, FormulaEntry>
): boolean {
  return lines.some(
    (line) =>
      line.charId === wearerId &&
      line.count > 0 &&
      formulaIndex
        .get(line.formulaId)
        ?.parts.some(
          (part) =>
            DRIVER_ABILITIES.has(part.formula.tag.ability) &&
            !isPartOffField(part, line.forceOnField)
        )
  );
}

/** The wearer's kit keeps hitting off-field with a Skill that fires the
 *  trigger, whether or not the rotation lists that damage (Layla's stars).
 *  An off-field Burst does not count: it fires the effect for one window,
 *  and refreshing it means swapping back in (Sucrose). */
function skillHitsOffField(
  wearerFormulaIds: Iterable<string>,
  counted: ReadonlySet<AbilityType>,
  formulaIndex: ReadonlyMap<string, FormulaEntry>
): boolean {
  if (!counted.has("skill")) return false;
  for (const formulaId of wearerFormulaIds) {
    const parts = formulaIndex.get(formulaId)?.parts ?? [];
    if (parts.some((p) => p.offField && p.formula.tag.ability === "skill"))
      return true;
  }
  return false;
}

/**
 * Default uptime of a timed effect: 100% without a rotation length. A
 * hit-fired effect whose wearer drives or keeps hitting off-field with a
 * Skill is up `CONTINUOUS_UPTIME`. Otherwise, and always for a cast-fired
 * effect, one window a rotation: duration ÷ rotation. A support may cast
 * twice, but a second swap is not always worth it, so it is not assumed.
 */
export function defaultSetUptime(
  trigger: TimedTrigger,
  wearerId: string,
  wearerFormulaIds: Iterable<string>,
  lines: readonly ComboLine[],
  formulaIndex: ReadonlyMap<string, FormulaEntry>,
  rotationSeconds: number | undefined
): number {
  if (rotationSeconds == null || rotationSeconds <= 0) return 1;
  if (
    !trigger.castTrigger &&
    (drivesOnField(wearerId, lines, formulaIndex) ||
      skillHitsOffField(
        wearerFormulaIds,
        triggerAbilities(trigger.triggers),
        formulaIndex
      ))
  )
    return CONTINUOUS_UPTIME;
  return Math.min(1, trigger.duration / rotationSeconds);
}

/** Timed set effects worn in the team, one per set and wearer. */
export function resolveTimedSetEffects(
  buffs: readonly IndexedBuff[],
  lines: readonly ComboLine[],
  formulaIndex: ReadonlyMap<string, FormulaEntry>,
  formulaIdsOf: (charId: string) => Iterable<string>,
  settings: SetUptimeSettings | undefined
): TimedSetEffect[] {
  const effects = new Map<string, TimedSetEffect>();
  for (const { buff, providerCharId } of buffs) {
    const { type, id, duration } = buff.source;
    if (type !== "artifactSet" || duration == null) continue;
    const key = `${id}\0${providerCharId}`;
    if (effects.has(key)) continue;
    const defaultUptime = defaultSetUptime(
      { ...buff.source, duration },
      providerCharId,
      formulaIdsOf(providerCharId),
      lines,
      formulaIndex,
      settings?.rotationSeconds
    );
    const override = settings?.overrides?.[id];
    effects.set(key, {
      setId: id,
      wearerId: providerCharId,
      duration,
      defaultUptime,
      uptime: override ?? defaultUptime,
    });
  }
  return [...effects.values()];
}

/**
 * Per-line activation for timed set effects below full uptime: `u · hits`
 * on every part of every line the buff can reach.
 */
export function timedSetActivations(
  buffs: readonly IndexedBuff[],
  effects: readonly TimedSetEffect[],
  lines: readonly ComboLine[],
  formulaIndex: ReadonlyMap<string, FormulaEntry>,
  couldApply: (ib: IndexedBuff, charId: string) => boolean
): BuffActivationMap[] {
  const result: BuffActivationMap[] = lines.map(() => ({}));
  const uptimes = new Map(
    effects.map((e) => [`${e.setId}\0${e.wearerId}`, e.uptime])
  );
  for (const ib of buffs) {
    const { type, id } = ib.buff.source;
    if (type !== "artifactSet") continue;
    const uptime = uptimes.get(`${id}\0${ib.providerCharId}`);
    if (uptime == null || uptime >= 1) continue;
    const share = Math.max(0, uptime);
    for (let i = 0; i < lines.length; i++) {
      const entry = formulaIndex.get(lines[i].formulaId);
      if (!entry || !couldApply(ib, lines[i].charId)) continue;
      const partMap: Record<number, number> = {};
      entry.parts.forEach((part, idx) => {
        partMap[idx] = share * (part.hits ?? 1);
      });
      result[i][ib.buffKey] = partMap;
    }
  }
  return result;
}
