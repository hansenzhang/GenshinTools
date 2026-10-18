import loadHighs, { type Highs } from "highs";
import { planStygianRun } from "@/domain/combat/lineup/stygianPlan";
import type {
  StygianPlanMessage,
  StygianPlanRequest,
} from "@/domain/team/lineupSolverTypes";
import { solveMilp } from "./highsSolver";

let highs: Promise<Highs> | null = null;

self.onmessage = async (
  event: MessageEvent<{ id: number; request: StygianPlanRequest }>
) => {
  const { id, request } = event.data;
  const report = (message: StygianPlanMessage) => self.postMessage(message);
  try {
    // The loader finds highs.wasm beside itself; Vite serves and emits it.
    highs ??= loadHighs();
    const runtime = await highs;
    report({
      type: "result",
      id,
      result: planStygianRun(request, (model) => solveMilp(runtime, model)),
    });
  } catch (error) {
    highs = null;
    report({
      type: "error",
      id,
      details: error instanceof Error ? error.message : String(error),
    });
  }
};
