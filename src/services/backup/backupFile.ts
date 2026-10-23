import type {
  CloudExportPartition,
  CloudNamespace,
} from "@/domain/backup/types";
import type { LineupCloudPayload } from "@/services/backup/adapters/lineupAdapter";
import { CLOUD_BACKUP_DESCRIPTORS } from "@/services/backup/registry";

export type BackupFileSectionId =
  | "account"
  | "builds"
  | "teams"
  | "tiers"
  | "lineups";

export type BackupFile = {
  app: "GenshinTools";
  kind: "full-backup";
  fileVersion: number;
  createdAt: number;
  partitions: CloudExportPartition[];
};

export type BackupFileSection = {
  id: BackupFileSectionId;
  /** Account profiles, or lineup templates; absent for other sections. */
  count?: number;
};

export type ParsedBackupFile =
  | {
      ok: true;
      createdAt: number;
      sections: BackupFileSection[];
      partitions: CloudExportPartition[];
    }
  | { ok: false; reason: "not-json" | "not-a-backup" | "newer-version" };

const BACKUP_FILE_VERSION = 1;

// Each section names the registry descriptor whose currentVersion bounds the
// partitions it accepts. Lineups have no cloud namespaces in the registry, so
// the file maps them here.
const SECTIONS: {
  id: BackupFileSectionId;
  descriptorId: string;
  namespaces: CloudNamespace[];
}[] = [
  {
    id: "account",
    descriptorId: "account",
    namespaces: ["profile.app", "profile.game", "profile.artifacts"],
  },
  { id: "builds", descriptorId: "builds", namespaces: ["builds"] },
  { id: "teams", descriptorId: "teams", namespaces: ["teams"] },
  { id: "tiers", descriptorId: "tiers", namespaces: ["tiers"] },
  { id: "lineups", descriptorId: "lineups", namespaces: ["lineups"] },
];

export function createBackupFile(
  partitions: CloudExportPartition[],
  createdAt: number
): BackupFile {
  return {
    app: "GenshinTools",
    kind: "full-backup",
    fileVersion: BACKUP_FILE_VERSION,
    createdAt,
    partitions,
  };
}

export function backupFileName(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `genshintools-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

export function parseBackupFile(text: string): ParsedBackupFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (!isRecord(value) || value.app !== "GenshinTools") {
    return { ok: false, reason: "not-a-backup" };
  }
  if (value.kind !== "full-backup" || !Array.isArray(value.partitions)) {
    return { ok: false, reason: "not-a-backup" };
  }
  if (typeof value.fileVersion !== "number") {
    return { ok: false, reason: "not-a-backup" };
  }
  if (value.fileVersion > BACKUP_FILE_VERSION) {
    return { ok: false, reason: "newer-version" };
  }

  const partitions: CloudExportPartition[] = [];
  for (const partition of value.partitions) {
    if (!isPartition(partition)) {
      return { ok: false, reason: "not-a-backup" };
    }
    const section = sectionForNamespace(partition.namespace);
    // A namespace this build does not know comes from a newer app.
    if (!section) return { ok: false, reason: "newer-version" };
    if (partition.schemaVersion > supportedVersion(section.descriptorId)) {
      return { ok: false, reason: "newer-version" };
    }
    partitions.push(partition);
  }

  return {
    ok: true,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    sections: summarizeSections(partitions),
    partitions,
  };
}

export function partitionsForSections(
  partitions: CloudExportPartition[],
  sectionIds: ReadonlySet<BackupFileSectionId>
): CloudExportPartition[] {
  return partitions.filter((partition) => {
    const section = sectionForNamespace(partition.namespace);
    return section !== undefined && sectionIds.has(section.id);
  });
}

function summarizeSections(
  partitions: CloudExportPartition[]
): BackupFileSection[] {
  return SECTIONS.flatMap((section): BackupFileSection[] => {
    const own = partitions.filter((partition) =>
      section.namespaces.includes(partition.namespace)
    );
    if (own.length === 0) return [];
    if (section.id === "account") {
      const profiles = new Set(own.map((partition) => partition.partitionKey));
      return [{ id: section.id, count: profiles.size }];
    }
    if (section.id === "lineups") {
      const payload = own[0].payload as Partial<LineupCloudPayload>;
      const templates = Array.isArray(payload.templates)
        ? payload.templates.length
        : 0;
      return [{ id: section.id, count: templates }];
    }
    return [{ id: section.id }];
  });
}

function sectionForNamespace(namespace: string) {
  return SECTIONS.find((section) =>
    (section.namespaces as string[]).includes(namespace)
  );
}

function supportedVersion(descriptorId: string): number {
  const descriptor = CLOUD_BACKUP_DESCRIPTORS.find(
    (entry) => entry.id === descriptorId
  );
  if (!descriptor) {
    throw new Error(`Backup file section has no descriptor: ${descriptorId}`);
  }
  return descriptor.currentVersion;
}

function isPartition(value: unknown): value is CloudExportPartition {
  return (
    isRecord(value) &&
    typeof value.namespace === "string" &&
    typeof value.partitionKey === "string" &&
    typeof value.schemaVersion === "number" &&
    Number.isInteger(value.schemaVersion) &&
    typeof value.conflictPolicy === "string" &&
    "payload" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
