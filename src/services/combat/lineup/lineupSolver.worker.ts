import "@/providers/reference/statLoaders";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import type {
  LineupSolverMessage,
  LineupSolverRequest,
} from "@/domain/team/lineupSolverTypes";
import { runLineupSolver } from "./lineupSolver";

self.onmessage = async (event: MessageEvent<LineupSolverRequest>) => {
  const report = (message: LineupSolverMessage) => self.postMessage(message);
  try {
    const [chars, weapons] = await Promise.all([
      characterStatsResource.preload(),
      weaponStatsResource.preload(),
    ]);
    await runLineupSolver(event.data, chars, weapons, report);
  } catch (error) {
    report({
      type: "error",
      reason: "calculator-error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
};
