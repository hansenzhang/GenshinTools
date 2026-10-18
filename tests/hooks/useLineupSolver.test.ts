import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LineupSolverMessage,
  LineupSolverRequest,
  LineupSolverResult,
} from "@/domain/team/lineupSolverTypes";
import { useLineupSolver } from "@/hooks/useLineupSolver";

const workers: MockWorker[] = [];
class MockWorker {
  onmessage: ((event: MessageEvent<LineupSolverMessage>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
  emit(data: LineupSolverMessage) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

beforeEach(() => {
  workers.length = 0;
  vi.stubGlobal("Worker", MockWorker);
});
afterEach(() => vi.unstubAllGlobals());

const request = { mode: "abyss" } as LineupSolverRequest;
function result(count: number, partial = false): LineupSolverResult {
  return {
    candidates: Array.from({ length: count }, (_, index) => ({
      id: `candidate-${index}`,
      templateId: "t",
      encounterId: "e",
      members: [],
      damage: 1,
      ratio: 1,
      origin: "search" as const,
    })),
    issues: [],
    weaponCopies: {},
    setSlotCounts: {},
    trace: { tasks: [], runs: [], inFlight: null, memberStats: {} },
    partial,
  };
}
let sequence = 0;
const nextSignature = () => `signature-${sequence++}`;

describe("useLineupSolver", () => {
  it("posts the request, shows partial results and terminates when done", () => {
    const signature = nextSignature();
    const view = renderHook(() => useLineupSolver("abyss", signature));
    act(() => view.result.current.start(request));
    expect(workers).toHaveLength(1);
    expect(workers[0].postMessage).toHaveBeenCalledWith(request);
    expect(view.result.current.isComputing).toBe(true);
    act(() =>
      workers[0].emit({
        type: "progress",
        stage: "optimize",
        task: 0,
        tasks: 2,
        done: 1,
        total: 3,
      })
    );
    expect(view.result.current.progress?.stage).toBe("optimize");
    act(() => workers[0].emit({ type: "partial", result: result(1, true) }));
    expect(view.result.current.result?.candidates).toHaveLength(1);
    act(() => workers[0].emit({ type: "result", result: result(2) }));
    expect(view.result.current.result?.candidates).toHaveLength(2);
    expect(view.result.current.isComputing).toBe(false);
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it("keeps running while the view is closed", () => {
    const signature = nextSignature();
    const first = renderHook(() => useLineupSolver("abyss", signature));
    act(() => first.result.current.start(request));
    first.unmount();
    expect(workers[0].terminate).not.toHaveBeenCalled();
    act(() => workers[0].emit({ type: "result", result: result(3) }));
    const second = renderHook(() => useLineupSolver("abyss", signature));
    expect(second.result.current.result?.candidates).toHaveLength(3);
    expect(second.result.current.isComputing).toBe(false);
  });

  it("stops a run when its inputs change and hides other inputs' results", () => {
    const signature = nextSignature();
    const view = renderHook(
      (props) => useLineupSolver("abyss", props.signature),
      {
        initialProps: { signature },
      }
    );
    act(() => view.result.current.start(request));
    view.rerender({ signature: nextSignature() });
    expect(workers[0].terminate).toHaveBeenCalled();
    expect(view.result.current.isComputing).toBe(false);
    act(() => workers[0].emit({ type: "result", result: result(4) }));
    expect(view.result.current.result).toBeNull();
  });

  it("reports errors and stops on request", () => {
    const signature = nextSignature();
    const view = renderHook(() => useLineupSolver("abyss", signature));
    act(() => view.result.current.start(request));
    act(() => workers[0].emit({ type: "error", reason: "no-calibrations" }));
    expect(view.result.current.error).toBe("no-calibrations");
    expect(view.result.current.isComputing).toBe(false);
    act(() => view.result.current.start(request));
    expect(view.result.current.error).toBeNull();
    act(() => view.result.current.stop());
    expect(workers[1].terminate).toHaveBeenCalled();
    expect(view.result.current.isComputing).toBe(false);
  });

  it("keeps the latest partial results when stopped", () => {
    const signature = nextSignature();
    const view = renderHook(() => useLineupSolver("abyss", signature));
    act(() => view.result.current.start(request));
    act(() => workers[0].emit({ type: "partial", result: result(2, true) }));
    act(() => view.result.current.stop());
    expect(view.result.current.isComputing).toBe(false);
    expect(view.result.current.progress).toBeNull();
    expect(view.result.current.result?.partial).toBe(true);
    expect(view.result.current.result?.candidates).toHaveLength(2);
  });

  it("runs each mode as its own job", () => {
    const signature = nextSignature();
    const abyss = renderHook(() => useLineupSolver("abyss", signature));
    const stygian = renderHook(() => useLineupSolver("stygian", signature));
    act(() => abyss.result.current.start(request));
    act(() =>
      stygian.result.current.start({
        ...request,
        mode: "stygian",
      } as LineupSolverRequest)
    );
    expect(workers).toHaveLength(2);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    act(() => workers[1].emit({ type: "result", result: result(1) }));
    expect(stygian.result.current.result?.candidates).toHaveLength(1);
    expect(abyss.result.current.isComputing).toBe(true);
    act(() => abyss.result.current.stop());
    expect(workers[0].terminate).toHaveBeenCalled();
    expect(stygian.result.current.result?.candidates).toHaveLength(1);
  });
});
