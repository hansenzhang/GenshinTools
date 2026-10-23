import { describe, expect, it } from "vitest";
import type { CloudExportPartition } from "@/domain/backup/types";
import {
  backupFileName,
  createBackupFile,
  parseBackupFile,
  partitionsForSections,
} from "@/services/backup/backupFile";

function partition(
  namespace: CloudExportPartition["namespace"],
  partitionKey: string,
  schemaVersion: number,
  payload: unknown = {}
): CloudExportPartition {
  return {
    namespace,
    partitionKey,
    schemaVersion,
    conflictPolicy: "explicit-choice",
    payload,
  };
}

const partitions = [
  partition("profile.app", "0", 2),
  partition("profile.game", "0", 2),
  partition("profile.app", "600000001", 2),
  partition("builds", "all", 3),
  partition("teams", "all", 8),
  partition("tiers", "all", 2),
  partition("lineups", "all", 2, {
    encounters: [],
    templates: [{ id: "t1" }, { id: "t2" }],
    calibrations: [],
    resPhasesByBoss: {},
  }),
];

describe("backup file", () => {
  it("round-trips partitions and summarizes sections", () => {
    const text = JSON.stringify(createBackupFile(partitions, 1_700_000_000));
    const parsed = parseBackupFile(text);
    expect(parsed).toMatchObject({ ok: true, createdAt: 1_700_000_000 });
    if (!parsed.ok) return;
    expect(parsed.partitions).toEqual(partitions);
    expect(parsed.sections).toEqual([
      { id: "account", count: 2 },
      { id: "builds" },
      { id: "teams" },
      { id: "tiers" },
      { id: "lineups", count: 2 },
    ]);
  });

  it("filters partitions to the chosen sections", () => {
    const chosen = partitionsForSections(
      partitions,
      new Set(["teams", "lineups"] as const)
    );
    expect(chosen.map((entry) => entry.namespace)).toEqual([
      "teams",
      "lineups",
    ]);
  });

  it("rejects text that is not a backup", () => {
    expect(parseBackupFile("{")).toEqual({ ok: false, reason: "not-json" });
    expect(parseBackupFile('{"teams":[]}')).toEqual({
      ok: false,
      reason: "not-a-backup",
    });
    const malformed = { ...createBackupFile([], 1), partitions: [{}] };
    expect(parseBackupFile(JSON.stringify(malformed))).toEqual({
      ok: false,
      reason: "not-a-backup",
    });
  });

  it("refuses files and partitions from a newer app", () => {
    const newerFile = { ...createBackupFile([], 1), fileVersion: 2 };
    expect(parseBackupFile(JSON.stringify(newerFile))).toEqual({
      ok: false,
      reason: "newer-version",
    });
    const newerTeams = createBackupFile([partition("teams", "all", 9)], 1);
    expect(parseBackupFile(JSON.stringify(newerTeams))).toEqual({
      ok: false,
      reason: "newer-version",
    });
    const unknown = createBackupFile(
      [partition("future" as CloudExportPartition["namespace"], "all", 1)],
      1
    );
    expect(parseBackupFile(JSON.stringify(unknown))).toEqual({
      ok: false,
      reason: "newer-version",
    });
  });

  it("names files by local date", () => {
    expect(backupFileName(new Date(2026, 9, 3, 12).getTime())).toBe(
      "genshintools-backup-2026-10-03.json"
    );
  });
});
