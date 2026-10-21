import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SortDirection } from "@/domain/enums";
import {
  DEFAULT_CHARACTER_SORT,
  DEFAULT_OWNED_ONLY_FILTERS,
  PersistedPreferencesStoreSchema,
} from "./schemas";

interface CharacterSortPreferences {
  tierSort: SortDirection;
  releaseSort: SortDirection;
  scoreSort: SortDirection;
}

/** Surfaces whose "Owned Only" toggle is remembered across visits. */
export type OwnedOnlyScope = keyof typeof DEFAULT_OWNED_ONLY_FILTERS;

interface PreferencesState {
  characterSort: CharacterSortPreferences;
  ownedOnly: Record<OwnedOnlyScope, boolean>;

  // Actions
  setCharacterSort: (sort: Partial<CharacterSortPreferences>) => void;
  setOwnedOnly: (scope: OwnedOnlyScope, value: boolean) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      characterSort: DEFAULT_CHARACTER_SORT,
      ownedOnly: DEFAULT_OWNED_ONLY_FILTERS,

      setCharacterSort: (sort) =>
        set((state) => ({
          characterSort: { ...state.characterSort, ...sort },
        })),
      setOwnedOnly: (scope, value) =>
        set((state) => ({
          ownedOnly: { ...state.ownedOnly, [scope]: value },
        })),
    }),
    {
      name: "preferences-storage",
      partialize: (state) => ({
        characterSort: state.characterSort,
        ownedOnly: state.ownedOnly,
      }),
      merge: (persistedState, currentState) => {
        const parsed =
          PersistedPreferencesStoreSchema.safeParse(persistedState);
        const persisted = parsed.success
          ? parsed.data
          : PersistedPreferencesStoreSchema.parse({});
        return {
          ...currentState,
          ...persisted,
          characterSort: {
            ...DEFAULT_CHARACTER_SORT,
            ...persisted.characterSort,
          },
          ownedOnly: {
            ...DEFAULT_OWNED_ONLY_FILTERS,
            ...persisted.ownedOnly,
          },
        };
      },
    }
  )
);
