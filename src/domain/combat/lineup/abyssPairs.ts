/**
 * Abyss chamber pairing (docs/design/lineup-solver.md, P2): every first-half
 * candidate with every second-half candidate it shares no character, piece or
 * weapon copy with, ranked by the weaker half's margin and then the stronger
 * one's, or by the chamber margin when both halves share one timer.
 */

import type {
  AbyssChamberPlan,
  AbyssPairing,
  AbyssTimerRule,
  CalibratedCandidate,
} from "@/domain/team/lineupSolverTypes";
import type { Encounter } from "@/domain/team/lineupTypes";
import { canFieldTogether } from "./candidates";

/**
 * Margin of halves played against one chamber timer whose bar is the sum of
 * their bars: (Σ bar − Σ downtime) ÷ Σ predicted active time.
 */
export function sharedTimerMargin(
  candidates: readonly CalibratedCandidate[]
): number {
  let room = 0;
  let active = 0;
  for (const candidate of candidates) {
    room += candidate.barSeconds - candidate.downtimeSeconds;
    active += candidate.activeSeconds;
  }
  return active > 0 ? room / active : 0;
}

/** Ranking keys, most important first. */
function pairingKey(
  candidates: readonly CalibratedCandidate[],
  rule: AbyssTimerRule
): [number, number] {
  const margins = candidates.map((candidate) => candidate.margin);
  const weakest = Math.min(...margins);
  return rule === "shared"
    ? [sharedTimerMargin(candidates), weakest]
    : [weakest, Math.max(...margins)];
}

function isTied(value: number, best: number, tiePercent: number): boolean {
  return value >= best * (1 - tiePercent / 100);
}

/** Same template and members with margins tied either way: the model cannot
 *  tell the two apart. */
function isEquivalent(
  a: CalibratedCandidate | null,
  b: CalibratedCandidate | null,
  tiePercent: number
): boolean {
  if (!a || !b) return a === b;
  const members = (candidate: CalibratedCandidate) =>
    candidate.members
      .map((member) => member.charId)
      .sort()
      .join(",");
  return (
    a.templateId === b.templateId &&
    members(a) === members(b) &&
    isTied(a.margin, b.margin, tiePercent) &&
    isTied(b.margin, a.margin, tiePercent)
  );
}

/**
 * Up to `limit` pairings, best first. Each pick is, among the remaining
 * pairings whose first key is tied with the best, the one with the highest
 * second key. Pairings equivalent to a pick on both halves are dropped, so
 * the list shows distinct choices. A missing half is left out.
 */
export function rankAbyssPairings(
  first: readonly CalibratedCandidate[],
  second: readonly CalibratedCandidate[],
  weaponCopies: Readonly<Record<string, number>>,
  rule: AbyssTimerRule,
  tiePercent: number,
  limit: number
): AbyssPairing[] {
  type Option = {
    pairing: AbyssPairing;
    halves: [CalibratedCandidate | null, CalibratedCandidate | null];
    key: [number, number];
  };
  let options: Option[] = [];
  const add = (
    a: CalibratedCandidate | null,
    b: CalibratedCandidate | null
  ) => {
    const fielded = [a, b].filter((candidate) => candidate !== null);
    const key = pairingKey(fielded, rule);
    options.push({
      pairing: {
        firstId: a?.id ?? null,
        secondId: b?.id ?? null,
        margin: key[0],
      },
      halves: [a, b],
      key,
    });
  };
  if (second.length === 0) for (const a of first) add(a, null);
  else if (first.length === 0) for (const b of second) add(null, b);
  else
    for (const a of first)
      for (const b of second)
        if (canFieldTogether([a, b], weaponCopies)) add(a, b);

  const ranked: AbyssPairing[] = [];
  while (options.length > 0 && ranked.length < limit) {
    const top = Math.max(...options.map(({ key }) => key[0]));
    let pick = -1;
    for (const [index, { key }] of options.entries()) {
      if (!isTied(key[0], top, tiePercent)) continue;
      const best = options[pick]?.key;
      if (!best || key[1] > best[1] || (key[1] === best[1] && key[0] > best[0]))
        pick = index;
    }
    const picked = options[pick];
    ranked.push(picked.pairing);
    options = options.filter(
      (option) =>
        option !== picked &&
        !option.halves.every((half, index) =>
          isEquivalent(half, picked.halves[index], tiePercent)
        )
    );
  }
  return ranked;
}

function bestMargin(candidates: readonly CalibratedCandidate[]): number | null {
  return candidates.length > 0
    ? Math.max(...candidates.map((candidate) => candidate.margin))
    : null;
}

/** A plan for every Abyss chamber that has an encounter, in chamber order. */
export function planAbyssChambers(
  encounters: readonly Encounter[],
  candidates: readonly CalibratedCandidate[],
  weaponCopies: Readonly<Record<string, number>>,
  rule: AbyssTimerRule,
  tiePercent: number,
  limit: number
): AbyssChamberPlan[] {
  const chambers = [
    ...new Set(
      encounters.flatMap((encounter) =>
        encounter.mode === "abyss" ? [encounter.chamber] : []
      )
    ),
  ].sort((a, b) => a - b);
  return chambers.map((chamber) => {
    const half = (number: 1 | 2) =>
      encounters.find(
        (encounter) =>
          encounter.mode === "abyss" &&
          encounter.chamber === chamber &&
          encounter.half === number
      ) ?? null;
    const firstEncounter = half(1);
    const secondEncounter = half(2);
    const on = (encounter: Encounter | null) =>
      encounter
        ? candidates.filter(
            (candidate) => candidate.encounterId === encounter.id
          )
        : [];
    const first = on(firstEncounter);
    const second = on(secondEncounter);
    return {
      chamber,
      firstEncounterId: firstEncounter?.id ?? null,
      secondEncounterId: secondEncounter?.id ?? null,
      pairings: rankAbyssPairings(
        first,
        second,
        weaponCopies,
        rule,
        tiePercent,
        limit
      ),
      bestAlone: { first: bestMargin(first), second: bestMargin(second) },
    };
  });
}
