import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_OWNED_ONLY_FILTERS } from "@/stores/schemas";
import { usePreferencesStore } from "@/stores/usePreferencesStore";

beforeEach(() => {
  localStorage.clear();
  usePreferencesStore.setState({
    characterSort: { tierSort: "desc", releaseSort: "desc", scoreSort: "off" },
    ownedOnly: { ...DEFAULT_OWNED_ONLY_FILTERS },
  });
});

describe("usePreferencesStore", () => {
  it("patches character sort with merge semantics", () => {
    // Partial update preserves other fields
    act(() => {
      usePreferencesStore.getState().setCharacterSort({ tierSort: "asc" });
    });
    let state = usePreferencesStore.getState();
    expect(state.characterSort.tierSort).toBe("asc");
    expect(state.characterSort.releaseSort).toBe("desc");

    // Second partial update preserves first
    act(() => {
      usePreferencesStore.getState().setCharacterSort({ releaseSort: "asc" });
    });
    state = usePreferencesStore.getState();
    expect(state.characterSort.tierSort).toBe("asc");
    expect(state.characterSort.releaseSort).toBe("asc");
  });

  it("saves each owned-only toggle on its own surface", () => {
    act(() => {
      usePreferencesStore.getState().setOwnedOnly("weaponPicker", true);
      usePreferencesStore.getState().setOwnedOnly("characterTierList", true);
    });

    const saved = JSON.parse(localStorage.getItem("preferences-storage") ?? "");
    expect(saved.state.ownedOnly).toEqual({
      characterPicker: false,
      weaponPicker: true,
      characterTierList: true,
      weaponTierList: false,
    });
  });

  it("hydrates preferences saved before owned-only toggles were remembered", async () => {
    localStorage.setItem(
      "preferences-storage",
      JSON.stringify({
        version: 0,
        state: {
          characterSort: {
            tierSort: "asc",
            releaseSort: "off",
            scoreSort: "desc",
          },
        },
      })
    );

    await usePreferencesStore.persist.rehydrate();

    const state = usePreferencesStore.getState();
    expect(state.characterSort).toEqual({
      tierSort: "asc",
      releaseSort: "off",
      scoreSort: "desc",
    });
    expect(state.ownedOnly).toEqual(DEFAULT_OWNED_ONLY_FILTERS);
  });

  it("keeps valid owned-only toggles when others are corrupted", async () => {
    localStorage.setItem(
      "preferences-storage",
      JSON.stringify({
        version: 0,
        state: {
          ownedOnly: { characterPicker: true, weaponTierList: "yes" },
        },
      })
    );

    await usePreferencesStore.persist.rehydrate();

    expect(usePreferencesStore.getState().ownedOnly).toEqual({
      ...DEFAULT_OWNED_ONLY_FILTERS,
      characterPicker: true,
    });
  });
});
