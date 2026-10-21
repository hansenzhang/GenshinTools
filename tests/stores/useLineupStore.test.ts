import { beforeEach, describe, expect, it } from "vitest";
import {
  createAbyssEncounter,
  createStygianEncounter,
  createTeamTemplate,
} from "@/domain/team/lineup";
import type { Calibration, ResPhase } from "@/domain/team/lineupTypes";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";
import { useLineupStore } from "@/stores/useLineupStore";

const team = teamCompInputToComp({
  id: "team-1",
  name: "Hu Tao",
  characters: ["hu_tao", "xingqiu"],
  weapons: ["staff_of_homa", "sacrificial_sword"],
  artifacts: [null, null],
});

function calibration(
  id: string,
  templateId: string,
  encounterId: string,
  measuredSeconds = 90
): Calibration {
  return {
    id,
    templateId,
    encounterId,
    reference: {
      capturedAt: 1,
      slots: [
        {
          charId: "hu_tao",
          charLevel: 90,
          constellation: 1,
          weaponId: "staff_of_homa",
          refinement: 1,
          artifactSet: { type: "4pc", setId: "crimson_witch_of_flames" },
          talentLevels: { auto: 10, skill: 10, burst: 9 },
        },
      ],
      artifactsByChar: {
        hu_tao: [
          {
            id: "a1",
            setKey: "crimson_witch_of_flames",
            slotKey: "flower",
            level: 20,
            rarity: 5,
            mainStatKey: "hp",
            lock: false,
            substats: { cd: 21 },
          },
        ],
      },
    },
    measuredSeconds,
    downtimeSeconds: null,
  };
}

function seed() {
  const store = useLineupStore.getState();
  store.addEncounters([
    createAbyssEncounter("e1", 1, 1),
    createAbyssEncounter("e2", 1, 2),
  ]);
  store.addTemplate(createTeamTemplate("t1", team));
  store.addTemplate(createTeamTemplate("t2", team));
}

beforeEach(() => {
  localStorage.clear();
  useLineupStore.setState({
    encounters: [],
    templates: [],
    calibrations: [],
    resPhasesByBoss: {},
  });
});

describe("lineup store", () => {
  it("keeps one calibration per template and encounter", () => {
    seed();
    const store = useLineupStore.getState();
    store.saveCalibration(calibration("c1", "t1", "e1", 90));
    store.saveCalibration(calibration("c2", "t1", "e2", 80));
    store.saveCalibration(calibration("c3", "t1", "e1", 70));
    expect(
      useLineupStore.getState().calibrations.map((entry) => entry.id)
    ).toEqual(["c2", "c3"]);
  });

  it("removes the calibrations of a removed encounter or template", () => {
    seed();
    const store = useLineupStore.getState();
    store.saveCalibration(calibration("c1", "t1", "e1"));
    store.saveCalibration(calibration("c2", "t2", "e2"));
    store.saveCalibration(calibration("c3", "t1", "e2"));
    store.removeEncounter("e1");
    expect(
      useLineupStore.getState().calibrations.map((entry) => entry.id)
    ).toEqual(["c2", "c3"]);
    store.removeTemplate("t2");
    expect(
      useLineupStore.getState().calibrations.map((entry) => entry.id)
    ).toEqual(["c3"]);
  });

  it("edits encounters and templates without changing their ids", () => {
    seed();
    const store = useLineupStore.getState();
    store.updateEncounter("e1", (encounter) => ({
      ...encounter,
      id: "other",
      timeBarSeconds: 180,
    }));
    store.updateTemplate("t1", (template) => ({
      ...template,
      flexBySlot: [[], ["furina"], [], []],
    }));
    store.updateCalibration("missing", { measuredSeconds: 1 });
    const state = useLineupStore.getState();
    expect(state.encounters[0]).toMatchObject({
      id: "e1",
      timeBarSeconds: 180,
    });
    expect(state.templates[0]!.flexBySlot[1]).toEqual(["furina"]);
  });

  it("hydrates v1 data item by item, dropping invalid and orphaned entries", async () => {
    const encounter = {
      ...createAbyssEncounter("e1", 2, 1),
      res: { Pyro: 0.5, Quantum: 1 },
      timeBarSeconds: 150,
    };
    localStorage.setItem(
      "lineup-storage",
      JSON.stringify({
        version: 1,
        state: {
          encounters: [
            encounter,
            { id: "broken", mode: "abyss", chamber: 9, half: 1 },
            {
              id: "e2",
              mode: "stygian",
              bossId: 10011,
              enemyLevel: 105,
              res: { Cryo: 0.5 },
              targets: "",
              downtimeSeconds: -5,
              timeBarSeconds: 0,
            },
          ],
          templates: [
            {
              ...createTeamTemplate("t1", team),
              rules: [
                { kind: "element", element: "Hydro", min: 2 },
                { kind: "element", element: "Quantum", min: 1 },
              ],
            },
            { id: "t-broken" },
          ],
          calibrations: [
            calibration("c1", "t1", "e1", 100),
            calibration("c2", "t1", "e1", 95),
            calibration("c3", "t-broken", "e1"),
            { ...calibration("c4", "t1", "e2"), measuredSeconds: 0 },
          ],
        },
      })
    );
    await useLineupStore.persist.rehydrate();
    const state = useLineupStore.getState();
    expect(state.encounters.map((entry) => entry.id)).toEqual(["e1", "e2"]);
    // v1 had no RES phases: every encounter keeps its base RES throughout.
    expect(state.encounters.map((entry) => entry.resPhases)).toEqual([[], []]);
    expect(state.resPhasesByBoss).toEqual({});
    // An unknown element drops the RES map to the 10% default.
    expect(state.encounters[0]!.res).toEqual({});
    expect(state.encounters[1]).toMatchObject({
      downtimeSeconds: 0,
      timeBarSeconds: null,
    });
    expect(state.templates.map((entry) => entry.id)).toEqual(["t1"]);
    expect(state.templates[0]!.rules).toEqual([
      { kind: "element", element: "Hydro", min: 2 },
    ]);
    expect(state.calibrations.map((entry) => entry.id)).toEqual(["c2"]);
    expect(
      state.calibrations[0]!.reference.artifactsByChar.hu_tao
    ).toHaveLength(1);
  });

  it("saves a Stygian boss's RES phases, not an Abyss half's", () => {
    const phases: ResPhase[] = [
      { seconds: 12, all: 2, res: {} },
      { seconds: 10, all: 0.3, res: { Cryo: -0.3 } },
    ];
    const store = useLineupStore.getState();
    store.addEncounters([
      createAbyssEncounter("abyss", 1, 1),
      createStygianEncounter("boss", 10013, {
        id: 10013,
        tiers: { "5": { id: 1, level: 105 } },
      }),
    ]);
    store.setResPhases("abyss", phases);
    store.setResPhases("boss", phases);
    const state = useLineupStore.getState();
    expect(state.encounters.map((entry) => entry.resPhases)).toEqual([
      phases,
      phases,
    ]);
    expect(state.resPhasesByBoss).toEqual({ "10013": phases });
  });

  it("keeps RES phases and a boss's saved phases across a reload", async () => {
    const phases: ResPhase[] = [
      { seconds: 20, all: -0.4, res: {} },
      { seconds: 10, all: null, res: {} },
    ];
    localStorage.setItem(
      "lineup-storage",
      JSON.stringify({
        version: 2,
        state: {
          encounters: [
            {
              ...createAbyssEncounter("e1", 1, 1),
              resPhases: [...phases, { seconds: -1, all: 0, res: {} }],
            },
          ],
          templates: [],
          calibrations: [],
          resPhasesByBoss: { "10123": phases },
        },
      })
    );
    await useLineupStore.persist.rehydrate();
    const state = useLineupStore.getState();
    // A phase without a positive length is dropped.
    expect(state.encounters[0]!.resPhases).toEqual(phases);
    expect(state.resPhasesByBoss).toEqual({ "10123": phases });
  });
});
