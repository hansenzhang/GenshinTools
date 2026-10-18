// A mixed-integer linear program as plain data (docs/design/lineup-solver.md,
// P3). Domain code builds models; a service solves them with HiGHS.

/** Coefficient per variable name. Names are letters, digits and `_`, and
 *  start with a letter. */
export type MilpTerms = Record<string, number>;

export interface MilpConstraint {
  name: string;
  terms: MilpTerms;
  sense: "<=" | ">=" | "=";
  rhs: number;
}

/**
 * Variables are continuous and at least 0 unless listed as free (no bounds)
 * or binary (0 or 1).
 */
export interface MilpModel {
  sense: "maximize" | "minimize";
  objective: MilpTerms;
  constraints: MilpConstraint[];
  freeVariables: string[];
  binaries: string[];
}

export type MilpSolution =
  | { status: "optimal"; objective: number; values: Record<string, number> }
  | { status: "infeasible" }
  | { status: "failed"; message: string };

export type MilpSolver = (model: MilpModel) => MilpSolution;
