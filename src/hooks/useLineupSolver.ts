import { useCallback, useEffect, useSyncExternalStore } from "react";
import type {
  LineupSolverFailure,
  LineupSolverMessage,
  LineupSolverRequest,
  LineupSolverResult,
} from "@/domain/team/lineupSolverTypes";
import type { EncounterMode } from "@/domain/team/lineupTypes";

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
  /** When the current or last run started (epoch ms). */
  startedAt: number | null;
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
  startedAt: null,
};

// One job per mode for the session: it keeps running while the Lineups view
// is closed, and its finished result stays until inputs change and a new run
// starts.
let jobs: Record<EncounterMode, LineupSolverJob> = {
  abyss: IDLE,
  stygian: IDLE,
};
const workers: Record<EncounterMode, Worker | null> = {
  abyss: null,
  stygian: null,
};
const listeners = new Set<() => void>();

function update(mode: EncounterMode, patch: Partial<LineupSolverJob>) {
  jobs = { ...jobs, [mode]: { ...jobs[mode], ...patch } };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stopJob(mode: EncounterMode) {
  workers[mode]?.terminate();
  workers[mode] = null;
  if (jobs[mode].isComputing)
    update(mode, { isComputing: false, progress: null });
}

function startJob(signature: string, request: LineupSolverRequest) {
  const { mode } = request;
  workers[mode]?.terminate();
  update(mode, {
    signature,
    result: null,
    progress: null,
    error: null,
    isComputing: true,
    startedAt: Date.now(),
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
    update(mode, { error: "calculator-error", isComputing: false });
    return;
  }
  workers[mode] = taskWorker;
  const finish = (patch: Partial<LineupSolverJob>) => {
    taskWorker.terminate();
    workers[mode] = null;
    update(mode, { ...patch, isComputing: false, progress: null });
  };
  taskWorker.onmessage = (event: MessageEvent<LineupSolverMessage>) => {
    if (workers[mode] !== taskWorker) return;
    const message = event.data;
    if (message.type === "progress") update(mode, { progress: message });
    else if (message.type === "partial")
      update(mode, { result: message.result });
    else if (message.type === "result") finish({ result: message.result });
    else finish({ error: message.reason });
  };
  taskWorker.onerror = () => {
    if (workers[mode] === taskWorker) finish({ error: "calculator-error" });
  };
  taskWorker.postMessage(request);
}

/**
 * Runs the lineup solver for one mode in a dedicated worker. Terminating it
 * also stops the optimizer workers it starts. Only a run for `signature` is
 * reported; a run for other inputs stops when this view sees them change.
 */
export function useLineupSolver(
  mode: EncounterMode,
  signature: string
): LineupSolverState {
  const current = useSyncExternalStore(subscribe, () => jobs[mode]);
  const matches = current.signature === signature;

  useEffect(() => {
    if (jobs[mode].isComputing && jobs[mode].signature !== signature)
      stopJob(mode);
  }, [mode, signature]);

  const start = useCallback(
    (request: LineupSolverRequest) => startJob(signature, request),
    [signature]
  );
  const stop = useCallback(() => stopJob(mode), [mode]);

  return {
    result: matches ? current.result : null,
    progress: matches ? current.progress : null,
    error: matches ? current.error : null,
    isComputing: matches && current.isComputing,
    startedAt: matches ? current.startedAt : null,
    start,
    stop,
  };
}
