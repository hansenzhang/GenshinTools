import type { LegacyHighs } from "highs";
import type {
  MilpModel,
  MilpSolution,
  MilpTerms,
} from "@/domain/combat/lineup/milpModel";

function writeTerms(terms: MilpTerms): string {
  const parts = Object.entries(terms)
    .filter(([, coefficient]) => coefficient !== 0)
    .map(([name, coefficient], index) => {
      const sign = coefficient < 0 ? "-" : index === 0 ? "" : "+";
      return `${sign} ${Math.abs(coefficient)} ${name}`.trim();
    });
  // LP format needs at least one term; a zero coefficient keeps the row valid.
  return parts.length > 0
    ? parts.join(" ")
    : `0 ${Object.keys(terms)[0] ?? "zero"}`;
}

/** The model in CPLEX LP format, which HiGHS reads. */
export function writeLpModel(model: MilpModel): string {
  const lines = [
    model.sense === "maximize" ? "Maximize" : "Minimize",
    ` obj: ${writeTerms(model.objective)}`,
    "Subject To",
    ...model.constraints.map(
      (row) => ` ${row.name}: ${writeTerms(row.terms)} ${row.sense} ${row.rhs}`
    ),
  ];
  if (model.freeVariables.length > 0)
    lines.push("Bounds", ...model.freeVariables.map((name) => ` ${name} free`));
  if (model.binaries.length > 0)
    lines.push("Binary", ` ${model.binaries.join(" ")}`);
  lines.push("End");
  return lines.join("\n");
}

/**
 * Solves the model with a loaded HiGHS runtime. Presolve is off: in HiGHS
 * 1.15.3 it can map every solution of a feasible lineup model back to a
 * violated row and report it infeasible. Lineup models are a few hundred
 * variables, so a run's solves take about 50% longer, still well under a
 * second in all.
 */
export function solveMilp(
  highs: Pick<LegacyHighs, "solve">,
  model: MilpModel
): MilpSolution {
  let result: ReturnType<LegacyHighs["solve"]>;
  try {
    result = highs.solve(writeLpModel(model), {
      output_flag: false,
      presolve: "off",
    });
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.Status === "Infeasible") return { status: "infeasible" };
  if (result.Status !== "Optimal")
    return { status: "failed", message: result.Status };
  return {
    status: "optimal",
    objective: result.ObjectiveValue,
    values: Object.fromEntries(
      Object.entries(result.Columns).map(([name, column]) => [
        name,
        column.Primal,
      ])
    ),
  };
}
