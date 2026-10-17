import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SetConfigExplorerMessage,
  SetConfigExplorerRequest,
  SetConfigExplorerResult,
} from "@/domain/team/setConfigExplorerTypes";
import { useSetConfigExplorer } from "@/hooks/useSetConfigExplorer";

const workers: MockWorker[] = [];
class MockWorker {
  onmessage: ((event: MessageEvent<SetConfigExplorerMessage>) => void) | null =
    null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
  emit(data: SetConfigExplorerMessage) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

beforeEach(() => {
  workers.length = 0;
  vi.stubGlobal("Worker", MockWorker);
});
afterEach(() => vi.unstubAllGlobals());

const request = {} as SetConfigExplorerRequest;
function result(evaluated: number, partial = false): SetConfigExplorerResult {
  return {
    basis: "generated",
    charIds: [],
    outcomes: [],
    currentIndex: 0,
    bestIndex: 0,
    rowsByChar: {},
    equippedDamage: null,
    tiePercent: 0.1,
    evaluated,
    skipped: 0,
    partial,
  };
}
let sequence = 0;

describe("useSetConfigExplorer", () => {
  it("posts the request, shows partial results and terminates when done", () => {
    const teamId = `team-${sequence++}`;
    const view = renderHook(() => useSetConfigExplorer(teamId, "a"));
    act(() => view.result.current.start(request));
    expect(workers).toHaveLength(1);
    expect(workers[0].postMessage).toHaveBeenCalledWith(request);
    expect(view.result.current.isComputing).toBe(true);
    act(() =>
      workers[0].emit({ type: "progress", stage: "joint", done: 1, total: 2 })
    );
    expect(view.result.current.progress?.stage).toBe("joint");
    act(() => workers[0].emit({ type: "partial", result: result(1, true) }));
    expect(view.result.current.result?.evaluated).toBe(1);
    expect(view.result.current.isComputing).toBe(true);
    act(() => workers[0].emit({ type: "result", result: result(2) }));
    expect(view.result.current.result?.evaluated).toBe(2);
    expect(view.result.current.isComputing).toBe(false);
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it("ignores messages after the inputs change and restores cached results", () => {
    const teamId = `team-${sequence++}`;
    const view = renderHook(
      ({ signature }) => useSetConfigExplorer(teamId, signature),
      { initialProps: { signature: "a" } }
    );
    act(() => view.result.current.start(request));
    act(() => workers[0].emit({ type: "result", result: result(5) }));
    act(() => view.result.current.start(request));
    view.rerender({ signature: "b" });
    expect(workers[1].terminate).toHaveBeenCalled();
    expect(view.result.current.result).toBeNull();
    act(() => workers[1].emit({ type: "result", result: result(9) }));
    expect(view.result.current.result).toBeNull();
    view.rerender({ signature: "a" });
    expect(view.result.current.result?.evaluated).toBe(5);
  });

  it("reports errors and terminates the worker on stop and unmount", () => {
    const teamId = `team-${sequence++}`;
    const view = renderHook(() => useSetConfigExplorer(teamId, "a"));
    act(() => view.result.current.start(request));
    act(() => workers[0].emit({ type: "error", reason: "no-objective" }));
    expect(view.result.current.error).toBe("no-objective");
    expect(view.result.current.isComputing).toBe(false);
    act(() => view.result.current.start(request));
    act(() => view.result.current.stop());
    expect(workers[1].terminate).toHaveBeenCalled();
    expect(view.result.current.isComputing).toBe(false);
    act(() => view.result.current.start(request));
    view.unmount();
    expect(workers[2].terminate).toHaveBeenCalled();
  });
});
