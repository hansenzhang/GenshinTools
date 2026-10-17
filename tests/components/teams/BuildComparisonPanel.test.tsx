import "@/providers/reference/statLoaders";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuildComparisonPanel } from "@/components/teams/BuildComparisonPanel";
import type { WeaponChoiceResultCard } from "@/components/teams/WeaponChoiceResultCard";
import type { WeaponChoiceResult as ComputeResult } from "@/domain/combat/analyzer/weaponChoice";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type { AccountData } from "@/domain/models";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import type { SetConfigExplorerResult } from "@/domain/team/setConfigExplorerTypes";
import { buildTeamSlotConfigs } from "@/domain/team/teamConfigUtils";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";
import { useTeamResultCacheStore } from "@/stores/useTeamResultCacheStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { fireEvent, render, screen } from "../../utils/render";
import "@/domain/combat/damage/index";

const state = vi.hoisted(() => ({
  account: null as AccountData | null,
  result: null as ComputeResult | null,
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@/hooks/useAsyncWeaponChoice", () => ({
  useAsyncWeaponChoice: () => ({
    result: state.result,
    isComputing: false,
    error: null,
    start: state.start,
    stop: state.stop,
  }),
}));
const explorer = vi.hoisted(() => ({
  result: null as SetConfigExplorerResult | null,
  isComputing: false,
  progress: null,
  error: null,
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@/hooks/useSetConfigExplorer", () => ({
  useSetConfigExplorer: () => explorer,
}));
vi.mock("@/components/teams/WeaponChoiceResultCard", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/teams/WeaponChoiceResultCard")
    >();
  return {
    ...actual,
    WeaponChoiceResultCard: (
      props: ComponentProps<typeof WeaponChoiceResultCard>
    ) => (
      <>
        <actual.WeaponChoiceResultCard {...props} />
        <output data-testid="result">
          {props.result?.timestamp ?? "empty"}
        </output>
      </>
    ),
  };
});

await Promise.all([
  characterStatsResource.preload(),
  weaponStatsResource.preload(),
]);
const teamComp = teamCompInputToComp({
  id: "owned-comparison",
  name: "Team",
  characters: ["hu_tao", null, null, null],
  weapons: ["staff_of_homa", null, null, null],
  artifacts: [null, null, null, null],
  reactions: [],
});
const setupConfig = { combatOptions: {} };
const CONTEXT = {
  enemyLevel: 100,
  enemyRes: 0.1,
  rollMultiplier: 0.85,
  substatBudget: "8_6" as const,
};
function TestPanel() {
  const configs = buildTeamSlotConfigs(teamComp, setupConfig, state.account);
  return (
    <BuildComparisonPanel
      teamComp={teamComp}
      setupConfig={setupConfig}
      accountData={state.account}
      configs={configs}
      teamBuild={new TeamBuild(configs)}
      objectiveCombo={{
        id: "shared",
        label: { en: "Shared", zh: "共享" },
        lines: [],
      }}
      optimizeContext={CONTEXT}
      displayContext={CONTEXT}
    />
  );
}
const account: AccountData = {
  characters: [],
  extraArtifacts: [],
  extraWeapons: [
    { id: "homa", key: "staff_of_homa", refinement: 3, level: 90, lock: false },
  ],
};
function result(mode: "weapon" | "artifact", timestamp: number): ComputeResult {
  return {
    mode,
    timestamp,
    perCharacter: {},
    done: true,
    progress: { phase: "done", overallProgress: 1 },
  };
}

describe("owned comparison scope", () => {
  it("keeps pre-run settings compact and renders completed empty rankings", () => {
    const view = render(<TestPanel />);
    expect(
      screen.queryByText("Click Run to analyze weapons")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("(others unchanged)")).not.toBeInTheDocument();
    expect(screen.queryByText("No compatible weapons")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run Analysis" }));
    state.result = result("weapon", 99);
    view.rerender(<TestPanel />);
    expect(screen.getByText("No compatible weapons")).toBeInTheDocument();
  });
  beforeEach(() => {
    state.account = account;
    state.result = null;
    vi.clearAllMocks();
    useTeamResultCacheStore.setState({ resultsByTeamId: {} });
  });

  it("clears account-scoped rankings after inventory changes and can leave owned mode after account removal", async () => {
    const view = render(<TestPanel />);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Owned weapons" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Run Analysis" }));
    expect(state.start.mock.calls[0][0].ownedWeaponChoices).toEqual([
      { weaponId: "staff_of_homa", refinement: 3 },
    ]);
    state.result = result("weapon", 22);
    view.rerender(<TestPanel />);
    expect(screen.getByTestId("result")).toHaveTextContent("22");
    state.account = { ...account, extraWeapons: [] };
    view.rerender(<TestPanel />);
    expect(screen.getByTestId("result")).toHaveTextContent("empty");
    state.account = null;
    view.rerender(<TestPanel />);
    expect(screen.getByRole("button", { name: "Run Analysis" })).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Owned weapons" })
    ).not.toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Owned weapons" })
    );
    expect(
      screen.getByRole("button", { name: "Run Analysis" })
    ).not.toBeDisabled();
  });

  it("keeps an artifact comparison running when unrelated owned inventory changes", async () => {
    const view = render(<TestPanel />);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Owned weapons" })
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Artifact sets" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Run Analysis" }));
    state.stop.mockClear();
    state.account = {
      ...account,
      extraWeapons: [
        ...account.extraWeapons,
        {
          id: "extra-tassel",
          key: "black_tassel",
          refinement: 5,
          level: 90,
          lock: false,
        },
      ],
    };
    view.rerender(<TestPanel />);
    expect(state.stop).not.toHaveBeenCalled();
    state.result = result("artifact", 33);
    view.rerender(<TestPanel />);
    expect(screen.getByTestId("result")).toHaveTextContent("33");
  });

  it("restores a computed catalog result when leaving owned mode", async () => {
    const view = render(<TestPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Run Analysis" }));
    state.result = result("weapon", 11);
    view.rerender(<TestPanel />);
    expect(screen.getByTestId("result")).toHaveTextContent("11");
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Owned weapons" })
    );
    expect(screen.getByTestId("result")).toHaveTextContent("empty");
    fireEvent.click(screen.getByRole("button", { name: "Run Analysis" }));
    state.result = result("weapon", 22);
    view.rerender(<TestPanel />);
    expect(screen.getByTestId("result")).toHaveTextContent("22");
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Owned weapons" })
    );
    expect(screen.getByTestId("result")).toHaveTextContent("11");
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Owned weapons" })
    );
    expect(screen.getByTestId("result")).toHaveTextContent("22");
  });
  it("keeps owned weapons independent from theoretical artifact comparison and exposes settings before Run", async () => {
    render(<TestPanel />);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Weapons" })).toBeInTheDocument();
    const owned = screen.getByRole("checkbox", { name: "Owned weapons" });
    const run = screen.getByRole("button", { name: "Run Analysis" });
    expect(
      owned.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(owned.closest("details")).toBeNull();
    await userEvent.click(owned);
    await userEvent.click(
      screen.getByRole("button", { name: "Artifact sets" })
    );
    expect(
      screen.queryByRole("checkbox", { name: "Owned weapons" })
    ).not.toBeInTheDocument();
    await userEvent.click(run);
    expect(state.start.mock.calls[0][0]).toMatchObject({ mode: "artifact" });
    expect(state.start.mock.calls[0][0].ownedWeaponChoices).toBeUndefined();
    await userEvent.click(screen.getByRole("button", { name: "Weapons" }));
    expect(
      screen.getByRole("checkbox", { name: "Owned weapons" })
    ).toBeChecked();
    await userEvent.click(run);
    expect(state.start.mock.calls[1][0].ownedWeaponChoices).toEqual([
      { weaponId: "staff_of_homa", refinement: 3 },
    ]);
  });

  it("ignores persisted catalog results without a matching calculation signature", () => {
    useTeamResultCacheStore
      .getState()
      .setChoiceResult(teamComp.id, "weapon", result("weapon", 11));
    render(<TestPanel />);
    expect(screen.getByTestId("result")).toHaveTextContent("empty");
  });
});

describe("team sets mode", () => {
  const CW = { type: "4pc", setId: "crimson_witch_of_flames" } as const;
  const NOBLESSE = { type: "4pc", setId: "noblesse_oblige" } as const;
  const accountOutcome = (damage: number) => ({
    damage,
    realized: {},
    artifactsByChar: {},
    failReasons: {},
    unmetCharIds: [],
  });
  function teamSetsResult(): SetConfigExplorerResult {
    return {
      basis: "account",
      charIds: ["hu_tao"],
      outcomes: [
        {
          assignment: { hu_tao: CW },
          key: "crimson_witch_of_flames",
          screenDamage: 100,
          generatedDamage: 100,
          account: accountOutcome(100),
        },
        {
          assignment: { hu_tao: NOBLESSE },
          key: "noblesse_oblige",
          screenDamage: 95,
          generatedDamage: 95,
          account: accountOutcome(110),
        },
      ],
      currentIndex: 0,
      bestIndex: 1,
      rowsByChar: {
        hu_tao: [
          {
            charId: "hu_tao",
            choice: NOBLESSE,
            key: "noblesse_oblige",
            outcomeIndex: 1,
            basis: "account",
            pinned: false,
          },
          {
            charId: "hu_tao",
            choice: CW,
            key: "crimson_witch_of_flames",
            outcomeIndex: 0,
            basis: "account",
            pinned: false,
          },
        ],
      },
      equippedDamage: null,
      tiePercent: 1,
      evaluated: 2,
      skipped: 0,
      partial: false,
    };
  }
  const updateTeamComp = vi.fn();

  beforeEach(() => {
    state.account = account;
    state.result = null;
    explorer.result = null;
    vi.clearAllMocks();
    useTeamStore.setState({ updateTeamComp });
  });

  it("swaps the owned-weapons setting for owned artifacts and a budget", async () => {
    render(<TestPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Team sets" }));
    expect(
      screen.queryByRole("checkbox", { name: "Owned weapons" })
    ).not.toBeInTheDocument();
    const owned = screen.getByRole("checkbox", { name: "Owned artifacts" });
    expect(owned).toBeChecked();
    expect(screen.getByText("Budget")).toBeInTheDocument();
    await userEvent.click(owned);
    expect(screen.queryByText("Budget")).not.toBeInTheDocument();
    // Settings are remembered per team for the session.
    await userEvent.click(owned);
    expect(owned).toBeChecked();
  });

  it("runs the explorer instead of the weapon comparison", async () => {
    render(<TestPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Team sets" }));
    await userEvent.click(screen.getByRole("button", { name: "Run Analysis" }));
    expect(state.start).not.toHaveBeenCalled();
    expect(explorer.start).toHaveBeenCalledTimes(1);
    expect(explorer.start.mock.calls[0][0]).toMatchObject({
      accountData: account,
      optimizeContext: CONTEXT,
      displayContext: CONTEXT,
      settings: { useAccountArtifacts: true, lockedCharIds: [], pinned: {} },
      inventoryReservations: { reuseMode: expect.any(String) },
    });
  });

  it("applies the best assignment to every member's set goal", async () => {
    explorer.result = teamSetsResult();
    render(<TestPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Team sets" }));
    expect(screen.getByText("+10.0% vs current")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Apply to team" })
    );
    expect(updateTeamComp).toHaveBeenCalledWith(
      teamComp.id,
      expect.objectContaining({
        slots: expect.arrayContaining([
          expect.objectContaining({ charId: "hu_tao", artifactSet: NOBLESSE }),
        ]),
      })
    );
  });

  it("treats a gain inside the tie band as no change", async () => {
    const tied = teamSetsResult();
    tied.outcomes[1].account = accountOutcome(100.5);
    explorer.result = tied;
    render(<TestPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Team sets" }));
    expect(
      screen.getByText("Current sets are already best")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Apply to team" })
    ).toBeDisabled();
    expect(screen.getByText("≈99.5%")).toBeInTheDocument();
  });
});
