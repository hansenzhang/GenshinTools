import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SetConfigExplorerFailure,
  SetConfigExplorerMessage,
  SetConfigExplorerRequest,
  SetConfigExplorerResult,
} from "@/domain/team/setConfigExplorerTypes";

export type SetConfigExplorerProgress = Extract<
  SetConfigExplorerMessage,
  { type: "progress" }
>;

export interface SetConfigExplorerState {
  result: SetConfigExplorerResult | null;
  progress: SetConfigExplorerProgress | null;
  error: SetConfigExplorerFailure | null;
  isComputing: boolean;
  start: (request: SetConfigExplorerRequest) => void;
  stop: () => void;
}

/** Finished results for this session, by team, valid for one input signature. */
const sessionResults = new Map<
  string,
  { signature: string; result: SetConfigExplorerResult }
>();

function cachedResult(
  teamId: string,
  signature: string
): SetConfigExplorerResult | null {
  const cached = sessionResults.get(teamId);
  return cached?.signature === signature ? cached.result : null;
}

/**
 * Runs the team set explorer in a dedicated worker. Terminating that worker
 * also stops the optimizer workers it starts.
 */
export function useSetConfigExplorer(
  teamId: string,
  signature: string
): SetConfigExplorerState {
  const [result, setResult] = useState(() => cachedResult(teamId, signature));
  const [progress, setProgress] = useState<SetConfigExplorerProgress | null>(
    null
  );
  const [error, setError] = useState<SetConfigExplorerFailure | null>(null);
  const [isComputing, setIsComputing] = useState(false);
  const worker = useRef<Worker | null>(null);
  const latest = useRef({ teamId, signature });

  const stop = useCallback(() => {
    worker.current?.terminate();
    worker.current = null;
    setIsComputing(false);
    setProgress(null);
  }, []);

  useEffect(() => {
    const previous = latest.current;
    latest.current = { teamId, signature };
    if (previous.teamId === teamId && previous.signature === signature) return;
    stop();
    setResult(cachedResult(teamId, signature));
    setError(null);
  }, [teamId, signature, stop]);

  useEffect(() => () => worker.current?.terminate(), []);

  const start = useCallback(
    (request: SetConfigExplorerRequest) => {
      worker.current?.terminate();
      const runTeamId = teamId;
      const runSignature = signature;
      setResult(null);
      setError(null);
      setProgress(null);
      setIsComputing(true);
      let taskWorker: Worker;
      try {
        taskWorker = new Worker(
          new URL(
            "../services/combat/lineup/setConfigExplorer.worker.ts",
            import.meta.url
          ),
          { type: "module" }
        );
      } catch {
        setError("calculator-error");
        setIsComputing(false);
        return;
      }
      worker.current = taskWorker;
      const isStale = () =>
        worker.current !== taskWorker ||
        latest.current.teamId !== runTeamId ||
        latest.current.signature !== runSignature;
      const finish = () => {
        taskWorker.terminate();
        worker.current = null;
        setIsComputing(false);
        setProgress(null);
      };
      taskWorker.onmessage = (
        event: MessageEvent<SetConfigExplorerMessage>
      ) => {
        if (isStale()) return;
        const message = event.data;
        if (message.type === "progress") setProgress(message);
        else if (message.type === "partial") setResult(message.result);
        else if (message.type === "result") {
          sessionResults.set(runTeamId, {
            signature: runSignature,
            result: message.result,
          });
          setResult(message.result);
          finish();
        } else {
          setError(message.reason);
          finish();
        }
      };
      taskWorker.onerror = () => {
        if (isStale()) return;
        setError("calculator-error");
        finish();
      };
      taskWorker.postMessage(request);
    },
    [teamId, signature]
  );

  return { result, progress, error, isComputing, start, stop };
}
