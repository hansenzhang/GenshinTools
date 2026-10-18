import { beforeEach, describe, expect, it, vi } from "vitest";
import { AbyssLineups } from "@/components/teams/AbyssLineups";
import type { Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import { createAbyssEncounter, createTeamTemplate } from "@/domain/team/lineup";
import type {
  LineupCandidate,
  LineupSolverResult,
} from "@/domain/team/lineupSolverTypes";
import type { LineupSolverState } from "@/hooks/useLineupSolver";
import { useAccountStore } from "@/stores/useAccountStore";
import { useLineupStore } from "@/stores/useLineupStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { act, render, screen } from "../../utils/render";

const solver = vi.hoisted(() => ({
  state: null as LineupSolverState | null,
  signatures: [] as string[],
}));
vi.mock("@/hooks/useLineupSolver", () => ({
  useLineupSolver: (_mode: string, signature: string) => {
    solver.signatures.push(signature);
    return solver.state;
  },
}));

const NO_PIECES = {
  flower: null,
  plume: null,
  sands: null,
  goblet: null,
  circlet: null,
} as Record<Slot, ArtifactData | null>;

const SHARED_FAVONIUS = new Set(["xingqiu", "bennett"]);

function candidate(
  id: string,
  templateId: string,
  encounterId: string,
  charIds: string[],
  ratio: number
): LineupCandidate {
  return {
    id,
    templateId,
    encounterId,
    members: charIds.map((charId) => ({
      charId,
      weaponId: SHARED_FAVONIUS.has(charId)
        ? "favonius_sword"
        : `${charId}_weapon`,
      refinement: 3,
      artifactSet: null,
      artifacts: NO_PIECES,
      anyPieces: false,
    })),
    damage: ratio * 1000,
    ratio,
    origin: id === "c3" ? "pieces-excluded" : "search",
  };
}

function solverState(result: LineupSolverResult | null): LineupSolverState {
  return {
    result,
    progress: null,
    error: null,
    isComputing: false,
    startedAt: null,
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function seed() {
  useTeamStore.getState().importTeams({
    teams: [
      {
        id: "a",
        name: "Hu Tao",
        characters: ["hu_tao", "xingqiu"],
        weapons: ["staff_of_homa", "favonius_sword"],
        artifacts: [null, null],
      },
      {
        id: "b",
        name: "Diluc",
        characters: ["diluc", "bennett"],
        weapons: ["wolfs_gravestone", "favonius_sword"],
        artifacts: [null, null],
      },
    ],
  });
  const [teamA, teamB] = useTeamStore.getState().teamComps;
  const store = useLineupStore.getState();
  const halves = [1, 2] as const;
  store.addEncounters(
    halves.map((half) => ({
      ...createAbyssEncounter(`e${half}`, 1, half),
      downtimeSeconds: 10,
      timeBarSeconds: 120,
    }))
  );
  store.addTemplate(createTeamTemplate("ta", teamA!));
  store.addTemplate(createTeamTemplate("tb", teamB!));
  for (const [templateId, encounterId] of [
    ["ta", "e1"],
    ["tb", "e2"],
  ])
    store.saveCalibration({
      id: `c-${templateId}`,
      templateId,
      encounterId,
      reference: { capturedAt: 0, slots: [], artifactsByChar: {} },
      measuredSeconds: 100,
      downtimeSeconds: null,
    });
}

beforeEach(() => {
  localStorage.clear();
  useTeamStore.getState().clearTeams();
  useLineupStore.setState({ encounters: [], templates: [], calibrations: [] });
  useAccountStore.setState({ activeAccountId: null, accounts: {} });
  solver.state = solverState(null);
  solver.signatures = [];
});

describe("AbyssLineups", () => {
  it("needs account data and a recorded Abyss clear to run", () => {
    seed();
    render(<AbyssLineups />);
    expect(screen.getByRole("button", { name: "Find lineups" })).toBeDisabled();
    expect(
      screen.getByText("Import account data to find lineups")
    ).toBeInTheDocument();
  });

  it("pairs the halves with margins from the current clears", () => {
    seed();
    // Xingqiu and Bennett need the one Favonius Sword, so c1 + c2 cannot
    // be fielded; c3 goes without Xingqiu.
    solver.state = solverState({
      candidates: [
        candidate("c1", "ta", "e1", ["hu_tao", "xingqiu"], 1.2),
        candidate("c2", "tb", "e2", ["diluc", "bennett"], 0.9),
        candidate("c3", "ta", "e1", ["hu_tao", "yelan"], 1.1),
      ],
      issues: [],
      weaponCopies: {
        favonius_sword: 1,
        hu_tao_weapon: 1,
        yelan_weapon: 1,
        diluc_weapon: 1,
      },
      setSlotCounts: {},
      trace: { tasks: [], runs: [], memberStats: {} },
      partial: false,
    });
    const view = render(<AbyssLineups />);
    expect(screen.getByText("Abyss 12-1")).toBeInTheDocument();
    // 1.1 · (120 − 10) / (100 − 10) and 0.9 · 110 / 90.
    expect(screen.getByText("×1.34")).toBeInTheDocument();
    expect(screen.getAllByText("×1.10").length).toBeGreaterThan(0);
    expect(screen.getByText("Weaker half")).toBeInTheDocument();
    expect(screen.getByText("Hu Tao")).toBeInTheDocument();
    expect(screen.getByText("Diluc")).toBeInTheDocument();
    // c1 alone: 1.2 · 110 / 90.
    expect(screen.getByText("×1.47 alone")).toBeInTheDocument();
    expect(
      screen.getByText("Leaves another team's artifacts")
    ).toBeInTheDocument();

    // A longer clear lowers the margin without a new run.
    const signature = solver.signatures.at(-1);
    act(() =>
      useLineupStore.getState().updateCalibration("c-tb", {
        measuredSeconds: 120,
      })
    );
    view.rerender(<AbyssLineups />);
    expect(solver.signatures.at(-1)).toBe(signature);
    // 0.9 · 110 / 110
    expect(screen.getAllByText("×0.90").length).toBeGreaterThan(0);
  });

  it("explains a half whose team found nothing", () => {
    seed();
    solver.state = solverState({
      candidates: [candidate("c1", "ta", "e1", ["hu_tao", "xingqiu"], 1.2)],
      issues: [{ templateId: "tb", encounterId: "e2", reason: "no-candidate" }],
      weaponCopies: { favonius_sword: 1 },
      setSlotCounts: {},
      trace: { tasks: [], runs: [], memberStats: {} },
      partial: false,
    });
    render(<AbyssLineups />);
    expect(
      screen.getByText("Diluc: No build found from your artifacts")
    ).toBeInTheDocument();
  });
});
