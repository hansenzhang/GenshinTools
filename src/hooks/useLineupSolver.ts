import { useCallback, useEffect, useSyncExternalStore } from "react";
import type {
  LineupSolverFailure,
  LineupSolverMessage,
  LineupSolverRequest,
  LineupSolverResult,
} from "@/domain/team/lineupSolverTypes";

export type LineupSolverProgress = Extract<
  LineupSolverMessage,
  { type: "progress" }
>;

interface LineupSolverJob {
  /** Inputs the run or result belongs to. */
  signature: string | null;
  result: LineupSolverResult | null;
  progress: LineupSolverProgress | null;
  error: LineupSolverFailure | null;
  isComputing: boolean;
}

export interface LineupSolverState extends Omit<LineupSolverJob, "signature"> {
  start: (request: LineupSolverRequest) => void;
  stop: () => void;
}

const IDLE: LineupSolverJob = {
  signature: null,
  result: null,
  progress: null,
  error: null,
  isComputing: false,
};

// One job for the session: it keeps running while the Lineups view is closed,
// and its finished result stays until inputs change and a new run starts.
let job: LineupSolverJob = IDLE;
let worker: Worker | null = null;
const listeners = new Set<() => void>();

function update(patch: Partial<LineupSolverJob>) {
  job = { ...job, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stopJob() {
  worker?.terminate();
  worker = null;
  if (job.isComputing) update({ isComputing: false, progress: null });
}

function startJob(signature: string, request: LineupSolverRequest) {
  worker?.terminate();
  update({
    signature,
    result: null,
    progress: null,
    error: null,
    isComputing: true,
  });
  let taskWorker: Worker;
  try {
    taskWorker = new Worker(
      new URL(
        "../services/combat/lineup/lineupSolver.worker.ts",
        import.meta.url
      ),
      { type: "module" }
    );
  } catch {
    update({ error: "calculator-error", isComputing: false });
    return;
  }
  worker = taskWorker;
  const finish = (patch: Partial<LineupSolverJob>) => {
    taskWorker.terminate();
    worker = null;
    update({ ...patch, isComputing: false, progress: null });
  };
  taskWorker.onmessage = (event: MessageEvent<LineupSolverMessage>) => {
    if (worker !== taskWorker) return;
    const message = event.data;
    if (message.type === "progress") update({ progress: message });
    else if (message.type === "partial") update({ result: message.result });
    else if (message.type === "result") finish({ result: message.result });
    else finish({ error: message.reason });
  };
  taskWorker.onerror = () => {
    if (worker === taskWorker) finish({ error: "calculator-error" });
  };
  taskWorker.postMessage(request);
}

/**
 * Runs the lineup solver in a dedicated worker. Terminating it also stops the
 * optimizer workers it starts. Only a run for `signature` is reported; a run
 * for other inputs stops when this view sees them change.
 */
export function useLineupSolver(signature: string): LineupSolverState {
  const current = useSyncExternalStore(subscribe, () => job);
  const matches = current.signature === signature;

  useEffect(() => {
    if (job.isComputing && job.signature !== signature) stopJob();
  }, [signature]);

  const start = useCallback(
    (request: LineupSolverRequest) => startJob(signature, request),
    [signature]
  );

  return {
    result: matches ? current.result : null,
    progress: matches ? current.progress : null,
    error: matches ? current.error : null,
    isComputing: matches && current.isComputing,
    start,
    stop: stopJob,
  };
}
