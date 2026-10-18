import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StygianLineup } from "@/components/teams/StygianLineup";
import type { Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import { createTeamTemplate } from "@/domain/team/lineup";
import type {
  LineupCandidate,
  LineupRunStart,
  StygianPlanRequest,
  StygianPlanResult,
} from "@/domain/team/lineupSolverTypes";
import type { StygianEncounter } from "@/domain/team/lineupTypes";
import type { LineupSolverState } from "@/hooks/useLineupSolver";
import type { StygianPlanState } from "@/hooks/useStygianPlan";
import { useAccountStore } from "@/stores/useAccountStore";
import { useLineupStore } from "@/stores/useLineupStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { render, screen } from "../../utils/render";

const mocks = vi.hoisted(() => ({
  solver: null as LineupSolverState | null,
  plan: null as StygianPlanState | null,
  planRequests: [] as (StygianPlanRequest | null)[],
}));
vi.mock("@/hooks/useLineupSolver", () => ({
  useLineupSolver: () => mocks.solver,
}));
vi.mock("@/hooks/useStygianPlan", () => ({
  useStygianPlan: (request: StygianPlanRequest | null) => {
    mocks.planRequests.push(request);
    return mocks.plan;
  },
}));

const NO_PIECES = Object.fromEntries(
  ["flower", "plume", "sands", "goblet", "circlet"].map((slot) => [slot, null])
) as Record<Slot, ArtifactData | null>;

function candidate(
  id: string,
  templateId: string,
  encounterId: string,
  charId: string,
  ratio: number
): LineupCandidate {
  return {
    id,
    templateId,
    encounterId,
    members: [
      {
        charId,
        weaponId: `${charId}_weapon`,
        refinement: 1,
        artifactSet: null,
        artifacts: NO_PIECES,
        anyPieces: false,
      },
    ],
    damage: ratio,
    ratio,
    origin: "search",
  };
}

const boss = (id: string, bossId: number): StygianEncounter => ({
  id,
  mode: "stygian",
  bossId,
  enemyLevel: 105,
  res: {},
  targets: "",
  downtimeSeconds: 10,
  timeBarSeconds: 120,
});

function seed() {
  useTeamStore.getState().importTeams({
    teams: ["Hu Tao", "Diluc", "Raiden"].map((name, index) => ({
      id: `team-${index}`,
      name,
      characters: [["hu_tao", "diluc", "raiden_shogun"][index]],
      weapons: [null],
      artifacts: [null],
    })),
  });
  const store = useLineupStore.getState();
  store.addEncounters([boss("b1", 1), boss("b2", 2), boss("b3", 3)]);
  useTeamStore.getState().teamComps.forEach((team, index) => {
    store.addTemplate(createTeamTemplate(`t${index}`, team));
    store.saveCalibration({
      id: `c${index}`,
      templateId: `t${index}`,
      encounterId: `b${index + 1}`,
      reference: { capturedAt: 0, slots: [], artifactsByChar: {} },
      measuredSeconds: 100,
      downtimeSeconds: null,
    });
  });
}

const RESULT = {
  candidates: [
    candidate("c1", "t0", "b1", "hu_tao", 1.2),
    candidate("c2", "t1", "b2", "diluc", 0.72),
    candidate("c3", "t2", "b3", "raiden_shogun", 1.5),
    candidate("c4", "t1", "b2", "diluc", 0.6),
  ],
  issues: [],
  weaponCopies: {},
  setSlotCounts: {},
  trace: { tasks: [], runs: [], inFlight: null, memberStats: {} },
  partial: false,
};

/** Exports the shown run as a debug file and reads it back. */
async function exportDebugFile() {
  const user = userEvent.setup();
  useAccountStore.setState({
    activeAccountId: 1,
    accounts: {
      1: {
        id: 1,
        name: "Test",
        data: { characters: [], extraArtifacts: [], extraWeapons: [] },
        lastUpdate: 0,
      },
    },
  });
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      return "blob:debug";
    },
    revokeObjectURL: () => {},
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(<StygianLineup />);
  await user.click(screen.getByRole("button", { name: "Export debug file" }));
  expect(click).toHaveBeenCalledOnce();
  click.mockRestore();
  vi.unstubAllGlobals();
  return JSON.parse(await blobs[0].text());
}

beforeEach(() => {
  localStorage.clear();
  useTeamStore.getState().clearTeams();
  useLineupStore.setState({ encounters: [], templates: [], calibrations: [] });
  mocks.solver = {
    result: RESULT,
    progress: null,
    error: null,
    isComputing: false,
    startedAt: null,
    start: vi.fn(),
    stop: vi.fn(),
  };
  mocks.plan = { result: null, error: null, isSolving: true };
  mocks.planRequests = [];
  useAccountStore.setState({ activeAccountId: null, accounts: {} });
});

describe("StygianLineup", () => {
  it("solves the run from candidates with current margins", () => {
    seed();
    render(<StygianLineup />);
    const request = mocks.planRequests.at(-1);
    expect(request?.encounterIds).toEqual(["b1", "b2", "b3"]);
    // r · (120 − 10) / (100 − 10)
    expect(request?.candidates.map((c) => c.margin.toFixed(3))).toEqual([
      "1.467",
      "0.880",
      "1.833",
      "0.733",
    ]);
    expect(screen.getByText("Solving…")).toBeInTheDocument();
  });

  it("shows each boss's team, the shortfall and what is hardest to lose", async () => {
    const user = userEvent.setup();
    seed();
    const plan: StygianPlanResult = {
      plans: [
        {
          kind: "leximin",
          candidateIds: { b1: "c1", b2: "c2", b3: "c3" },
          weakest: 0.88,
        },
        {
          kind: "shortfall",
          candidateIds: { b1: "c1", b2: "c4", b3: "c3" },
          weakest: 0.733,
        },
      ],
      missingEncounterIds: [],
      binding: [{ kind: "character", id: "diluc", marginWithout: null }],
    };
    mocks.plan = { result: plan, error: null, isSolving: false };
    render(<StygianLineup />);
    expect(screen.getAllByText("Best lineup").length).toBe(2);
    expect(screen.getByText("Weakest boss")).toBeInTheDocument();
    expect(screen.getByText("Hu Tao")).toBeInTheDocument();
    expect(screen.getByText("Diluc")).toBeInTheDocument();
    // 1 / 0.88 − 1 ≈ 14%
    expect(screen.getByText("Needs +14% damage")).toBeInTheDocument();
    expect(screen.getByText("Hardest to lose")).toBeInTheDocument();
    expect(screen.getByText("No alternative")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Smallest total shortfall/ })
    );
    expect(screen.getByText("Needs +36% damage")).toBeInTheDocument();
    expect(screen.queryByText("Hardest to lose")).not.toBeInTheDocument();
  });

  it("shows where an optimization on owned artifacts is", () => {
    seed();
    const now = Date.now();
    const progress = {
      type: "progress" as const,
      stage: "optimize" as const,
      task: 0,
      tasks: 3,
      done: 22,
      total: 24,
    };
    mocks.solver = {
      ...mocks.solver!,
      result: null,
      isComputing: true,
      startedAt: now - 65_000,
      progress: {
        ...progress,
        run: {
          startedAt: now - 12_000,
          phase: "phase1",
          round: null,
          searching: ["hu_tao", "diluc"],
        },
      },
    };
    const view = render(<StygianLineup />);
    expect(
      screen.getByText(
        /^Team 1\/3 · Optimizing owned artifacts 22\/24 · Per-character search: Hu Tao, Diluc · this optimization 0:1\d · 1:0\d$/
      )
    ).toBeInTheDocument();

    mocks.solver = {
      ...mocks.solver,
      progress: {
        ...progress,
        run: {
          startedAt: now,
          phase: "phase3",
          round: 2,
          searching: [],
        },
      },
    };
    view.rerender(<StygianLineup />);
    expect(
      screen.getByText(/· Team refinement \(round 2\) · this optimization/)
    ).toBeInTheDocument();
  });

  it("saves a stopped run with the optimization it was on", async () => {
    seed();
    const inFlight: LineupRunStart = {
      kind: "search",
      templateId: "t1",
      encounterId: "b2",
      charIds: ["diluc"],
      assignment: { diluc: null },
      generatedDamage: null,
      accountEstimate: 0.7,
      excludedArtifactCount: 0,
      runMs: null,
      startedAt: 1,
    };
    mocks.solver = {
      ...mocks.solver!,
      result: {
        ...RESULT,
        partial: true,
        trace: { ...RESULT.trace, inFlight },
      },
    };
    const data = await exportDebugFile();
    expect(data.result.partial).toBe(true);
    expect(data.result.trace.inFlight).toEqual(inFlight);
  });

  it("saves the run with its inputs as a debug file", async () => {
    seed();
    const plan: StygianPlanResult = {
      plans: [
        {
          kind: "leximin",
          candidateIds: { b1: "c1", b2: "c2", b3: "c3" },
          weakest: 0.88,
        },
      ],
      missingEncounterIds: [],
      binding: [],
    };
    mocks.plan = { result: plan, error: null, isSolving: false };
    const data = await exportDebugFile();
    expect(data.format).toBe("genshintools-lineup-debug");
    expect(data.request.mode).toBe("stygian");
    expect(data.request.encounters).toHaveLength(3);
    expect(data.result.candidates).toHaveLength(4);
    expect(data.calibrated[0].margin).toBeCloseTo((1.2 * 110) / 90, 10);
    expect(data.plan).toEqual({ mode: "stygian", result: plan });
  });
});
