/**
 * Debug export of a lineup run (docs/design/lineup-solver.md). The request
 * carries the account, so `tests/benchmark/lineupReplay.ts` can run it again
 * outside the browser, and the Lineups page can show it again.
 */

import type {
  CalibratedCandidate,
  LineupDebugExport,
  LineupDebugPlan,
  LineupDebugRead,
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

/** Reads an export's JSON, filling what older versions lack. */
export function readLineupDebugExport(text: string): LineupDebugRead {
  let data: LineupDebugExport;
  try {
    data = JSON.parse(text) as LineupDebugExport;
  } catch {
    return { kind: "not-export" };
  }
  if (data?.format !== LINEUP_DEBUG_FORMAT) return { kind: "not-export" };
  if (data.version !== 2 && data.version !== LINEUP_DEBUG_VERSION)
    return { kind: "unsupported-version", version: data.version };
  // Version 2 predates RES phases: its encounters have none.
  if (data.version === 2)
    for (const encounter of data.request.encounters) encounter.resPhases ??= [];
  // Exports before the diversify trace have none.
  data.result.trace.diversify ??= [];
  return { kind: "run", data };
}
