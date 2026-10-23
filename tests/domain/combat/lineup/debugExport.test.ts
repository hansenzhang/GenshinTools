import { describe, expect, it } from "vitest";
import {
  LINEUP_DEBUG_FORMAT,
  LINEUP_DEBUG_VERSION,
} from "@/domain/combat/lineup/constants";
import {
  buildLineupDebugExport,
  readLineupDebugExport,
} from "@/domain/combat/lineup/debugExport";
import type {
  LineupDebugExport,
  LineupSolverRequest,
  LineupSolverResult,
} from "@/domain/team/lineupSolverTypes";

const request = {
  mode: "stygian",
  accountData: { characters: [], extraArtifacts: [], extraWeapons: [] },
  encounters: [
    {
      id: "boss",
      mode: "stygian",
      bossId: 10121,
      enemyLevel: 105,
      targets: "",
      downtimeSeconds: 0,
      timeBarSeconds: 120,
      resPhases: [],
    },
  ],
  teams: [],
  calibrations: [],
  comboOverrides: {},
  timeBudgetSec: 1200,
} as unknown as LineupSolverRequest;

const result = {
  candidates: [],
  issues: [],
  weaponCopies: {},
  setSlotCounts: {},
  partial: false,
  trace: {
    tasks: [],
    runs: [],
    inFlight: null,
    memberStats: {},
    diversify: [],
  },
} as unknown as LineupSolverResult;

const exported = () =>
  buildLineupDebugExport(
    request,
    result,
    [],
    { mode: "stygian", result: null },
    new Date("2026-10-22T18:52:35.106Z")
  );

describe("readLineupDebugExport", () => {
  it("reads back what the page exports", () => {
    const read = readLineupDebugExport(JSON.stringify(exported()));
    expect(read).toEqual({ kind: "run", data: exported() });
  });

  it("refuses files that are not lineup debug exports", () => {
    expect(readLineupDebugExport("{not json").kind).toBe("not-export");
    expect(readLineupDebugExport("null").kind).toBe("not-export");
    expect(
      readLineupDebugExport(JSON.stringify({ format: "GOOD", version: 3 })).kind
    ).toBe("not-export");
  });

  it("names a version it cannot read", () => {
    const file = { ...exported(), version: LINEUP_DEBUG_VERSION + 1 };
    expect(readLineupDebugExport(JSON.stringify(file))).toEqual({
      kind: "unsupported-version",
      version: LINEUP_DEBUG_VERSION + 1,
    });
  });

  it("lists no missing pieces for a plan saved before they were found", () => {
    const old = {
      ...exported(),
      plan: {
        mode: "stygian",
        result: { plans: [], missingEncounterIds: [], binding: [] },
      },
    };
    const read = readLineupDebugExport(JSON.stringify(old));
    if (read.kind !== "run" || read.data.plan.mode !== "stygian")
      throw new Error(read.kind);
    expect(read.data.plan.result?.missingPieces).toEqual([]);
  });

  it("fills RES phases and the diversify trace a version 2 file lacks", () => {
    const old = exported() as unknown as {
      request: { encounters: Record<string, unknown>[] };
      result: { trace: Record<string, unknown> };
    } & Omit<LineupDebugExport, "request" | "result">;
    old.version = 2;
    old.format = LINEUP_DEBUG_FORMAT;
    delete old.request.encounters[0].resPhases;
    delete old.result.trace.diversify;
    const read = readLineupDebugExport(JSON.stringify(old));
    if (read.kind !== "run") throw new Error(read.kind);
    expect(read.data.request.encounters[0].resPhases).toEqual([]);
    expect(read.data.result.trace.diversify).toEqual([]);
  });
});
