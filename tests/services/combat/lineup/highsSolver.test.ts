import { describe, expect, it } from "vitest";
import type { MilpModel } from "@/domain/combat/lineup/milpModel";
import { solveMilp, writeLpModel } from "@/services/combat/lineup/highsSolver";
import { loadTestHighs } from "../../../helpers/highs";

const highs = await loadTestHighs();

// Two items, one bag: pick the better pair under a capacity, with a free
// variable bounded only by constraints.
const model: MilpModel = {
  sense: "maximize",
  objective: { x0: 3, x1: 2, x2: 2, t: -0.5 },
  constraints: [
    { name: "cap", terms: { x0: 2, x1: 1, x2: 1 }, sense: "<=", rhs: 2 },
    { name: "floor", terms: { t: 1, x0: -1 }, sense: ">=", rhs: -1 },
  ],
  freeVariables: ["t"],
  binaries: ["x0", "x1", "x2"],
};

describe("writeLpModel", () => {
  it("writes objective, rows, free bounds and binaries", () => {
    expect(writeLpModel(model)).toBe(
      [
        "Maximize",
        " obj: 3 x0 + 2 x1 + 2 x2 - 0.5 t",
        "Subject To",
        " cap: 2 x0 + 1 x1 + 1 x2 <= 2",
        " floor: 1 t - 1 x0 >= -1",
        "Bounds",
        " t free",
        "Binary",
        " x0 x1 x2",
        "End",
      ].join("\n")
    );
  });
});

describe("solveMilp", () => {
  it("returns the optimum and each variable's value", () => {
    const solution = solveMilp(highs, model);
    expect(solution.status).toBe("optimal");
    if (solution.status !== "optimal") return;
    // x1 + x2 (4) beats x0 (3); t falls to its floor of −1.
    expect(solution.values.x0).toBeCloseTo(0, 6);
    expect(solution.values.x1).toBeCloseTo(1, 6);
    expect(solution.values.x2).toBeCloseTo(1, 6);
    expect(solution.values.t).toBeCloseTo(-1, 6);
    expect(solution.objective).toBeCloseTo(4.5, 6);
  });

  it("reports an infeasible model", () => {
    expect(
      solveMilp(highs, {
        ...model,
        constraints: [
          ...model.constraints,
          { name: "all", terms: { x0: 1, x1: 1, x2: 1 }, sense: "=", rhs: 3 },
        ],
      })
    ).toEqual({ status: "infeasible" });
  });
});
