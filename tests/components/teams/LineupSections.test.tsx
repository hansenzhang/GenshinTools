import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { LineupEncounters } from "@/components/teams/LineupEncounters";
import { LineupTemplates } from "@/components/teams/LineupTemplates";
import {
  createAbyssEncounter,
  createStygianEncounter,
  createTeamTemplate,
} from "@/domain/team/lineup";
import { useLineupStore } from "@/stores/useLineupStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { render, screen } from "../../utils/render";

function seedTeam(): string {
  useTeamStore.getState().importTeams({
    teams: [
      {
        id: "team-1",
        name: "Hu Tao",
        characters: ["hu_tao", "xingqiu", "yelan", "zhongli"],
        weapons: [
          "staff_of_homa",
          "sacrificial_sword",
          "aqua_simulacra",
          "favonius_lance",
        ],
        artifacts: [null, null, null, null],
      },
    ],
  });
  return useTeamStore.getState().teamComps[0]!.id;
}

beforeEach(() => {
  localStorage.clear();
  useTeamStore.getState().clearTeams();
  useLineupStore.setState({
    encounters: [],
    templates: [],
    calibrations: [],
    resPhasesByBoss: {},
  });
});

describe("LineupEncounters", () => {
  it("adds Abyss chambers as two halves until all three exist", async () => {
    const user = userEvent.setup();
    render(<LineupEncounters />);
    const add = screen.getByRole("button", { name: "Add Abyss chamber" });
    await user.click(add);
    expect(screen.getByText("Abyss 12-1 first half")).toBeInTheDocument();
    expect(screen.getByText("Abyss 12-1 second half")).toBeInTheDocument();
    await user.click(add);
    await user.click(add);
    expect(useLineupStore.getState().encounters).toHaveLength(6);
    expect(add).toBeDisabled();
  });

  it("saves the time bar and per-element RES of an encounter", async () => {
    const user = userEvent.setup();
    useLineupStore.getState().addEncounters([createAbyssEncounter("e1", 2, 1)]);
    render(<LineupEncounters />);
    await user.type(
      screen.getByRole("textbox", { name: "3★ within" }),
      "180{Enter}"
    );
    await user.type(
      screen.getByRole("textbox", { name: "Geo RES" }),
      "70{Enter}"
    );
    expect(useLineupStore.getState().encounters[0]).toMatchObject({
      timeBarSeconds: 180,
      res: { Geo: 0.7 },
    });
  });

  it("edits RES phases and saves a boss's for its next encounter", async () => {
    const user = userEvent.setup();
    useLineupStore.getState().addEncounters([
      createStygianEncounter("boss", 10013, {
        id: 10013,
        tiers: { "5": { id: 1, level: 105 } },
      }),
    ]);
    render(<LineupEncounters />);
    expect(
      screen.getByText(/Base RES for the whole clear/)
    ).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add phase" });
    await user.click(add);
    await user.click(add);
    const [spin, stun] = screen.getAllByRole("textbox", { name: "All RES" });
    await user.type(spin!, "200{Enter}");
    await user.type(stun!, "30{Enter}");
    await user.clear(screen.getByRole("textbox", { name: "Lasts" }));
    await user.type(
      screen.getByRole("textbox", { name: "Lasts" }),
      "12{Enter}"
    );
    expect(screen.getByText("Rest of the clear")).toBeInTheDocument();
    const phases = [
      { seconds: 12, all: 2, res: {} },
      { seconds: 10, all: 0.3, res: {} },
    ];
    expect(useLineupStore.getState().encounters[0]!.resPhases).toEqual(phases);
    expect(useLineupStore.getState().resPhasesByBoss).toEqual({
      "10013": phases,
    });
    await user.click(screen.getByRole("button", { name: "Remove phase 1" }));
    expect(useLineupStore.getState().encounters[0]!.resPhases).toEqual([
      phases[1],
    ]);
  });
});

describe("LineupTemplates", () => {
  it("shows a recorded clear's margin and saves the rotation on the team", async () => {
    const user = userEvent.setup();
    const teamId = seedTeam();
    const team = useTeamStore.getState().teamCompById[teamId]!;
    const store = useLineupStore.getState();
    store.addEncounters([
      {
        ...createAbyssEncounter("e1", 1, 1),
        downtimeSeconds: 8,
        timeBarSeconds: 150,
      },
      createAbyssEncounter("e2", 1, 2),
    ]);
    store.addTemplate(createTeamTemplate("t1", team));
    store.saveCalibration({
      id: "c1",
      templateId: "t1",
      encounterId: "e1",
      reference: { capturedAt: 0, slots: [], artifactsByChar: {} },
      measuredSeconds: 95,
      downtimeSeconds: null,
    });
    render(<LineupTemplates />);

    // (150 − 8) / (95 − 8)
    expect(screen.getByText("×1.63")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Rotation" }),
      "22.5{Enter}"
    );
    expect(
      useTeamStore.getState().getTeamSetupConfigById(teamId).damage
        ?.rotationSeconds
    ).toBe(22.5);
  });

  it("needs account data before it can record a clear", () => {
    const teamId = seedTeam();
    const team = useTeamStore.getState().teamCompById[teamId]!;
    useLineupStore.getState().addEncounters([createAbyssEncounter("e1", 1, 1)]);
    useLineupStore.getState().addTemplate(createTeamTemplate("t1", team));
    render(<LineupTemplates />);
    expect(screen.getByRole("button", { name: "Record clear" })).toBeDisabled();
    expect(
      screen.getByText("Import account data to record clears")
    ).toBeInTheDocument();
  });

  it("offers relinking when the team was removed", () => {
    const teamId = seedTeam();
    const team = useTeamStore.getState().teamCompById[teamId]!;
    useLineupStore
      .getState()
      .addTemplate({ ...createTeamTemplate("t1", team), teamId: "gone" });
    render(<LineupTemplates />);
    expect(screen.getByText("Team removed from Analysis")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Link team" })
    ).toBeInTheDocument();
  });

  it("warns when the team itself breaks the template's rules", () => {
    const teamId = seedTeam();
    const team = useTeamStore.getState().teamCompById[teamId]!;
    // Hu Tao's team has no Moonsign character; two join in its last slots.
    useLineupStore.getState().addTemplate({
      ...createTeamTemplate("t1", team),
      flexBySlot: [[], [], ["columbina"], ["ineffa"]],
      rules: [{ kind: "moonsign", min: 2 }],
    });
    render(<LineupTemplates />);
    expect(screen.getByText("Compositions: 1")).toBeInTheDocument();
    expect(
      screen.getByText(/The team itself breaks these rules/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Alternatives that join are scored with their default rotation, not yours"
      )
    ).toBeInTheDocument();
  });
});
