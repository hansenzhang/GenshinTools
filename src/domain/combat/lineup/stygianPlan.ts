/**
 * Stygian run planning (docs/design/lineup-solver.md, P3): one candidate per
 * boss, with each character, piece and weapon copy used at most once across
 * the run, chosen by leximin over margins as a mixed-integer program.
 *
 * Leximin maximizes, for k = 1…bosses in turn, the sum of the k smallest
 * margins while holding the levels already reached. The sum of the k
 * smallest margins y is max over t of k·t − Σ_b max(0, t − y_b), which is
 * linear with one free t and a d_b ≥ t − y_b per boss. A held level may give
 * up its tie tolerance, but never drops a clearing lineup below 1.
 *
 * When no lineup clears every boss, a second plan minimizes the total
 * shortfall Σ max(0, 1 − y_b).
 */

import type {
  BindingItem,
  CalibratedCandidate,
  StygianPlan,
  StygianPlanKind,
  StygianPlanRequest,
  StygianPlanResult,
} from "@/domain/team/lineupSolverTypes";
import {
  candidateArtifactIds,
  candidateWeaponUses,
  findBindingItems,
  tiedMarginFloor,
} from "./candidates";
import type {
  MilpConstraint,
  MilpModel,
  MilpSolver,
  MilpTerms,
} from "./milpModel";

/** Weight of total margin when breaking ties between equal shortfalls. */
const SHORTFALL_MARGIN_WEIGHT = 1e-3;

interface RunModel {
  encounterIds: string[];
  candidates: CalibratedCandidate[];
  /** Assignment and gear constraints. */
  constraints: MilpConstraint[];
  binaries: string[];
}

const pick = (index: number) => `x${index}`;

/** Σ margin · x over an encounter's candidates: that boss's margin. */
function marginTerms(run: RunModel, encounterId: string): MilpTerms {
  const terms: MilpTerms = {};
  run.candidates.forEach((candidate, index) => {
    if (candidate.encounterId === encounterId)
      terms[pick(index)] = candidate.margin;
  });
  return terms;
}

function addTerms(target: MilpTerms, terms: MilpTerms, scale = 1): MilpTerms {
  for (const [name, value] of Object.entries(terms))
    target[name] = (target[name] ?? 0) + value * scale;
  return target;
}

/**
 * Exactly one candidate per encounter, no character or piece twice, and no
 * weapon used by more members than owned copies. Null when an encounter has
 * no candidate.
 */
function buildRunModel(
  encounterIds: readonly string[],
  candidates: readonly CalibratedCandidate[],
  weaponCopies: Readonly<Record<string, number>>
): RunModel | null {
  const included = candidates.filter((candidate) =>
    encounterIds.includes(candidate.encounterId)
  );
  if (
    encounterIds.some(
      (id) => !included.some((candidate) => candidate.encounterId === id)
    )
  )
    return null;
  const constraints: MilpConstraint[] = encounterIds.map((id, index) => ({
    name: `assign${index}`,
    terms: Object.fromEntries(
      included.flatMap((candidate, i) =>
        candidate.encounterId === id ? [[pick(i), 1]] : []
      )
    ),
    sense: "=",
    rhs: 1,
  }));

  // Gear spanning several encounters gets a capacity row.
  const users = new Map<string, { capacity: number; terms: MilpTerms }>();
  const use = (key: string, capacity: number, index: number, count = 1) => {
    const entry = users.get(key) ?? { capacity, terms: {} };
    entry.terms[pick(index)] = (entry.terms[pick(index)] ?? 0) + count;
    users.set(key, entry);
  };
  included.forEach((candidate, index) => {
    for (const member of candidate.members)
      use(`character:${member.charId}`, 1, index);
    for (const id of candidateArtifactIds(candidate))
      use(`artifact:${id}`, 1, index);
    for (const [weaponId, count] of Object.entries(
      candidateWeaponUses(candidate)
    ))
      use(`weapon:${weaponId}`, weaponCopies[weaponId] ?? 0, index, count);
  });
  let row = 0;
  for (const { capacity, terms } of users.values()) {
    const demand = encounterIds.reduce(
      (sum, id) =>
        sum +
        Math.max(
          0,
          ...included.flatMap((candidate, index) =>
            candidate.encounterId === id ? [terms[pick(index)] ?? 0] : []
          )
        ),
      0
    );
    if (demand <= capacity) continue;
    constraints.push({
      name: `gear${row++}`,
      terms,
      sense: "<=",
      rhs: capacity,
    });
  }
  return {
    encounterIds: [...encounterIds],
    candidates: included,
    constraints,
    binaries: included.map((_, index) => pick(index)),
  };
}

interface Level {
  /** Variables and rows defining the sum of the k smallest margins. */
  freeVariable: string;
  rows: MilpConstraint[];
  objective: MilpTerms;
}

/** Sum of the k smallest boss margins as an objective to maximize. */
function smallestSum(run: RunModel, k: number): Level {
  const t = `t${k}`;
  const objective: MilpTerms = { [t]: k };
  const rows = run.encounterIds.map((id, index): MilpConstraint => {
    const d = `d${k}_${index}`;
    objective[d] = -1;
    // d ≥ t − y  ⇔  d − t + y ≥ 0
    return {
      name: `level${k}_${index}`,
      terms: addTerms({ [d]: 1, [t]: -1 }, marginTerms(run, id)),
      sense: ">=",
      rhs: 0,
    };
  });
  return { freeVariable: t, rows, objective };
}

function chosenCandidates(
  run: RunModel,
  values: Record<string, number>
): CalibratedCandidate[] {
  return run.candidates.filter((_, index) => (values[pick(index)] ?? 0) > 0.5);
}

function toPlan(
  kind: StygianPlanKind,
  chosen: readonly CalibratedCandidate[]
): StygianPlan {
  return {
    kind,
    candidateIds: Object.fromEntries(
      chosen.map((candidate) => [candidate.encounterId, candidate.id])
    ),
    weakest: Math.min(...chosen.map((candidate) => candidate.margin)),
  };
}

/** The highest weakest margin over the run, or null when no lineup fits. */
function maxMin(run: RunModel, solve: MilpSolver): number | null {
  const level = smallestSum(run, 1);
  const solution = solve({
    sense: "maximize",
    objective: level.objective,
    constraints: [...run.constraints, ...level.rows],
    freeVariables: [level.freeVariable],
    binaries: run.binaries,
  });
  return solution.status === "optimal" ? solution.objective : null;
}

/** The leximin lineup, and the highest weakest margin any lineup reaches. */
function leximin(
  run: RunModel,
  tiePercent: number,
  solve: MilpSolver
): { chosen: CalibratedCandidate[]; maxMin: number } | null {
  const held: MilpConstraint[] = [];
  const freeVariables: string[] = [];
  let values: Record<string, number> | null = null;
  let top = Number.NaN;
  for (let k = 1; k <= run.encounterIds.length; k++) {
    const level = smallestSum(run, k);
    const model: MilpModel = {
      sense: "maximize",
      objective: level.objective,
      constraints: [...run.constraints, ...held, ...level.rows],
      freeVariables: [...freeVariables, level.freeVariable],
      binaries: run.binaries,
    };
    const solution = solve(model);
    if (solution.status !== "optimal") return null;
    values = solution.values;
    const reached = solution.objective;
    if (k === 1) top = reached;
    held.push(...level.rows, {
      name: `hold${k}`,
      terms: level.objective,
      sense: ">=",
      rhs:
        k === 1
          ? tiedMarginFloor(reached, tiePercent)
          : reached * (1 - tiePercent / 100),
    });
    freeVariables.push(level.freeVariable);
  }
  return values ? { chosen: chosenCandidates(run, values), maxMin: top } : null;
}

/** Smallest total shortfall below 1, then the highest total margin. */
function leastShortfall(
  run: RunModel,
  solve: MilpSolver
): CalibratedCandidate[] | null {
  const objective: MilpTerms = {};
  const rows = run.encounterIds.map((id, index): MilpConstraint => {
    const s = `s${index}`;
    const margin = marginTerms(run, id);
    objective[s] = 1;
    addTerms(objective, margin, -SHORTFALL_MARGIN_WEIGHT);
    // s + y ≥ 1
    return {
      name: `short${index}`,
      terms: addTerms({ [s]: 1 }, margin),
      sense: ">=",
      rhs: 1,
    };
  });
  const solution = solve({
    sense: "minimize",
    objective,
    constraints: [...run.constraints, ...rows],
    freeVariables: [],
    binaries: run.binaries,
  });
  return solution.status === "optimal"
    ? chosenCandidates(run, solution.values)
    : null;
}

const samePlan = (a: StygianPlan, b: StygianPlan) =>
  Object.entries(a.candidateIds).every(
    ([encounterId, id]) => b.candidateIds[encounterId] === id
  );

export function planStygianRun(
  request: StygianPlanRequest,
  solve: MilpSolver
): StygianPlanResult {
  const encounterIds = request.encounterIds.filter((id) =>
    request.candidates.some((candidate) => candidate.encounterId === id)
  );
  const missingEncounterIds = request.encounterIds.filter(
    (id) => !encounterIds.includes(id)
  );
  const empty = { plans: [], missingEncounterIds, binding: [] };
  const run = buildRunModel(
    encounterIds,
    request.candidates,
    request.weaponCopies
  );
  if (!run || encounterIds.length === 0) return empty;
  const best = leximin(run, request.tiePercent, solve);
  if (!best) return empty;
  const plans = [toPlan("leximin", best.chosen)];
  if (plans[0].weakest < 1) {
    const shortfall = leastShortfall(run, solve);
    const plan = shortfall && toPlan("shortfall", shortfall);
    if (plan && !samePlan(plan, plans[0])) plans.push(plan);
  }
  const binding: BindingItem[] = findBindingItems(
    best.chosen,
    run.candidates,
    request.weaponCopies,
    best.maxMin,
    (left, copies) => {
      const without = buildRunModel(encounterIds, left, copies);
      return without && maxMin(without, solve);
    }
  );
  return { plans, missingEncounterIds, binding };
}
