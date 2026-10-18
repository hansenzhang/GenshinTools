import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StygianLineup } from "@/components/teams/StygianLineup";
import type { Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import { createTeamTemplate } from "@/domain/team/lineup";
import type {
  LineupCandidate,
  StygianPlanRequest,
  StygianPlanResult,
} from "@/domain/team/lineupSolverTypes";
import type { StygianEncounter } from "@/domain/team/lineupTypes";
import type { LineupSolverState } from "@/hooks/useLineupSolver";
import type { StygianPlanState } from "@/hooks/useStygianPlan";
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
  partial: false,
};

beforeEach(() => {
  localStorage.clear();
  useTeamStore.getState().clearTeams();
  useLineupStore.setState({ encounters: [], templates: [], calibrations: [] });
  mocks.solver = {
    result: RESULT,
    progress: null,
    error: null,
    isComputing: false,
    start: vi.fn(),
    stop: vi.fn(),
  };
  mocks.plan = { result: null, error: null, isSolving: true };
  mocks.planRequests = [];
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
});
