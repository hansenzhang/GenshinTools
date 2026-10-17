import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type {
  Calibration,
  Encounter,
  TeamTemplate,
} from "@/domain/team/lineupTypes";
import { PersistedLineupStoreSchema } from "./schemas";

let _lineupIdSeq = 0;
export function newLineupId(prefix: "encounter" | "template" | "calibration") {
  return `${prefix}-${Date.now().toString(36)}${_lineupIdSeq++}`;
}

type LineupData = {
  encounters: Encounter[];
  templates: TeamTemplate[];
  calibrations: Calibration[];
};

interface LineupState extends LineupData {
  addEncounters: (encounters: Encounter[]) => void;
  updateEncounter: (
    id: string,
    update: (encounter: Encounter) => Encounter
  ) => void;
  removeEncounter: (id: string) => void;
  addTemplate: (template: TeamTemplate) => void;
  updateTemplate: (
    id: string,
    update: (template: TeamTemplate) => TeamTemplate
  ) => void;
  removeTemplate: (id: string) => void;
  /** Saves the clear of a template against an encounter, replacing any
   *  earlier calibration of the same pair. */
  saveCalibration: (calibration: Calibration) => void;
  updateCalibration: (
    id: string,
    patch: Partial<Pick<Calibration, "measuredSeconds" | "downtimeSeconds">>
  ) => void;
  removeCalibration: (id: string) => void;
}

/** Calibrations need their template and encounter, and a pair keeps only
 *  its latest clear. */
function consistentCalibrations(data: LineupData): Calibration[] {
  const templateIds = new Set(data.templates.map((template) => template.id));
  const encounterIds = new Set(
    data.encounters.map((encounter) => encounter.id)
  );
  const byPair = new Map<string, Calibration>();
  for (const calibration of data.calibrations) {
    if (
      !templateIds.has(calibration.templateId) ||
      !encounterIds.has(calibration.encounterId)
    )
      continue;
    byPair.set(
      `${calibration.templateId}\u0000${calibration.encounterId}`,
      calibration
    );
  }
  return [...byPair.values()];
}

export function mergeLineupStore<TState extends LineupData>(
  persistedState: unknown,
  currentState: TState
): TState {
  const parsed = PersistedLineupStoreSchema.safeParse(persistedState);
  if (!parsed.success) return currentState;
  const data = parsed.data as LineupData;
  return {
    ...currentState,
    encounters: data.encounters,
    templates: data.templates,
    calibrations: consistentCalibrations(data),
  };
}

export const useLineupStore = create<LineupState>()(
  persist(
    immer((set) => ({
      encounters: [],
      templates: [],
      calibrations: [],

      addEncounters: (encounters) =>
        set((state) => {
          state.encounters.push(...encounters);
        }),

      updateEncounter: (id, update) =>
        set((state) => {
          const index = state.encounters.findIndex((entry) => entry.id === id);
          if (index === -1) return;
          state.encounters[index] = { ...update(state.encounters[index]), id };
        }),

      removeEncounter: (id) =>
        set((state) => {
          state.encounters = state.encounters.filter(
            (entry) => entry.id !== id
          );
          state.calibrations = state.calibrations.filter(
            (calibration) => calibration.encounterId !== id
          );
        }),

      addTemplate: (template) =>
        set((state) => {
          state.templates.push(template);
        }),

      updateTemplate: (id, update) =>
        set((state) => {
          const index = state.templates.findIndex((entry) => entry.id === id);
          if (index === -1) return;
          state.templates[index] = { ...update(state.templates[index]), id };
        }),

      removeTemplate: (id) =>
        set((state) => {
          state.templates = state.templates.filter((entry) => entry.id !== id);
          state.calibrations = state.calibrations.filter(
            (calibration) => calibration.templateId !== id
          );
        }),

      saveCalibration: (calibration) =>
        set((state) => {
          state.calibrations = [
            ...state.calibrations.filter(
              (entry) =>
                entry.templateId !== calibration.templateId ||
                entry.encounterId !== calibration.encounterId
            ),
            calibration,
          ];
        }),

      updateCalibration: (id, patch) =>
        set((state) => {
          const calibration = state.calibrations.find(
            (entry) => entry.id === id
          );
          if (calibration) Object.assign(calibration, patch);
        }),

      removeCalibration: (id) =>
        set((state) => {
          state.calibrations = state.calibrations.filter(
            (entry) => entry.id !== id
          );
        }),
    })),
    {
      name: "lineup-storage",
      version: 1,
      partialize: (state) => ({
        encounters: state.encounters,
        templates: state.templates,
        calibrations: state.calibrations,
      }),
      merge: mergeLineupStore,
    }
  )
);
