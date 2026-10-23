import type { CloudExportPartition } from "@/domain/backup/types";
import type {
  Calibration,
  Encounter,
  ResPhase,
  TeamTemplate,
} from "@/domain/team/lineupTypes";
import { migrateLineupStore } from "@/stores/migration/lineup";
import { PersistedLineupStoreSchema } from "@/stores/schemas";

export type LineupCloudSnapshot = {
  encounters: Encounter[];
  templates: TeamTemplate[];
  calibrations: Calibration[];
  resPhasesByBoss: Record<string, ResPhase[]>;
};

export type LineupCloudPayload = LineupCloudSnapshot;

// Lineups travel only in backup files; cloud sync excludes them. The schema
// version follows the lineup-storage persist version so the store migration
// applies unchanged.
const LINEUP_SCHEMA_VERSION = 2;

export function lineupToCloud(
  snapshot: LineupCloudSnapshot
): CloudExportPartition<LineupCloudPayload>[] {
  return [
    {
      namespace: "lineups",
      partitionKey: "all",
      schemaVersion: LINEUP_SCHEMA_VERSION,
      conflictPolicy: "excluded",
      isDefaultState:
        snapshot.encounters.length === 0 &&
        snapshot.templates.length === 0 &&
        snapshot.calibrations.length === 0,
      payload: {
        encounters: snapshot.encounters,
        templates: snapshot.templates,
        calibrations: snapshot.calibrations,
        resPhasesByBoss: snapshot.resPhasesByBoss,
      },
    },
  ];
}

export function lineupFromCloud(
  partitions: CloudExportPartition[]
): LineupCloudSnapshot {
  const partition = partitions.find(
    (partition) => partition.namespace === "lineups"
  );
  if (!partition) {
    throw new Error("Lineup restore requires a lineups partition");
  }
  const migrated = migrateLineupStore(
    partition.payload,
    partition.schemaVersion
  );
  return PersistedLineupStoreSchema.parse(migrated) as LineupCloudSnapshot;
}

/** Templates whose Analysis team is not among `teamIds`. */
export function templatesMissingTeams(
  templates: TeamTemplate[],
  teamIds: ReadonlySet<string>
): TeamTemplate[] {
  return templates.filter((template) => !teamIds.has(template.teamId));
}
