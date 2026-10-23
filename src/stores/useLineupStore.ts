import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type {
  Calibration,
  Encounter,
  ResPhase,
  TeamTemplate,
} from "@/domain/team/lineupTypes";
import { migrateLineupStore } from "./migration/lineup";
import { PersistedLineupStoreSchema } from "./schemas";

let _lineupIdSeq = 0;
export function newLineupId(prefix: "encounter" | "template" | "calibration") {
  return `${prefix}-${Date.now().toString(36)}${_lineupIdSeq++}`;
}

type LineupData = {
  encounters: Encounter[];
  templates: TeamTemplate[];
  calibrations: Calibration[];
  /** RES phases last entered for each Stygian boss, by boss id. New
   *  encounters of the boss start from them. */
  resPhasesByBoss: Record<string, ResPhase[]>;
};

interface LineupState extends LineupData {
  addEncounters: (encounters: Encounter[]) => void;
  updateEncounter: (
    id: string,
    update: (encounter: Encounter) => Encounter
  ) => void;
  /** Sets an encounter's RES phases, and saves a Stygian boss's for its
   *  next encounter. */
  setResPhases: (id: string, phases: ResPhase[]) => void;
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
  /** Replaces all lineup data, as a backup file import does. */
  replaceData: (data: LineupData) => void;
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
    resPhasesByBoss: data.resPhasesByBoss,
  };
}

export const useLineupStore = create<LineupState>()(
  persist(
    immer((set) => ({
      encounters: [],
      templates: [],
      calibrations: [],
      resPhasesByBoss: {},

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

      setResPhases: (id, phases) =>
        set((state) => {
          const encounter = state.encounters.find((entry) => entry.id === id);
          if (!encounter) return;
          encounter.resPhases = phases;
          if (encounter.mode === "stygian")
            state.resPhasesByBoss[String(encounter.bossId)] = phases;
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

      replaceData: (data) =>
        set((state) => {
          state.encounters = data.encounters;
          state.templates = data.templates;
          state.calibrations = consistentCalibrations(data);
          state.resPhasesByBoss = data.resPhasesByBoss;
        }),
    })),
    {
      name: "lineup-storage",
      version: 2,
      partialize: (state) => ({
        encounters: state.encounters,
        templates: state.templates,
        calibrations: state.calibrations,
        resPhasesByBoss: state.resPhasesByBoss,
      }),
      migrate: migrateLineupStore,
      merge: mergeLineupStore,
    }
  )
);
