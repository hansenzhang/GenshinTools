import { useEffect, useState } from "react";
import type {
  LevellingAdvice,
  LevellingMessage,
  LevellingRequest,
} from "@/domain/team/lineupSolverTypes";

export interface LevellingAdviceState {
  advice: LevellingAdvice | null;
  error: string | null;
  isComputing: boolean;
}

const IDLE: LevellingAdviceState = {
  advice: null,
  error: null,
  isComputing: false,
};

// One worker for the session; requests are numbered so each caller shows
// only the answer to its latest request.
let advisorWorker: Worker | null = null;
let sequence = 0;

/**
 * Levelling advice for a lineup's team, worked out in a worker whenever the
 * request changes. Pass a memoized request; null clears the advice.
 */
export function useLevellingAdvice(
  request: LevellingRequest | null
): LevellingAdviceState {
  const [state, setState] = useState<LevellingAdviceState>(IDLE);

  useEffect(() => {
    if (!request) {
      setState(IDLE);
      return;
    }
    let worker: Worker;
    try {
      worker = advisorWorker ??= new Worker(
        new URL(
          "../services/combat/lineup/levellingAdvisor.worker.ts",
          import.meta.url
        ),
        { type: "module" }
      );
    } catch (error) {
      setState({ ...IDLE, error: String(error) });
      return;
    }
    const id = ++sequence;
    setState({ advice: null, error: null, isComputing: true });
    const onMessage = (event: MessageEvent<LevellingMessage>) => {
      const message = event.data;
      if (message.id !== id) return;
      setState(
        message.type === "result" && message.advice
          ? { advice: message.advice, error: null, isComputing: false }
          : {
              advice: null,
              // No advice: the team could not be scored.
              error: message.type === "error" ? message.details : "unscored",
              isComputing: false,
            }
      );
    };
    const onError = () => {
      advisorWorker?.terminate();
      advisorWorker = null;
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
