import { useEffect, useState } from "react";
import type {
  StygianPlanMessage,
  StygianPlanRequest,
  StygianPlanResult,
} from "@/domain/team/lineupSolverTypes";

export interface StygianPlanState {
  result: StygianPlanResult | null;
  error: string | null;
  isSolving: boolean;
}

const IDLE: StygianPlanState = { result: null, error: null, isSolving: false };

// HiGHS loads once per session in a shared worker; requests are numbered so
// only the latest answer is shown.
let planWorker: Worker | null = null;
let sequence = 0;

/**
 * Solves the Stygian run for the request in a worker whenever it changes.
 * Pass a memoized request; null clears the plan.
 */
export function useStygianPlan(
  request: StygianPlanRequest | null
): StygianPlanState {
  const [state, setState] = useState<StygianPlanState>(IDLE);

  useEffect(() => {
    if (!request) {
      setState(IDLE);
      return;
    }
    let worker: Worker;
    try {
      worker = planWorker ??= new Worker(
        new URL(
          "../services/combat/lineup/stygianPlan.worker.ts",
          import.meta.url
        ),
        { type: "module" }
      );
    } catch (error) {
      setState({ ...IDLE, error: String(error) });
      return;
    }
    const id = ++sequence;
    setState((current) => ({ ...current, error: null, isSolving: true }));
    const onMessage = (event: MessageEvent<StygianPlanMessage>) => {
      const message = event.data;
      if (message.id !== id) return;
      setState(
        message.type === "result"
          ? { result: message.result, error: null, isSolving: false }
          : { result: null, error: message.details, isSolving: false }
      );
    };
    const onError = () => {
      planWorker?.terminate();
      planWorker = null;
      setState({ ...IDLE, error: "worker-error" });
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ id, request });
    return () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
  }, [request]);

  return state;
}
