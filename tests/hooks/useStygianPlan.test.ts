import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StygianPlanMessage,
  StygianPlanRequest,
  StygianPlanResult,
} from "@/domain/team/lineupSolverTypes";
import { useStygianPlan } from "@/hooks/useStygianPlan";

const workers: MockWorker[] = [];
class MockWorker {
  listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  posted: { id: number; request: StygianPlanRequest }[] = [];
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(message: { id: number; request: StygianPlanRequest }) {
    this.posted.push(message);
  }
  emit(data: StygianPlanMessage) {
    for (const listener of this.listeners.get("message") ?? [])
      listener(new MessageEvent("message", { data }));
  }
}

// The hook keeps one worker for the session, so tests share it.
beforeEach(() => vi.stubGlobal("Worker", MockWorker));
afterEach(() => vi.unstubAllGlobals());

const request = (tiePercent: number): StygianPlanRequest => ({
  encounterIds: [],
  candidates: [],
  weaponCopies: {},
  tiePercent,
});
const result = (weakest: number): StygianPlanResult => ({
  plans: [{ kind: "leximin", candidateIds: {}, weakest }],
  missingEncounterIds: [],
  binding: [],
});

describe("useStygianPlan", () => {
  it("solves each new request in one worker and shows only the latest", () => {
    const first = request(1);
    const view = renderHook((props) => useStygianPlan(props.request), {
      initialProps: { request: first as StygianPlanRequest | null },
    });
    expect(view.result.current.isSolving).toBe(true);
    const worker = workers.at(-1)!;
    const { id: firstId } = worker.posted.at(-1)!;
    view.rerender({ request: request(2) });
    expect(workers.at(-1)).toBe(worker);
    const { id: secondId } = worker.posted.at(-1)!;
    act(() => worker.emit({ type: "result", id: firstId, result: result(1) }));
    expect(view.result.current.result).toBeNull();
    act(() => worker.emit({ type: "result", id: secondId, result: result(2) }));
    expect(view.result.current.result?.plans[0].weakest).toBe(2);
    expect(view.result.current.isSolving).toBe(false);
    view.rerender({ request: null });
    expect(view.result.current.result).toBeNull();
    expect(workers).toHaveLength(1);
  });

  it("reports a failed solve", () => {
    const failing = request(3);
    const view = renderHook(() => useStygianPlan(failing));
    const worker = workers.at(-1)!;
    const { id } = worker.posted.at(-1)!;
    act(() => worker.emit({ type: "error", id, details: "boom" }));
    expect(view.result.current).toEqual({
      result: null,
      error: "boom",
      isSolving: false,
    });
  });
});
