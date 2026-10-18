import { Loader2, Play } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { ArtifactDataHoverCard } from "@/components/shared/ArtifactDataHoverCard";
import { CharAvatar } from "@/components/shared/CharAvatar";
import { VALUE_COLORS } from "@/components/shared/colors";
import { ItemIcon } from "@/components/shared/ItemIcon";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { calibrateCandidates } from "@/domain/combat/lineup/candidates";
import {
  LINEUP_MARGIN_TIE_PERCENT,
  LINEUP_TIME_BUDGET_OPTIONS_SEC,
} from "@/domain/combat/lineup/constants";
import { allSlots } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import { calibratedMargin } from "@/domain/team/lineup";
import type {
  BindingItem,
  CalibratedCandidate,
  LineupIssueReason,
  LineupSolverTeam,
} from "@/domain/team/lineupSolverTypes";
import type { EncounterMode } from "@/domain/team/lineupTypes";
import { teamCalculationInputs } from "@/domain/team/teamDeltas";
import { useActiveAccountData } from "@/hooks/useActiveAccount";
import {
  type LineupSolverProgress,
  useLineupSolver,
} from "@/hooks/useLineupSolver";
import { cn } from "@/lib/utils";
import { useBuffOverrideStore } from "@/stores/useBuffOverrideStore";
import { useLineupStore } from "@/stores/useLineupStore";
import { useTeamStore } from "@/stores/useTeamStore";
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

export function useTemplateNames(): TeamNames {
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

/**
 * The candidate job for one mode: its encounters, recorded clears and teams,
 * the run's inputs and candidates with margins from the current clears.
 * Clear times, downtime and bars are left out of the inputs, since they only
 * change margins.
 */
export function useLineupJob(mode: EncounterMode, timeBudgetSec: number) {
  const allEncounters = useLineupStore((s) => s.encounters);
  const templates = useLineupStore((s) => s.templates);
  const allCalibrations = useLineupStore((s) => s.calibrations);
  const teamCompById = useTeamStore((s) => s.teamCompById);
  const configsByTeamId = useTeamStore((s) => s.configsByTeamId);
  const getSetupConfig = useTeamStore((s) => s.getTeamSetupConfigById);
  const comboOverrides = useBuffOverrideStore((s) => s.comboOverrides);
  const accountData = useActiveAccountData();

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
            setupConfig: teamCalculationInputs(
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
        calibrations: calibrations.map(
          ({ measuredSeconds: _m, downtimeSeconds: _d, ...rest }) => rest
        ),
        teams,
        comboOverrides,
        timeBudgetSec,
      }),
    [accountKey, encounters, calibrations, teams, comboOverrides, timeBudgetSec]
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
  const run = () => {
    if (!accountData) return;
    solver.start({
      mode,
      accountData,
      encounters,
      teams,
      calibrations,
      comboOverrides,
      timeBudgetSec,
    });
  };
  return {
    encounters,
    calibrations,
    solver,
    calibrated,
    hasAccount: accountData != null,
    canRun: accountData != null && teams.length > 0,
    run,
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

export function TimeBudgetSelect({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (seconds: number) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex items-center gap-1">
      <span className={LINEUP_LABEL_CLS}>{t.ui("lineup.timePerTeam")}</span>
      <Select
        value={String(value)}
        disabled={disabled}
        onValueChange={(next) => onChange(Number(next))}
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
              {seconds}s
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Settings row, Run/Stop, a hint when it cannot run, progress and errors. */
export function LineupRunControls({
  job,
  settings,
  needClearHint,
}: {
  job: ReturnType<typeof useLineupJob>;
  settings: ReactNode;
  needClearHint: string;
}) {
  const { t } = useLanguage();
  const { solver } = job;
  const { progress } = solver;
  const stageLabels: Record<LineupSolverProgress["stage"], string> = {
    screen: t.ui("teamComp.teamSetsStageScreen"),
    optimize: t.ui("teamComp.teamSetsStageOptimize"),
    diversify: t.ui("lineup.stageDiversify"),
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {settings}
      </div>
      <div className="flex flex-col items-center gap-1 py-1">
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

function CandidateMembers({ candidate }: { candidate: CalibratedCandidate }) {
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
                    level={`+${artifact.level}`}
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
}: {
  label: string;
  candidate: CalibratedCandidate | null;
  bestAlone: number | null;
  issues: string[];
  names: TeamNames;
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
            {candidate.origin === "pieces-excluded" && (
              <span>{t.ui("lineup.originPieces")}</span>
            )}
            {candidate.origin === "weapon-swapped" && (
              <span>{t.ui("lineup.originWeapon")}</span>
            )}
          </div>
          <CandidateMembers candidate={candidate} />
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
