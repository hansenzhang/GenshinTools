import { AlertCircle, Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import {
  buildBackupFilePartitions,
  importBackupFilePartitions,
} from "@/contexts/backup/storeAdapters";
import { useLanguage } from "@/contexts/LanguageContext";
import { downloadJson } from "@/lib/downloadJson";
import {
  type BackupFileSection,
  type BackupFileSectionId,
  backupFileName,
  createBackupFile,
  type ParsedBackupFile,
  parseBackupFile,
  partitionsForSections,
} from "@/services/backup/backupFile";

type Translator = ReturnType<typeof useLanguage>["t"];
type LoadedBackup = Extract<ParsedBackupFile, { ok: true }>;

interface BackupFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BackupFileDialog({
  open,
  onOpenChange,
}: BackupFileDialogProps) {
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<LoadedBackup | null>(null);
  const [selected, setSelected] = useState<Set<BackupFileSectionId>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setLoaded(null);
      setError(null);
    }
    onOpenChange(next);
  };

  const handleExport = () => {
    const createdAt = Date.now();
    downloadJson(
      backupFileName(createdAt),
      createBackupFile(buildBackupFilePartitions(), createdAt)
    );
    toast.success(t.ui("accountSystem.backupFile.exported"));
  };

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const parsed = parseBackupFile(await file.text());
    if (!parsed.ok) {
      setLoaded(null);
      setError(parseErrorMessage(parsed.reason, t));
      return;
    }
    setError(null);
    setLoaded(parsed);
    setSelected(new Set(parsed.sections.map((section) => section.id)));
  };

  const toggleSection = (id: BackupFileSectionId, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleRestore = () => {
    if (!loaded) return;
    try {
      const result = importBackupFilePartitions(
        partitionsForSections(loaded.partitions, selected)
      );
      if (result.templatesMissingTeams > 0) {
        toast.warning(
          t
            .ui("accountSystem.backupFile.missingTeams")
            .replace("{0}", String(result.templatesMissingTeams))
        );
      } else {
        toast.success(t.ui("accountSystem.backupFile.restored"));
      }
      handleOpenChange(false);
    } catch (restoreError) {
      console.error("Failed to restore backup file", restoreError);
      setError(t.ui("accountSystem.backupFile.restoreFailed"));
    }
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent className="md:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t.ui("accountSystem.backupFile.menu")}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {t.ui("accountSystem.backupFile.description")}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="space-y-4 px-4 pb-2 md:px-0">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button variant="outline" className="gap-2" onClick={handleExport}>
              <Download className="w-4 h-4" />
              {t.ui("accountSystem.backupFile.export")}
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="w-4 h-4" />
              {t.ui("accountSystem.backupFile.chooseFile")}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void handleFile(event)}
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loaded && (
            <div className="space-y-3">
              {loaded.createdAt > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t
                    .ui("accountSystem.backupFile.fileFrom")
                    .replace(
                      "{0}",
                      new Date(loaded.createdAt).toLocaleString()
                    )}
                </p>
              )}
              <div className="space-y-2">
                {loaded.sections.map((section) => (
                  <label
                    key={section.id}
                    htmlFor={`backup-section-${section.id}`}
                    className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
                  >
                    <Checkbox
                      id={`backup-section-${section.id}`}
                      checked={selected.has(section.id)}
                      onCheckedChange={(checked) =>
                        toggleSection(section.id, checked === true)
                      }
                    />
                    <span className="flex-1">{sectionLabel(section, t)}</span>
                    {section.count !== undefined && (
                      <span className="text-muted-foreground">
                        {sectionCount(section, t)}
                      </span>
                    )}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t.ui("accountSystem.backupFile.restoreHint")}
              </p>
            </div>
          )}
        </div>

        {loaded && (
          <ResponsiveDialogFooter>
            <Button disabled={selected.size === 0} onClick={handleRestore}>
              {t.ui("accountSystem.backupFile.restore")}
            </Button>
          </ResponsiveDialogFooter>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function parseErrorMessage(
  reason: Extract<ParsedBackupFile, { ok: false }>["reason"],
  t: Translator
): string {
  switch (reason) {
    case "not-json":
      return t.ui("accountSystem.backupFile.notJson");
    case "not-a-backup":
      return t.ui("accountSystem.backupFile.notBackup");
    case "newer-version":
      return t.ui("accountSystem.backupFile.newerVersion");
  }
}

function sectionLabel(section: BackupFileSection, t: Translator): string {
  switch (section.id) {
    case "account":
      return t.ui("accountSystem.backupFile.sections.account");
    case "builds":
      return t.ui("app.navArtifactFilter");
    case "teams":
      return t.ui("lineup.teams");
    case "tiers":
      return t.ui("accountSystem.metadata.tiers");
    case "lineups":
      return t.ui("teamComp.tabLineups");
  }
}

function sectionCount(section: BackupFileSection, t: Translator): string {
  const count = String(section.count ?? 0);
  return section.id === "account"
    ? t
        .ui("accountSystem.backupFile.sections.accountCount")
        .replace("{0}", count)
    : t
        .ui("accountSystem.backupFile.sections.lineupsCount")
        .replace("{0}", count);
}
