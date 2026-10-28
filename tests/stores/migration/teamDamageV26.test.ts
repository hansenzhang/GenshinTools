import { beforeEach, describe, expect, it } from "vitest";
import type { TeamDamageConfig } from "@/domain/team/types";
import {
  teamFromCloud,
  teamToCloud,
} from "@/services/backup/adapters/teamAdapter";
import { useTeamResultCacheStore } from "@/stores/useTeamResultCacheStore";
import { useTeamStore } from "@/stores/useTeamStore";

/** A v25 team store: a saved rotation length, no set uptimes. */
function v25State() {
  return {
    activePresetId: null,
    compDeltas: [
      {
        kind: "custom",
        id: "team-1",
        value: {
          id: "team-1",
          name: "Mizuki",
          slots: [
            {
              charId: "yumemizuki_mizuki",
              weaponId: "sacrificial_fragments",
              artifactSet: { type: "4pc", setId: "instructor" },
            },
            {
              charId: "diona",
              weaponId: "sacrificial_bow",
              artifactSet: { type: "4pc", setId: "tenacity_of_the_millelith" },
            },
          ],
          reactions: [],
        },
      },
    ],
    configsByTeamId: {
      "team-1": {
        combatOptions: {},
        damage: {
          calcContext: { enemyLevel: 100, enemyRes: 0.1 },
          formulaMode: "combo",
          rotationSeconds: 18,
        },
      },
    },
    author: "User",
    description: "",
    updatedAt: 1700000000000,
  };
}

beforeEach(() => {
  useTeamStore.getState().clearTeams();
  useTeamResultCacheStore.getState().clearAll();
});

describe("team store v26 set uptimes", () => {
  it("hydrates v25 damage settings unchanged, with derived uptimes", async () => {
    const old = v25State();
    localStorage.setItem(
      "team-builder-storage",
      JSON.stringify({ state: old, version: 25 })
    );
    await useTeamStore.persist.rehydrate();
    const damage = useTeamStore.getState().configsByTeamId["team-1"].damage;
    expect(damage).toEqual(old.configsByTeamId["team-1"].damage);
    expect(damage?.setUptimes).toBeUndefined();
    expect(
      JSON.parse(localStorage.getItem("team-builder-storage")!).version
    ).toBe(27);
  });

  it("keeps saved uptimes and drops invalid ones", async () => {
    const saved = v25State();
    Object.assign(saved.configsByTeamId["team-1"].damage, {
      setUptimes: { instructor: 0.45, noblesse_oblige: 1 },
    });
    localStorage.setItem(
      "team-builder-storage",
      JSON.stringify({ state: saved, version: 26 })
    );
    await useTeamStore.persist.rehydrate();
    expect(
      useTeamStore.getState().configsByTeamId["team-1"].damage?.setUptimes
    ).toEqual({ instructor: 0.45, noblesse_oblige: 1 });

    Object.assign(saved.configsByTeamId["team-1"].damage, {
      setUptimes: { instructor: 1.5 },
    });
    localStorage.setItem(
      "team-builder-storage",
      JSON.stringify({ state: saved, version: 26 })
    );
    await useTeamStore.persist.rehydrate();
    expect(
      useTeamStore.getState().configsByTeamId["team-1"].damage?.setUptimes
    ).toBeUndefined();
  });

  it("round-trips uptimes through cloud v8 and restores v7 payloads unchanged", () => {
    const old = v25State();
    const v7 = teamFromCloud([
      {
        namespace: "teams",
        partitionKey: "all",
        schemaVersion: 7,
        conflictPolicy: "explicit-choice",
        isDefaultState: false,
        payload: old,
      },
    ]);
    expect(v7.configsByTeamId["team-1"].damage).toEqual(
      old.configsByTeamId["team-1"].damage
    );

    const damage: TeamDamageConfig = {
      ...v7.configsByTeamId["team-1"].damage,
      setUptimes: { instructor: 0.45 },
    };
    const [partition] = teamToCloud({
      ...v7,
      configsByTeamId: {
        "team-1": { ...v7.configsByTeamId["team-1"], damage },
      },
    });
    expect(partition.schemaVersion).toBe(9);
    expect(teamFromCloud([partition]).configsByTeamId["team-1"].damage).toEqual(
      damage
    );
  });
});
