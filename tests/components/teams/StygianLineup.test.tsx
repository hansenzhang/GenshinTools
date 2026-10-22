import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StygianLineup } from "@/components/teams/StygianLineup";
import type { Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import { createTeamTemplate } from "@/domain/team/lineup";
import type {
  LevellingRequest,
  LineupCandidate,
  LineupRunStart,
  StygianPlanRequest,
  StygianPlanResult,
} from "@/domain/team/lineupSolverTypes";
import type { StygianEncounter } from "@/domain/team/lineupTypes";
import type { LevellingAdviceState } from "@/hooks/useLevellingAdvice";
import {
  closeLineupRun,
  type LineupSolverState,
} from "@/hooks/useLineupSolver";
import type { StygianPlanState } from "@/hooks/useStygianPlan";
import { useAccountStore } from "@/stores/useAccountStore";
import { useLineupStore } from "@/stores/useLineupStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { cleanup, render, screen } from "../../utils/render";

const mocks = vi.hoisted(() => ({
  solver: null as LineupSolverState | null,
  plan: null as StygianPlanState | null,
  planRequests: [] as (StygianPlanRequest | null)[],
  levelling: null as LevellingAdviceState | null,
  levellingRequests: [] as (LevellingRequest | null)[],
}));
vi.mock("@/hooks/useLineupSolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useLineupSolver")>()),
  useLineupSolver: () => mocks.solver,
}));
vi.mock("@/hooks/useLevellingAdvice", () => ({
  useLevellingAdvice: (request: LevellingRequest | null) => {
    mocks.levellingRequests.push(request);
    // The advice answers its own team's request only.
    return mocks.levelling &&
      request?.candidate.id === mocks.levelling.advice?.candidateId
      ? mocks.levelling
      : { advice: null, error: null, isComputing: false };
  },
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
  resPhases: [],
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
  trace: {
    tasks: [],
    runs: [],
    inFlight: null,
    memberStats: {},
    diversify: [],
  },
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
  closeLineupRun("stygian");
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
  mocks.levelling = null;
  mocks.levellingRequests = [];
  useAccountStore.setState({ activeAccountId: null, accounts: {} });
});

function useTestAccount() {
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
}

const sands = (id: string, level: number): ArtifactData => ({
  id,
  setKey: "crimson_witch_of_flames",
  slotKey: "sands",
  level,
  rarity: 5,
  mainStatKey: "atk%",
  lock: false,
  substats: { cr: 3.5 },
});

const goblet = (id: string, level: number): ArtifactData => ({
  ...sands(id, level),
  slotKey: "goblet",
  mainStatKey: "pyro%",
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

  it("advises what to level for every team, weakest first", () => {
    seed();
    useTestAccount();
    mocks.plan = {
      result: {
        plans: [
          {
            kind: "leximin",
            candidateIds: { b1: "c1", b2: "c2", b3: "c3" },
            weakest: 0.88,
          },
        ],
        missingEncounterIds: [],
        binding: [],
      },
      error: null,
      isSolving: false,
    };
    mocks.levelling = {
      advice: {
        candidateId: "c2",
        damage: 0.72,
        pieces: [
          {
            charId: "diluc",
            slot: "sands",
            artifact: sands("fresh", 0),
            replaces: sands("worn", 20),
            toLevel: 20,
            beatChance: 0.87,
            gainChance: 0.95,
            expectedGain: 0.062,
          },
          {
            charId: "diluc",
            slot: "goblet",
            artifact: goblet("small", 4),
            replaces: goblet("small", 4),
            toLevel: 20,
            beatChance: 0,
            gainChance: 1,
            expectedGain: 0.019,
          },
        ],
        steps: [
          {
            charId: "diluc",
            kind: "skill",
            from: 9,
            to: 10,
            gain: 0.034,
            assumed: false,
          },
          {
            charId: "diluc",
            kind: "level",
            from: 89,
            to: 90,
            gain: 0.01,
            assumed: true,
          },
        ],
      },
      error: null,
      isComputing: false,
    };
    render(<StygianLineup />);
    // One request per team, weakest first, each with the others' pieces
    // reserved.
    const requests = mocks.levellingRequests.slice(-3);
    expect(requests.map((entry) => entry?.candidate.id)).toEqual([
      "c2",
      "c1",
      "c3",
    ]);
    expect(requests[0]?.others.map((entry) => entry.id).sort()).toEqual([
      "c1",
      "c3",
    ]);
    expect(screen.getByText("Worth levelling")).toBeInTheDocument();
    expect(screen.getByText("+0 → +20")).toBeInTheDocument();
    expect(screen.getByText("instead of")).toBeInTheDocument();
    expect(screen.getByText("87% chance")).toBeInTheDocument();
    expect(screen.getByText("+6.2% expected")).toBeInTheDocument();
    // 0.88 · 1.062
    expect(screen.getByText("×0.93")).toBeInTheDocument();
    // An option under the tie shows its chance of any gain, muted.
    expect(screen.getByText("100% to gain")).toBeInTheDocument();
    expect(screen.getByText("+1.9% expected")).toBeInTheDocument();
    expect(screen.queryByText("0% chance")).not.toBeInTheDocument();
    expect(screen.getByText("Talents and levels")).toBeInTheDocument();
    expect(screen.getByText(/Skill 9 → 10/)).toBeInTheDocument();
    expect(screen.getByText(/Lv89 → Lv90/)).toBeInTheDocument();
    expect(screen.getByText("already in margins")).toBeInTheDocument();
  });

  it("levels pieces to max when asked, showing the level each is scored at", async () => {
    const user = userEvent.setup();
    seed();
    useTestAccount();
    const worn = { ...NO_PIECES, sands: sands("worn", 4) };
    const [first, ...rest] = RESULT.candidates;
    mocks.solver = {
      ...mocks.solver!,
      result: {
        ...RESULT,
        candidates: [
          {
            ...first,
            members: [{ ...first.members[0], artifacts: worn }],
          },
          ...rest,
        ],
      },
    };
    mocks.plan = {
      result: {
        plans: [
          {
            kind: "leximin",
            candidateIds: { b1: "c1", b2: "c2", b3: "c3" },
            weakest: 0.88,
          },
        ],
        missingEncounterIds: [],
        binding: [],
      },
      error: null,
      isSolving: false,
    };
    mocks.levelling = {
      advice: { candidateId: "c2", damage: 0.6, pieces: [], steps: [] },
      error: null,
      isComputing: false,
    };
    render(<StygianLineup />);
    expect(screen.getByText("+4")).toBeInTheDocument();
    expect(mocks.levellingRequests.at(-1)?.solver.levelToMax).toBe(false);

    await user.click(screen.getByLabelText("Level artifacts to max"));
    expect(screen.getByText("+4→20")).toBeInTheDocument();
    expect(mocks.levellingRequests.at(-1)?.solver.levelToMax).toBe(true);
    // The advice's damage on the pieces as they are: 0.88 · 0.6 / 0.72.
    expect(screen.getByText("×0.73")).toBeInTheDocument();
    expect(screen.getByText("as is")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Level artifacts to max"));
  });

  it("waits for the run to finish before advising", () => {
    seed();
    useTestAccount();
    mocks.solver = { ...mocks.solver!, isComputing: true };
    mocks.plan = {
      result: {
        plans: [
          {
            kind: "leximin",
            candidateIds: { b1: "c1", b2: "c2", b3: "c3" },
            weakest: 0.88,
          },
        ],
        missingEncounterIds: [],
        binding: [],
      },
      error: null,
      isSolving: false,
    };
    render(<StygianLineup />);
    expect(mocks.levellingRequests.every((entry) => entry === null)).toBe(true);
    expect(screen.queryByText("Worth levelling")).not.toBeInTheDocument();
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

  it("shows an exported run from the file, not the current setup", async () => {
    seed();
    const data = await exportDebugFile();
    cleanup();
    // The setup moves on: the teams are gone and nothing has run.
    useTeamStore.getState().clearTeams();
    mocks.solver = { ...(mocks.solver as LineupSolverState), result: null };
    const user = userEvent.setup();
    const { container } = render(<StygianLineup />);
    expect(screen.queryByText("Diluc")).toBeNull();
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");
    await user.upload(
      input,
      new File([JSON.stringify(data)], "run.json", {
        type: "application/json",
      })
    );
    expect(await screen.findByText(/Showing the run exported/)).toBeTruthy();
    // Team names, encounters and candidates come from the file.
    expect(mocks.planRequests.at(-1)?.candidates).toHaveLength(4);
    mocks.plan = {
      result: {
        plans: [
          {
            kind: "leximin",
            candidateIds: { b1: "c1", b2: "c2", b3: "c3" },
            weakest: 0.88,
          },
        ],
        missingEncounterIds: [],
        binding: [],
      },
      error: null,
      isSolving: false,
    };
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.upload(
      input,
      new File([JSON.stringify(data)], "run.json", {
        type: "application/json",
      })
    );
    expect((await screen.findAllByText("Diluc")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Team removed/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Export debug file" })
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/Showing the run exported/)).toBeNull();
  });

  it("refuses a file that is not a lineup debug export", async () => {
    seed();
    const error = vi.spyOn(toast, "error").mockImplementation(() => "");
    const user = userEvent.setup();
    const { container } = render(<StygianLineup />);
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");
    await user.upload(
      input,
      new File(['{"format":"GOOD"}'], "good.json", {
        type: "application/json",
      })
    );
    expect(error).toHaveBeenCalledWith("This file is not a lineup debug file");
    expect(screen.queryByText(/Showing the run exported/)).toBeNull();
    error.mockRestore();
  });
});
