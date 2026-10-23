import { FileDown, FileUp, Loader2, Play, X } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ArtifactDataHoverCard } from "@/components/shared/ArtifactDataHoverCard";
import { CharAvatar } from "@/components/shared/CharAvatar";
import { VALUE_COLORS } from "@/components/shared/colors";
import { ItemIcon } from "@/components/shared/ItemIcon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { getAllArtifacts } from "@/domain/build/artifact/inventory";
import { calibrateCandidates } from "@/domain/combat/lineup/candidates";
import {
  LINEUP_MARGIN_TIE_PERCENT,
  LINEUP_TIME_BUDGET_OPTIONS_SEC,
} from "@/domain/combat/lineup/constants";
import {
  buildLineupDebugExport,
  readLineupDebugExport,
} from "@/domain/combat/lineup/debugExport";
import { maxPieceLevel } from "@/domain/combat/lineup/levelling";
import { allSlots } from "@/domain/enums";
import { runTriage } from "@/domain/game-account/triage/triageEngine";
import type { ArtifactData } from "@/domain/models";
import { calibratedMargin } from "@/domain/team/lineup";
import type {
  BindingItem,
  CalibratedCandidate,
  LineupDebugPlan,
  LineupIssueReason,
  LineupRunProgress,
  LineupSolverRequest,
  LineupSolverTeam,
  MissingPiece,
} from "@/domain/team/lineupSolverTypes";
import type { EncounterMode } from "@/domain/team/lineupTypes";
import { normalizeTeamSetupConfig } from "@/domain/team/teamDeltas";
import type { OptPhase } from "@/domain/team/types";
import { useActiveAccountData } from "@/hooks/useActiveAccount";
import {
  closeLineupRun,
  type LineupSolverProgress,
  useLineupSolver,
  useViewedLineupRun,
  viewLineupRun,
} from "@/hooks/useLineupSolver";
import { cn } from "@/lib/utils";
import { useBuffOverrideStore } from "@/stores/useBuffOverrideStore";
import {
  selectEnabledBuildGroups,
  selectResolvedBuildGroups,
  useBuildsStore,
} from "@/stores/useBuildsStore";
import { useLineupStore } from "@/stores/useLineupStore";
import { useTeamStore } from "@/stores/useTeamStore";
import {
  selectActiveTriageSettings,
  useTriageStore,
} from "@/stores/useTriageStore";
import { getArtifactSetLabel } from "./WeaponChoiceResultCard";

type Translate = ReturnType<typeof useLanguage>["t"];

export const LINEUP_LABEL_CLS =
  "whitespace-nowrap text-xs font-semibold text-foreground select-none md:text-sm";
export const LINEUP_SELECT_CLS =
  "h-7 w-auto gap-1 border-foreground/25 bg-background/50 px-2 text-xs font-bold md:text-sm";

/** Bindings shown per lineup. */
const BINDING_SHOWN = 6;

export function MarginValue({
  margin,
  tied,
}: {
  margin: number;
  tied?: boolean;
}) {
  return (
    <span
      className={cn(
        "font-bold tabular-nums",
        margin >= 1 ? VALUE_COLORS.positive : VALUE_COLORS.negative
      )}
    >
      {tied ? "≈" : ""}×{margin.toFixed(2)}
    </span>
  );
}

function issueText(
  reason: LineupIssueReason | "no-bar" | "downtime-too-long",
  t: Translate
) {
  switch (reason) {
    case "no-bar":
      return t.ui("lineup.marginNoBar");
    case "downtime-too-long":
      return t.ui("lineup.marginDowntime");
    case "no-objective":
      return t.ui("lineup.issueNoObjective");
    case "reference-unscored":
      return t.ui("lineup.issueReference");
    case "no-composition":
      return t.ui("lineup.issueNoComposition");
    case "no-candidate":
      return t.ui("lineup.issueNoCandidate");
    default:
      return t.ui("charactersMode.errors.calculator");
  }
}

export interface TeamNames {
  name: (templateId: string) => string;
}

function useTemplateNames(): TeamNames {
  const { t } = useLanguage();
  const templates = useLineupStore((s) => s.templates);
  const teams = useTeamStore((s) => s.teamComps);
  return {
    name: (templateId) => {
      const template = templates.find((entry) => entry.id === templateId);
      const index = teams.findIndex((team) => team.id === template?.teamId);
      if (index === -1) return t.ui("lineup.teamRemoved");
      return teams[index].name || t.format("teamComp.teamIndex", index + 1);
    },
  };
}

/** Team names as an exported run saved them. */
function requestTemplateNames(
  request: LineupSolverRequest,
  t: Translate
): TeamNames {
  return {
    name: (templateId) => {
      const index = request.teams.findIndex(
        (team) => team.template.id === templateId
      );
      if (index === -1) return t.ui("lineup.teamRemoved");
      return (
        request.teams[index].teamComp.name ||
        t.format("teamComp.teamIndex", index + 1)
      );
    },
  };
}

/**
 * The candidate job for one mode: its encounters, recorded clears and teams,
 * the run's inputs and candidates with margins from the current clears.
 * Clear times, downtime and bars are left out of the inputs, since they only
 * change margins. While an exported run is open, everything shown comes from
 * the file; Find lineups still runs the current setup.
 */
export function useLineupJob(
  mode: EncounterMode,
  timeBudgetSec: number | null,
  keepersOnly: boolean,
  levelToMax: boolean
) {
  const allEncounters = useLineupStore((s) => s.encounters);
  const templates = useLineupStore((s) => s.templates);
  const allCalibrations = useLineupStore((s) => s.calibrations);
  const teamCompById = useTeamStore((s) => s.teamCompById);
  const configsByTeamId = useTeamStore((s) => s.configsByTeamId);
  const getSetupConfig = useTeamStore((s) => s.getTeamSetupConfigById);
  const comboOverrides = useBuffOverrideStore((s) => s.comboOverrides);
  const accountData = useActiveAccountData();
  const buildGroups = useBuildsStore(selectEnabledBuildGroups);
  const allBuildGroups = useBuildsStore(selectResolvedBuildGroups);
  const triageSettings = useTriageStore(selectActiveTriageSettings);
  const { t } = useLanguage();
  const storeNames = useTemplateNames();
  const viewed = useViewedLineupRun(mode);
  // Locked pieces and the ones Triage recommends locking.
  const keeperArtifactIds = useMemo(() => {
    if (!keepersOnly || !accountData) return undefined;
    const { decisions } = runTriage(
      accountData,
      buildGroups,
      triageSettings,
      allBuildGroups
    );
    return [
      ...new Set([
        ...getAllArtifacts(accountData).flatMap((artifact) =>
          artifact.lock ? [artifact.id] : []
        ),
        ...decisions.flatMap((decision) =>
          decision.label === "lock" ? [decision.artifact.id] : []
        ),
      ]),
    ].sort();
  }, [keepersOnly, accountData, buildGroups, triageSettings, allBuildGroups]);

  const encounters = useMemo(
    () => allEncounters.filter((encounter) => encounter.mode === mode),
    [allEncounters, mode]
  );
  const calibrations = useMemo(
    () =>
      allCalibrations.filter((calibration) =>
        encounters.some((encounter) => encounter.id === calibration.encounterId)
      ),
    [allCalibrations, encounters]
  );
  const teams = useMemo<LineupSolverTeam[]>(
    () =>
      templates.flatMap((template) => {
        const teamComp = teamCompById[template.teamId];
        if (
          !teamComp ||
          !calibrations.some((entry) => entry.templateId === template.id)
        )
          return [];
        return [
          {
            template,
            teamComp,
            setupConfig: normalizeTeamSetupConfig(
              configsByTeamId[teamComp.id] ?? getSetupConfig(teamComp.id)
            ),
          },
        ];
      }),
    [templates, teamCompById, configsByTeamId, getSetupConfig, calibrations]
  );
  const accountKey = useMemo(() => JSON.stringify(accountData), [accountData]);
  const signature = useMemo(
    () =>
      JSON.stringify({
        account: accountKey,
        encounters: encounters.map(
          ({ downtimeSeconds: _d, timeBarSeconds: _b, targets: _t, ...rest }) =>
            rest
        ),
        // The measured clear only turns damage into margins, unless it
        // weights the encounter's RES phases.
        calibrations: calibrations.map(
          ({ measuredSeconds, downtimeSeconds: _d, ...rest }) =>
            encounters.some(
              (encounter) =>
                encounter.id === rest.encounterId &&
                encounter.resPhases.length > 0
            )
              ? { ...rest, measuredSeconds }
              : rest
        ),
        teams,
        comboOverrides,
        timeBudgetSec,
        keeperArtifactIds,
        levelToMax,
      }),
    [
      accountKey,
      encounters,
      calibrations,
      teams,
      comboOverrides,
      timeBudgetSec,
      keeperArtifactIds,
      levelToMax,
    ]
  );
  const solver = useLineupSolver(mode, signature);
  const { result } = solver;
  const calibrated = useMemo(
    () =>
      result
        ? calibrateCandidates(result.candidates, calibrations, encounters)
        : [],
    [result, calibrations, encounters]
  );
  const request = useMemo<LineupSolverRequest | null>(
    () =>
      accountData
        ? {
            mode,
            accountData,
            encounters,
            teams,
            calibrations,
            comboOverrides,
            timeBudgetSec,
            keeperArtifactIds,
            levelToMax,
          }
        : null,
    [
      mode,
      accountData,
      encounters,
      teams,
      calibrations,
      comboOverrides,
      timeBudgetSec,
      keeperArtifactIds,
      levelToMax,
    ]
  );
  const artifacts = useMemo(
    () => (accountData ? getAllArtifacts(accountData) : []),
    [accountData]
  );
  const run = () => {
    if (request) solver.start(request);
  };
  const view = useMemo(() => {
    if (!viewed) return null;
    const viewedEncounters = viewed.request.encounters.filter(
      (encounter) => encounter.mode === mode
    );
    return {
      exportedAt: viewed.exportedAt,
      encounters: viewedEncounters,
      calibrations: viewed.request.calibrations.filter((calibration) =>
        viewedEncounters.some(
          (encounter) => encounter.id === calibration.encounterId
        )
      ),
      request: viewed.request,
      signature: `file:${viewed.exportedAt}`,
      calibrated: viewed.calibrated,
      artifacts: getAllArtifacts(viewed.request.accountData),
      levelToMax: viewed.request.levelToMax === true,
    };
  }, [viewed, mode]);
  /** Shows an exported run in this section, or says why it cannot. */
  const openDebug = async (file: File) => {
    const text = await file.text().catch(() => "");
    const read = readLineupDebugExport(text);
    if (read.kind === "not-export") toast.error(t.ui("lineup.debugNotExport"));
    else if (read.kind === "unsupported-version")
      toast.error(t.format("lineup.debugVersion", read.version));
    else if (read.data.request.mode !== mode)
      toast.error(
        read.data.request.mode === "abyss"
          ? t.ui("lineup.debugAbyssFile")
          : t.ui("lineup.debugStygianFile")
      );
    else viewLineupRun(read.data);
  };
  /** Saves the run's inputs and results as a JSON file. */
  const exportDebug = (plan: LineupDebugPlan) => {
    if (!request || !result) return;
    const exportedAt = new Date();
    const data = buildLineupDebugExport(
      request,
      result,
      calibrated,
      plan,
      exportedAt
    );
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `lineup-debug-${mode}-${exportedAt.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return {
    encounters: view?.encounters ?? encounters,
    calibrations: view?.calibrations ?? calibrations,
    solver: view
      ? {
          ...solver,
          result: viewed?.result ?? null,
          progress: null,
          error: null,
          isComputing: false,
          startedAt: null,
        }
      : solver,
    /** The shown run's inputs; null without an account. */
    request: view?.request ?? request,
    /** The inputs that change candidates: clear times and bars are left
     *  out, unless a clear weights its encounter's RES phases. */
    signature: view?.signature ?? signature,
    calibrated: view?.calibrated ?? calibrated,
    /** The account's pieces, for filling members that take any pieces. */
    artifacts: view?.artifacts ?? artifacts,
    /** The shown run scores pieces below max level as levelled: results
     *  follow the signature, which includes it. */
    levelToMax: view?.levelToMax ?? levelToMax,
    names: view ? requestTemplateNames(view.request, t) : storeNames,
    /** When the open exported run was saved; null for the live run. */
    viewedAt: view?.exportedAt ?? null,
    hasAccount: accountData != null,
    canRun: request != null && teams.length > 0,
    run,
    exportDebug,
    openDebug,
    closeView: () => closeLineupRun(mode),
  };
}

/** Issue lines per encounter for recorded clears that gave no candidate. */
export function useIssueLines(
  job: ReturnType<typeof useLineupJob>,
  names: TeamNames
) {
  const { t } = useLanguage();
  const { result } = job.solver;
  return (encounterId: string | null): string[] => {
    const encounter = job.encounters.find((entry) => entry.id === encounterId);
    if (!encounter || !result) return [];
    return job.calibrations.flatMap((calibration) => {
      if (
        calibration.encounterId !== encounter.id ||
        job.calibrated.some(
          (candidate) =>
            candidate.templateId === calibration.templateId &&
            candidate.encounterId === encounter.id
        )
      )
        return [];
      const readout = calibratedMargin(1, calibration, encounter);
      const reason =
        readout.kind !== "margin"
          ? readout.kind
          : result.issues.find(
              (issue) =>
                issue.templateId === calibration.templateId &&
                issue.encounterId === encounter.id
            )?.reason;
      return reason
        ? [`${names.name(calibration.templateId)}: ${issueText(reason, t)}`]
        : [];
    });
  };
}

/** Share of the whole run done, with re-runs as one last step. */
function progressShare(progress: LineupSolverProgress | null): number {
  if (!progress) return 0;
  const within = progress.total > 0 ? progress.done / progress.total : 0;
  const stage =
    progress.stage === "screen"
      ? within * 0.3
      : progress.stage === "optimize"
        ? 0.3 + within * 0.7
        : within;
  return (progress.task + stage) / (progress.tasks + 1);
}

/** A run option shown as a checkbox: Kept artifacts only, Level artifacts
 *  to max. */
export function RunOptionToggle({
  label,
  tip,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  tip: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="flex items-center gap-2 text-xs md:text-sm"
      title={tip}
    >
      <Checkbox
        id={id}
        className="border-foreground/30"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
      />
      {label}
    </label>
  );
}

/** A piece's level, with the max level the run scored it at when it
 *  levelled pieces whose stats matter. */
function pieceLevelLabel(artifact: ArtifactData, levelled: boolean): string {
  const max = maxPieceLevel(artifact.rarity);
  return levelled && max != null && artifact.level < max
    ? `+${artifact.level}→${max}`
    : `+${artifact.level}`;
}

/** Select value for running every finalist until its search finishes. */
const UNTIL_DONE = "until-done";

export function TimeBudgetSelect({
  value,
  disabled,
  onChange,
}: {
  /** Seconds per team; null runs until done. */
  value: number | null;
  disabled: boolean;
  onChange: (seconds: number | null) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex items-center gap-1">
      <span className={LINEUP_LABEL_CLS}>{t.ui("lineup.timePerTeam")}</span>
      <Select
        value={value == null ? UNTIL_DONE : String(value)}
        disabled={disabled}
        onValueChange={(next) =>
          onChange(next === UNTIL_DONE ? null : Number(next))
        }
      >
        <SelectTrigger
          className={LINEUP_SELECT_CLS}
          aria-label={t.ui("lineup.timePerTeam")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LINEUP_TIME_BUDGET_OPTIONS_SEC.map((seconds) => (
            <SelectItem key={seconds} value={String(seconds)}>
              {seconds < 60
                ? `${seconds}s`
                : t.format("lineup.minutes", seconds / 60)}
            </SelectItem>
          ))}
          <SelectItem value={UNTIL_DONE} title={t.ui("lineup.untilDoneTip")}>
            {t.ui("lineup.untilDone")}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/** Minutes and seconds since `startedAt`, ticking while a run computes. */
function useElapsed(startedAt: number | null, running: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const seconds = startedAt
    ? Math.max(0, Math.floor((now - startedAt) / 1000))
    : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Where an optimization on owned artifacts is: its phase with the members
 *  still searching, or its refinement round. */
function runPositionLabel(run: LineupRunProgress, t: Translate): string {
  const phases: Record<OptPhase, string> = {
    init: t.ui("teamComp.phaseInit"),
    phase1: t.ui("teamComp.phasePerChar"),
    phase2: t.ui("teamComp.phaseTeamAlloc"),
    phase3: t.ui("teamComp.phaseTeamRefine"),
  };
  const phase = phases[run.phase];
  if (run.searching.length > 0)
    return t.format(
      "lineup.runSearching",
      phase,
      run.searching
        .map((charId) => t.character(charId))
        .join(t.ui("common.listJoiner"))
    );
  return run.round != null
    ? t.format("lineup.runRound", phase, run.round)
    : phase;
}

/** Settings row, Run/Stop, a hint when it cannot run, progress and errors.
 *  A finished or stopped run can be saved with `debugPlan` for
 *  troubleshooting, and a saved one opened again; while it is open, a line
 *  says which run is shown in place of the settings. */
export function LineupRunControls({
  job,
  settings,
  needClearHint,
  debugPlan,
}: {
  job: ReturnType<typeof useLineupJob>;
  settings: ReactNode;
  needClearHint: string;
  debugPlan: LineupDebugPlan;
}) {
  const { t, language } = useLanguage();
  const { solver } = job;
  const { progress } = solver;
  const fileInput = useRef<HTMLInputElement>(null);
  const elapsed = useElapsed(solver.startedAt, solver.isComputing);
  const run = progress?.run;
  const runElapsed = useElapsed(run?.startedAt ?? null, solver.isComputing);
  const stageLabels: Record<LineupSolverProgress["stage"], string> = {
    screen: t.ui("teamComp.teamSetsStageScreen"),
    optimize: t.ui("teamComp.teamSetsStageOptimize"),
    diversify: t.ui("lineup.stageDiversify"),
  };
  return (
    <>
      {job.viewedAt ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5">
          <span className="mr-auto text-xs font-semibold md:text-sm">
            {t.format(
              "lineup.viewingRun",
              new Date(job.viewedAt).toLocaleString(language)
            )}
          </span>
          <Button onClick={job.closeView} variant="outline" size="sm">
            <X className="mr-1 h-4 w-4" />
            {t.ui("manager.close")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {settings}
        </div>
      )}
      <div className="flex flex-col items-center gap-1 py-1">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            onClick={solver.isComputing ? solver.stop : job.run}
            disabled={!solver.isComputing && !job.canRun}
            variant={solver.isComputing ? "destructive" : "default"}
            size="sm"
          >
            {solver.isComputing ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                {t.ui("common.stop")}
              </>
            ) : (
              <>
                <Play className="mr-1 h-4 w-4" />
                {t.ui("lineup.findLineups")}
              </>
            )}
          </Button>
          {solver.result && !solver.isComputing && !job.viewedAt && (
            <Button
              onClick={() => job.exportDebug(debugPlan)}
              variant="outline"
              size="sm"
              title={t.ui("lineup.exportDebugTip")}
            >
              <FileDown className="mr-1 h-4 w-4" />
              {t.ui("lineup.exportDebug")}
            </Button>
          )}
          {!solver.isComputing && (
            <Button
              onClick={() => fileInput.current?.click()}
              variant="outline"
              size="sm"
              title={t.ui("lineup.openDebugTip")}
            >
              <FileUp className="mr-1 h-4 w-4" />
              {t.ui("lineup.openDebug")}
            </Button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void job.openDebug(file);
            }}
          />
        </div>
        {!job.canRun && (
          <p className="text-center text-xs text-muted-foreground md:text-sm">
            {job.hasAccount ? needClearHint : t.ui("lineup.needAccountLineups")}
          </p>
        )}
      </div>
      {solver.isComputing && (
        <div className="space-y-1.5">
          <Progress
            value={Math.round(progressShare(progress) * 100)}
            className="h-2"
          />
          <p className="text-xs text-muted-foreground">
            {progress
              ? progress.stage === "diversify"
                ? `${stageLabels.diversify} ${progress.done}/${progress.total}`
                : `${t.format("lineup.progressTeam", progress.task + 1, progress.tasks)} · ${stageLabels[progress.stage]} ${progress.done}/${progress.total}`
              : t.ui("teamComp.weaponChoiceRunning")}
            {run &&
              ` · ${runPositionLabel(run, t)} · ${t.format("lineup.runTime", runElapsed)}`}
            {` · ${elapsed}`}
          </p>
        </div>
      )}
      {solver.error && (
        <p className="text-sm text-destructive">
          {solver.error === "no-calibrations"
            ? needClearHint
            : t.ui("charactersMode.errors.calculator")}
        </p>
      )}
    </>
  );
}

function CandidateMembers({
  candidate,
  levelled,
}: {
  candidate: CalibratedCandidate;
  levelled: boolean;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-col gap-1.5">
      {candidate.members.map((member) => (
        <div key={member.charId} className="flex min-w-0 items-center gap-1">
          <ItemIcon characterId={member.charId} size="xs" />
          <ItemIcon
            weaponId={member.weaponId}
            size="xs"
            badge={member.refinement}
            alt={t.weapon(member.weaponId)}
          />
          <div className="ml-1 flex shrink-0 gap-0.5">
            {allSlots.map((slot) => {
              const artifact = member.artifacts[slot];
              return artifact ? (
                <ArtifactDataHoverCard
                  key={slot}
                  artifact={artifact}
                  slot={slot}
                  side="bottom"
                >
                  <ItemIcon
                    artifactSetId={artifact.setKey}
                    slot={slot}
                    rarity={artifact.rarity}
                    level={pieceLevelLabel(
                      artifact,
                      levelled && !member.anyPieces
                    )}
                    size="xs"
                  />
                </ArtifactDataHoverCard>
              ) : (
                <div
                  key={slot}
                  className="h-10 w-10 shrink-0 rounded-sm border border-dashed border-foreground/25"
                />
              );
            })}
          </div>
          <span className="ml-1 hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
            {member.artifactSet
              ? getArtifactSetLabel(member.artifactSet, t)
              : t.ui("common.none")}
          </span>
          {member.anyPieces && (
            <span
              className="ml-1 shrink-0 text-xs font-semibold"
              title={t.ui("lineup.anyPiecesTip")}
            >
              {t.ui("lineup.anyPieces")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** One encounter's chosen team with its margin and gear, or why it has none. */
export function CandidateDetail({
  label,
  candidate,
  bestAlone,
  issues,
  names,
  levelled,
}: {
  label: string;
  candidate: CalibratedCandidate | null;
  bestAlone: number | null;
  issues: string[];
  names: TeamNames;
  /** The run scored pieces below max level as levelled. */
  levelled: boolean;
}) {
  const { t } = useLanguage();
  const change = candidate ? (candidate.ratio - 1) * 100 : 0;
  const costsMargin =
    candidate &&
    bestAlone != null &&
    candidate.margin < bestAlone * (1 - LINEUP_MARGIN_TIE_PERCENT / 100);
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-foreground/15 bg-background/30 p-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 truncate text-xs font-semibold text-muted-foreground md:text-sm">
          {label}
        </span>
        {candidate && (
          <>
            <span className="min-w-0 truncate text-sm font-bold">
              {names.name(candidate.templateId)}
            </span>
            <span className="ml-auto text-sm md:text-base">
              <MarginValue margin={candidate.margin} />
            </span>
          </>
        )}
      </div>
      {candidate ? (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              {t.format(
                "lineup.vsRecorded",
                `${change >= 0 ? "+" : ""}${change.toFixed(1)}`
              )}
            </span>
            {candidate.margin < 1 && (
              <span className={VALUE_COLORS.negative}>
                {t.format(
                  "lineup.needsMore",
                  ((1 / candidate.margin - 1) * 100).toFixed(0)
                )}
              </span>
            )}
            {costsMargin && (
              <span>{t.format("lineup.bestAlone", bestAlone.toFixed(2))}</span>
            )}
            {candidate.origin === "recorded" && (
              <span>{t.ui("lineup.originRecorded")}</span>
            )}
            {candidate.origin === "pieces-excluded" && (
              <span>{t.ui("lineup.originPieces")}</span>
            )}
            {candidate.origin === "weapon-swapped" && (
              <span>{t.ui("lineup.originWeapon")}</span>
            )}
          </div>
          <CandidateMembers candidate={candidate} levelled={levelled} />
        </>
      ) : (
        <ul className="space-y-0.5 text-xs text-muted-foreground md:text-sm">
          {(issues.length > 0 ? issues : [t.ui("lineup.noClearHalf")]).map(
            (issue) => (
              <li key={issue}>{issue}</li>
            )
          )}
        </ul>
      )}
    </div>
  );
}

/** A selectable lineup: each team's members and margin, then its overall
 *  margin. */
export function LineupRow({
  candidates,
  margin,
  label,
  tied,
  selected,
  onSelect,
}: {
  candidates: (CalibratedCandidate | null)[];
  margin: number;
  /** Names the lineup in place of the overall margin label. */
  label?: string;
  /** Not the best, but tied with it within model error. */
  tied: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useLanguage();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1 text-left text-xs md:text-sm",
        selected
          ? "border-primary bg-primary/10"
          : "border-foreground/15 hover:bg-accent"
      )}
    >
      {candidates.map((candidate) =>
        candidate ? (
          <span key={candidate.id} className="flex min-w-0 items-center gap-1">
            <span className="flex shrink-0 items-center gap-0.5">
              {candidate.members.map((member) => (
                <CharAvatar
                  key={member.charId}
                  charId={member.charId}
                  size={18}
                />
              ))}
            </span>
            <MarginValue margin={candidate.margin} />
          </span>
        ) : null
      )}
      <span className="ml-auto shrink-0 text-muted-foreground">
        {label ?? t.ui("lineup.margin")}{" "}
        <MarginValue margin={margin} tied={tied} />
      </span>
    </button>
  );
}

/**
 * Contested gear the lineup would miss most, with the margin left without.
 * Pieces one member wears that cost the same to lose read as one entry, and
 * gear no found build replaces is grouped at the end.
 */
export function BindingList({
  items,
  lineup,
}: {
  items: readonly BindingItem[];
  lineup: readonly CalibratedCandidate[];
}) {
  const { t } = useLanguage();
  if (items.length === 0) return null;
  const wornBy = new Map<string, { charId: string; artifact: ArtifactData }>();
  for (const candidate of lineup)
    for (const member of candidate.members)
      for (const artifact of Object.values(member.artifacts))
        if (artifact)
          wornBy.set(artifact.id, { charId: member.charId, artifact });
  type Entry = { key: string; item: BindingItem; artifacts: ArtifactData[] };
  const entries: Entry[] = [];
  for (const item of items) {
    const worn = item.kind === "artifact" ? wornBy.get(item.id) : undefined;
    const key = worn
      ? `artifact:${worn.charId}:${item.marginWithout ?? "none"}`
      : `${item.kind}:${item.id}`;
    const entry = entries.find((existing) => existing.key === key);
    if (entry && worn) entry.artifacts.push(worn.artifact);
    else entries.push({ key, item, artifacts: worn ? [worn.artifact] : [] });
  }
  const measured = entries.filter(({ item }) => item.marginWithout != null);
  const irreplaceable = entries.filter(
    ({ item }) => item.marginWithout == null
  );
  const describe = ({ item, artifacts }: Entry) => {
    const [artifact] = artifacts;
    const owner = artifact ? wornBy.get(artifact.id)?.charId : undefined;
    const name =
      item.kind === "character"
        ? t.character(item.id)
        : item.kind === "weapon"
          ? t.weapon(item.id)
          : artifact && owner
            ? `${t.character(owner)} · ${t.artifact(artifact.setKey)}`
            : item.id;
    const icon =
      item.kind === "character" ? (
        <ItemIcon characterId={item.id} size="xs" alt={name} />
      ) : item.kind === "weapon" ? (
        <ItemIcon weaponId={item.id} size="xs" alt={name} />
      ) : artifact ? (
        <ArtifactDataHoverCard
          artifact={artifact}
          slot={artifact.slotKey}
          side="bottom"
        >
          <ItemIcon
            artifactSetId={artifact.setKey}
            slot={artifact.slotKey}
            rarity={artifact.rarity}
            level={`+${artifact.level}`}
            size="xs"
            alt={name}
          />
        </ArtifactDataHoverCard>
      ) : null;
    return (
      <span className="flex items-center gap-1" title={name}>
        {icon}
        {artifacts.length > 1 && (
          <span className="font-semibold text-muted-foreground">
            ×{artifacts.length}
          </span>
        )}
      </span>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs md:text-sm">
      <span
        className={LINEUP_LABEL_CLS}
        title={t.ui("lineup.hardestToLoseTip")}
      >
        {t.ui("lineup.hardestToLose")}
      </span>
      {measured.slice(0, BINDING_SHOWN).map((entry) => (
        <span key={entry.key} className="flex items-center gap-1">
          {describe(entry)}
          <MarginValue margin={entry.item.marginWithout ?? 0} />
        </span>
      ))}
      {irreplaceable.length > 0 && (
        <span className="flex flex-wrap items-center gap-1">
          <span className={cn("font-semibold", VALUE_COLORS.negative)}>
            {t.ui("lineup.noAlternative")}
          </span>
          {irreplaceable.slice(0, BINDING_SHOWN).map((entry) => (
            <span key={entry.key}>{describe(entry)}</span>
          ))}
          {irreplaceable.length > BINDING_SHOWN && (
            <span className="text-muted-foreground">
              +{irreplaceable.length - BINDING_SHOWN}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/** Pieces that would lift the weakest margin past the tie: a set and slot
 *  that members taking any pieces of the set need, with the best weakest
 *  margin given one more. */
export function MissingPieceList({
  items,
}: {
  items: readonly MissingPiece[];
}) {
  const { t } = useLanguage();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs md:text-sm">
      <span
        className={LINEUP_LABEL_CLS}
        title={t.ui("lineup.missingPiecesTip")}
      >
        {t.ui("lineup.missingPieces")}
      </span>
      {items.slice(0, BINDING_SHOWN).map((item) => {
        const name = `${t.artifact(item.setKey)} · ${t.slot(item.slot)}`;
        return (
          <span
            key={`${item.setKey}:${item.slot}`}
            className="flex items-center gap-1"
            title={t.format("lineup.missingPieceOwned", name, item.owned)}
          >
            <ItemIcon
              artifactSetId={item.setKey}
              slot={item.slot}
              size="xs"
              alt={name}
            />
            <MarginValue margin={item.marginWith} />
          </span>
        );
      })}
    </div>
  );
}
