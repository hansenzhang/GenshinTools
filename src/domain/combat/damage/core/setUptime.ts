/**
 * Uptime of timed artifact set effects (see docs/design/lineup-solver.md,
 * "Decision: set uptime from rotation length").
 *
 * A set effect with a `duration` is up a share of the rotation. The share is
 * the user's per-set override, or a default derived from the team's rotation
 * length and how often the wearer fires the trigger. Damage prices a share `u`
 * as `u · hits` on every part the buff reaches.
 */

import type {
  AbilityType,
  BuffActivationMap,
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

/**
 * Default uptime of a timed effect: 100% without a rotation length, or when
 * the wearer drives (on-field Normal/Charged/Plunge lines) or applies
 * off-field (refreshing throughout); otherwise casts · duration ÷ rotation,
 * with at least one cast per rotation.
 */
export function defaultSetUptime(
  duration: number,
  triggers: readonly string[] | undefined,
  wearerId: string,
  lines: readonly ComboLine[],
  formulaIndex: ReadonlyMap<string, FormulaEntry>,
  rotationSeconds: number | undefined
): number {
  if (rotationSeconds == null || rotationSeconds <= 0) return 1;
  const counted = triggerAbilities(triggers);
  let casts = 0;
  for (const line of lines) {
    if (line.charId !== wearerId || line.count <= 0) continue;
    const entry = formulaIndex.get(line.formulaId);
    if (!entry) continue;
    for (const part of entry.parts) {
      if (isPartOffField(part, line.forceOnField)) return 1;
      if (DRIVER_ABILITIES.has(part.formula.tag.ability)) return 1;
    }
    const ability = entry.parts[0]?.formula.tag.ability;
    if (ability && counted.has(ability)) casts += line.count;
  }
  return Math.min(1, (Math.max(1, casts) * duration) / rotationSeconds);
}

/** Timed set effects worn in the team, one per set and wearer. */
export function resolveTimedSetEffects(
  buffs: readonly IndexedBuff[],
  lines: readonly ComboLine[],
  formulaIndex: ReadonlyMap<string, FormulaEntry>,
  settings: SetUptimeSettings | undefined
): TimedSetEffect[] {
  const effects = new Map<string, TimedSetEffect>();
  for (const { buff, providerCharId } of buffs) {
    const { type, id, duration, triggers } = buff.source;
    if (type !== "artifactSet" || duration == null) continue;
    const key = `${id}\0${providerCharId}`;
    if (effects.has(key)) continue;
    const defaultUptime = defaultSetUptime(
      duration,
      triggers,
      providerCharId,
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
