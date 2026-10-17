import { beforeEach, describe, expect, it } from "vitest";
import { resolveCalcContext } from "@/domain/combat/damage/utils";
import type { TeamDamageConfig, WeaponChoiceResult } from "@/domain/team/types";
import {
  teamFromCloud,
  teamToCloud,
} from "@/services/backup/adapters/teamAdapter";
import { useTeamResultCacheStore } from "@/stores/useTeamResultCacheStore";
import { useTeamStore } from "@/stores/useTeamStore";

/** A v24 team store: damage settings without rotation seconds or
 *  per-element RES. */
function v24State() {
  return {
    activePresetId: null,
    compDeltas: [
      {
        kind: "custom",
        id: "team-1",
        value: {
          id: "team-1",
          name: "Hu Tao",
          slots: [
            { charId: "hu_tao", weaponId: "staff_of_homa", artifactSet: null },
            {
              charId: "xingqiu",
              weaponId: "sacrificial_sword",
              artifactSet: null,
            },
          ],
          reactions: [],
        },
      },
    ],
    configsByTeamId: {
      "team-1": {
        combatOptions: { "hu_tao.lowHp": "on" },
        damage: {
          calcContext: { enemyLevel: 100, enemyRes: 0.2, rollMultiplier: 0.9 },
          formulaMode: "single",
          selectedFormula: { charId: "hu_tao", formulaId: "hu_tao-charged" },
          enemyAura: "Hydro",
        },
      },
    },
    author: "User",
    description: "Keep me",
    updatedAt: 1700000000000,
  };
}

const choiceResult: WeaponChoiceResult = {
  mode: "weapon",
  timestamp: 1,
  perCharacter: {},
};

beforeEach(() => {
  useTeamStore.getState().clearTeams();
  useTeamResultCacheStore.getState().clearAll();
});

describe("team store v25 damage settings", () => {
  it("hydrates v24 damage settings unchanged, with one RES for every element", async () => {
    const old = v24State();
    localStorage.setItem(
      "team-builder-storage",
      JSON.stringify({ state: old, version: 24 })
    );
    await useTeamStore.persist.rehydrate();
    const damage = useTeamStore.getState().configsByTeamId["team-1"].damage;
    expect(damage).toEqual(old.configsByTeamId["team-1"].damage);
    expect(damage?.rotationSeconds).toBeUndefined();
    expect(resolveCalcContext(damage?.calcContext)).toMatchObject({
      enemyLevel: 100,
      enemyRes: 0.2,
    });
    expect(damage?.calcContext?.enemyResByElement).toBeUndefined();
    expect(
      JSON.parse(localStorage.getItem("team-builder-storage")!).version
    ).toBe(25);
  });

  it("keeps saved rotation seconds and per-element RES, dropping invalid values", async () => {
    const state = v24State();
    const saved = structuredClone(state);
    Object.assign(saved.configsByTeamId["team-1"].damage, {
      rotationSeconds: 21.5,
      calcContext: {
        ...state.configsByTeamId["team-1"].damage.calcContext,
        enemyResByElement: { Pyro: 0.7, Physical: -0.2 },
      },
    });
    localStorage.setItem(
      "team-builder-storage",
      JSON.stringify({ state: saved, version: 25 })
    );
    await useTeamStore.persist.rehydrate();
    let damage = useTeamStore.getState().configsByTeamId["team-1"].damage;
    expect(damage?.rotationSeconds).toBe(21.5);
    expect(damage?.calcContext?.enemyResByElement).toEqual({
      Pyro: 0.7,
      Physical: -0.2,
    });

    Object.assign(saved.configsByTeamId["team-1"].damage, {
      rotationSeconds: -4,
      calcContext: { enemyRes: 0.2, enemyResByElement: { Quantum: 0.5 } },
    });
    localStorage.setItem(
      "team-builder-storage",
      JSON.stringify({ state: saved, version: 25 })
    );
    await useTeamStore.persist.rehydrate();
    damage = useTeamStore.getState().configsByTeamId["team-1"].damage;
    expect(damage?.rotationSeconds).toBeUndefined();
    expect(damage?.calcContext).toEqual({ enemyRes: 0.2 });
  });

  it("round-trips both settings through cloud v7 and restores v6 payloads unchanged", () => {
    const old = v24State();
    const v6 = teamFromCloud([
      {
        namespace: "teams",
        partitionKey: "all",
        schemaVersion: 6,
        conflictPolicy: "explicit-choice",
        isDefaultState: false,
        payload: old,
      },
    ]);
    expect(v6.configsByTeamId["team-1"].damage).toEqual(
      old.configsByTeamId["team-1"].damage
    );

    const damage: TeamDamageConfig = {
      ...v6.configsByTeamId["team-1"].damage,
      rotationSeconds: 18,
      calcContext: { enemyRes: 0.1, enemyResByElement: { Hydro: 0.5 } },
    };
    const [partition] = teamToCloud({
      ...v6,
      configsByTeamId: {
        "team-1": { ...v6.configsByTeamId["team-1"], damage },
      },
    });
    expect(partition.schemaVersion).toBe(7);
    expect(teamFromCloud([partition]).configsByTeamId["team-1"].damage).toEqual(
      damage
    );
  });

  it("keeps cached results when only the rotation length changes", () => {
    useTeamStore.getState().importTeams({
      teams: [
        {
          id: "team-1",
          name: "Hu Tao",
          characters: ["hu_tao", "xingqiu", null, null],
          weapons: ["staff_of_homa", "sacrificial_sword", null, null],
          artifacts: [null, null, null, null],
        },
      ],
    });
    const teamId = useTeamStore.getState().teamComps[0]!.id;
    const cache = useTeamResultCacheStore.getState();
    cache.setChoiceResult(teamId, "weapon", choiceResult, "key");

    const update = useTeamStore.getState().updateTeamSetupConfig;
    update(teamId, (config) => ({
      ...config,
      damage: { ...config.damage, rotationSeconds: 20 },
    }));
    expect(
      useTeamResultCacheStore.getState().getForTeam(teamId)?.weaponChoiceResult
    ).toBeDefined();

    update(teamId, (config) => ({
      ...config,
      damage: { ...config.damage, calcContext: { enemyRes: 0.3 } },
    }));
    expect(
      useTeamResultCacheStore.getState().getForTeam(teamId)
    ).toBeUndefined();
  });
});
