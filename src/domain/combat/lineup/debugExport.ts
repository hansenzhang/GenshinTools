/**
 * Debug export of a lineup run (docs/design/lineup-solver.md). The request
 * carries the account, so `tests/benchmark/lineupReplay.ts` can run it again
 * outside the browser.
 */

import type {
  CalibratedCandidate,
  LineupDebugExport,
  LineupDebugPlan,
  LineupSolverRequest,
  LineupSolverResult,
} from "@/domain/team/lineupSolverTypes";
import { LINEUP_DEBUG_FORMAT, LINEUP_DEBUG_VERSION } from "./constants";

export function buildLineupDebugExport(
  request: LineupSolverRequest,
  result: LineupSolverResult,
  calibrated: CalibratedCandidate[],
  plan: LineupDebugPlan,
  exportedAt: Date
): LineupDebugExport {
  return {
    format: LINEUP_DEBUG_FORMAT,
    version: LINEUP_DEBUG_VERSION,
    exportedAt: exportedAt.toISOString(),
    request,
    result,
    calibrated,
    plan,
  };
}
