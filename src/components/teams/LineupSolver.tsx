import { Loader2, Play } from "lucide-react";
import { useMemo, useState } from "react";
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
import { planAbyssChambers } from "@/domain/combat/lineup/abyssPairs";
import { calibrateCandidates } from "@/domain/combat/lineup/candidates";
import {
  LINEUP_DEFAULT_TIME_BUDGET_SEC,
  LINEUP_MARGIN_TIE_PERCENT,
  LINEUP_PAIRINGS_SHOWN,
  LINEUP_TIME_BUDGET_OPTIONS_SEC,
} from "@/domain/combat/lineup/constants";
import { allSlots } from "@/domain/enums";
import { calibratedMargin } from "@/domain/team/lineup";
import type {
  AbyssChamberPlan,
  AbyssPairing,
  AbyssTimerRule,
  CalibratedCandidate,
  LineupIssueReason,
  LineupSolverRequest,
  LineupSolverResult,
  LineupSolverTeam,
} from "@/domain/team/lineupSolverTypes";
import type { Calibration, Encounter } from "@/domain/team/lineupTypes";
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
import { LINEUP_HEADER_CLS, LINEUP_SECTION_CLS } from "./LineupEncounters";
import { getArtifactSetLabel } from "./WeaponChoiceResultCard";

type Translate = ReturnType<typeof useLanguage>["t"];

const LABEL_CLS =
  "whitespace-nowrap text-xs font-semibold text-foreground select-none md:text-sm";
const SELECT_CLS =
  "h-7 w-auto gap-1 border-foreground/25 bg-background/50 px-2 text-xs font-bold md:text-sm";

/** Lineup settings for this session. */
let sessionSettings: { timeBudgetSec: number; timerRule: AbyssTimerRule } = {
  timeBudgetSec: LINEUP_DEFAULT_TIME_BUDGET_SEC,
  timerRule: "per-half",
};

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

function MarginValue({ margin, tied }: { margin: number; tied?: boolean }) {
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

interface TeamNames {
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
          <div className="ml-1 flex min-w-0 gap-0.5">
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

function HalfDetail({
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
        <span className="text-xs font-semibold text-muted-foreground md:text-sm">
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

function PairingRow({
  pairing,
  candidatesById,
  tied,
  selected,
  onSelect,
}: {
  pairing: AbyssPairing;
  candidatesById: Map<string, CalibratedCandidate>;
  /** Not the best, but tied with it within model error. */
  tied: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useLanguage();
  const halves = [pairing.firstId, pairing.secondId].map((id) =>
    id ? (candidatesById.get(id) ?? null) : null
  );
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md border px-2 py-1 text-left text-xs md:text-sm",
        selected
          ? "border-primary bg-primary/10"
          : "border-foreground/15 hover:bg-accent"
      )}
    >
      {halves.map((candidate) =>
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
        {t.ui("lineup.margin")}{" "}
        <MarginValue margin={pairing.margin} tied={tied} />
      </span>
    </button>
  );
}

function pairingKey(pairing: AbyssPairing): string {
  return `${pairing.firstId}|${pairing.secondId}`;
}

function ChamberCard({
  plan,
  candidatesById,
  timerRule,
  issuesFor,
  names,
}: {
  plan: AbyssChamberPlan;
  candidatesById: Map<string, CalibratedCandidate>;
  timerRule: AbyssTimerRule;
  issuesFor: (encounterId: string | null) => string[];
  names: TeamNames;
}) {
  const { t } = useLanguage();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const pairing =
    plan.pairings.find((entry) => pairingKey(entry) === selectedKey) ??
    plan.pairings[0];
  const candidate = (id: string | null | undefined) =>
    id ? (candidatesById.get(id) ?? null) : null;
  const bothHalves =
    plan.bestAlone.first != null && plan.bestAlone.second != null;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-foreground/15 bg-background/30 p-2 md:p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="mr-auto text-sm font-bold md:text-base">
          {t.format("lineup.abyssChamber", plan.chamber)}
        </span>
        {pairing && (
          <span className="text-xs md:text-sm">
            <span className="font-semibold">
              {timerRule === "shared"
                ? t.ui("lineup.chamberMargin")
                : t.ui("lineup.weakestHalf")}
            </span>{" "}
            <MarginValue margin={pairing.margin} />
          </span>
        )}
      </div>
      {!pairing && bothHalves ? (
        <p className="text-xs text-muted-foreground md:text-sm">
          {t.ui("lineup.noPairing")}
        </p>
      ) : (
        <div className="grid gap-2 xl:grid-cols-2">
          {plan.firstEncounterId && (
            <HalfDetail
              label={t.ui("lineup.firstHalf")}
              candidate={candidate(pairing?.firstId)}
              bestAlone={plan.bestAlone.first}
              issues={issuesFor(plan.firstEncounterId)}
              names={names}
            />
          )}
          {plan.secondEncounterId && (
            <HalfDetail
              label={t.ui("lineup.secondHalf")}
              candidate={candidate(pairing?.secondId)}
              bestAlone={plan.bestAlone.second}
              issues={issuesFor(plan.secondEncounterId)}
              names={names}
            />
          )}
        </div>
      )}
      {plan.pairings.length > 1 && (
        <div className="flex flex-col gap-1">
          <span
            className={LABEL_CLS}
            title={
              timerRule === "shared"
                ? t.format(
                    "lineup.pairingsTipShared",
                    LINEUP_MARGIN_TIE_PERCENT
                  )
                : t.format("lineup.pairingsTip", LINEUP_MARGIN_TIE_PERCENT)
            }
          >
            {t.ui("lineup.pairings")}
          </span>
          {plan.pairings.map((entry, index) => (
            <PairingRow
              key={pairingKey(entry)}
              pairing={entry}
              candidatesById={candidatesById}
              tied={
                index > 0 &&
                Math.abs(entry.margin - plan.pairings[0].margin) <=
                  (plan.pairings[0].margin * LINEUP_MARGIN_TIE_PERCENT) / 100
              }
              selected={entry === pairing}
              onSelect={() => setSelectedKey(pairingKey(entry))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Issue lines per Abyss half for calibrated templates without candidates. */
function useIssueLines(
  result: LineupSolverResult | null,
  candidates: readonly CalibratedCandidate[],
  calibrations: readonly Calibration[],
  encounters: readonly Encounter[],
  names: TeamNames
) {
  const { t } = useLanguage();
  return (encounterId: string | null): string[] => {
    const encounter = encounters.find((entry) => entry.id === encounterId);
    if (!encounter || !result) return [];
    return calibrations.flatMap((calibration) => {
      if (
        calibration.encounterId !== encounter.id ||
        candidates.some(
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

export function LineupSolver() {
  const { t } = useLanguage();
  const encounters = useLineupStore((s) => s.encounters);
  const templates = useLineupStore((s) => s.templates);
  const calibrations = useLineupStore((s) => s.calibrations);
  const teamCompById = useTeamStore((s) => s.teamCompById);
  const configsByTeamId = useTeamStore((s) => s.configsByTeamId);
  const getSetupConfig = useTeamStore((s) => s.getTeamSetupConfigById);
  const comboOverrides = useBuffOverrideStore((s) => s.comboOverrides);
  const accountData = useActiveAccountData();
  const names = useTemplateNames();
  const [settings, setSettings] = useState(sessionSettings);
  const updateSettings = (next: typeof settings) => {
    sessionSettings = next;
    setSettings(next);
  };

  const abyss = useMemo(
    () => encounters.filter((encounter) => encounter.mode === "abyss"),
    [encounters]
  );
  const abyssCalibrations = useMemo(
    () =>
      calibrations.filter((calibration) =>
        abyss.some((encounter) => encounter.id === calibration.encounterId)
      ),
    [calibrations, abyss]
  );
  const teams = useMemo<LineupSolverTeam[]>(
    () =>
      templates.flatMap((template) => {
        const teamComp = teamCompById[template.teamId];
        if (
          !teamComp ||
          !abyssCalibrations.some((entry) => entry.templateId === template.id)
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
    [
      templates,
      teamCompById,
      configsByTeamId,
      getSetupConfig,
      abyssCalibrations,
    ]
  );
  const accountKey = useMemo(() => JSON.stringify(accountData), [accountData]);
  // Clear times, downtime and bars only change margins, which are computed
  // from the current clears, so they are left out.
  const signature = useMemo(
    () =>
      JSON.stringify({
        account: accountKey,
        encounters: abyss.map(
          ({ downtimeSeconds: _d, timeBarSeconds: _b, targets: _t, ...rest }) =>
            rest
        ),
        calibrations: abyssCalibrations.map(
          ({ measuredSeconds: _m, downtimeSeconds: _d, ...rest }) => rest
        ),
        teams,
        comboOverrides,
        timeBudgetSec: settings.timeBudgetSec,
      }),
    [
      accountKey,
      abyss,
      abyssCalibrations,
      teams,
      comboOverrides,
      settings.timeBudgetSec,
    ]
  );
  const solver = useLineupSolver(signature);
  const { result } = solver;

  const calibrated = useMemo(
    () =>
      result
        ? calibrateCandidates(result.candidates, calibrations, encounters)
        : [],
    [result, calibrations, encounters]
  );
  // Chambers without a recorded clear on either half have nothing to show.
  const plans = useMemo(
    () =>
      result
        ? planAbyssChambers(
            abyss,
            calibrated,
            result.weaponCopies,
            settings.timerRule,
            LINEUP_MARGIN_TIE_PERCENT,
            LINEUP_PAIRINGS_SHOWN
          ).filter((plan) =>
            abyssCalibrations.some(
              (calibration) =>
                calibration.encounterId === plan.firstEncounterId ||
                calibration.encounterId === plan.secondEncounterId
            )
          )
        : [],
    [result, abyss, abyssCalibrations, calibrated, settings.timerRule]
  );
  const candidatesById = useMemo(
    () => new Map(calibrated.map((candidate) => [candidate.id, candidate])),
    [calibrated]
  );
  const issuesFor = useIssueLines(
    result,
    calibrated,
    abyssCalibrations,
    abyss,
    names
  );

  if (abyss.length === 0) return null;
  const canRun = accountData != null && teams.length > 0;
  const run = () => {
    if (!accountData) return;
    const request: LineupSolverRequest = {
      mode: "abyss",
      accountData,
      encounters: abyss,
      teams,
      calibrations: abyssCalibrations,
      comboOverrides,
      timeBudgetSec: settings.timeBudgetSec,
    };
    solver.start(request);
  };
  const stageLabels: Record<LineupSolverProgress["stage"], string> = {
    screen: t.ui("teamComp.teamSetsStageScreen"),
    optimize: t.ui("teamComp.teamSetsStageOptimize"),
    diversify: t.ui("lineup.stageDiversify"),
  };
  const { progress } = solver;

  return (
    <section className={LINEUP_SECTION_CLS}>
      <div className={LINEUP_HEADER_CLS}>
        <h2 className="mr-auto text-base font-bold tracking-tight">
          {t.ui("lineup.abyssLineups")}
        </h2>
      </div>
      <div className="flex flex-col gap-2 p-2 md:p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <div className="flex items-center gap-1">
            <span className={LABEL_CLS}>{t.ui("lineup.timePerTeam")}</span>
            <Select
              value={String(settings.timeBudgetSec)}
              disabled={solver.isComputing}
              onValueChange={(value) =>
                updateSettings({ ...settings, timeBudgetSec: Number(value) })
              }
            >
              <SelectTrigger
                className={SELECT_CLS}
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
          <div className="flex items-center gap-1">
            <span className={LABEL_CLS}>{t.ui("lineup.timer")}</span>
            <Select
              value={settings.timerRule}
              onValueChange={(value) =>
                updateSettings({
                  ...settings,
                  timerRule: value as AbyssTimerRule,
                })
              }
            >
              <SelectTrigger
                className={SELECT_CLS}
                aria-label={t.ui("lineup.timer")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per-half">
                  {t.ui("lineup.timerPerHalf")}
                </SelectItem>
                <SelectItem value="shared">
                  {t.ui("lineup.timerShared")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col items-center gap-1 py-1">
          <Button
            onClick={solver.isComputing ? solver.stop : run}
            disabled={!solver.isComputing && !canRun}
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
          {!canRun && (
            <p className="text-center text-xs text-muted-foreground md:text-sm">
              {accountData
                ? t.ui("lineup.needAbyssClear")
                : t.ui("lineup.needAccountLineups")}
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
              ? t.ui("lineup.needAbyssClear")
              : t.ui("charactersMode.errors.calculator")}
          </p>
        )}
        {result && (
          <div className="grid gap-2 2xl:grid-cols-2">
            {plans.map((plan) => (
              <ChamberCard
                key={plan.chamber}
                plan={plan}
                candidatesById={candidatesById}
                timerRule={settings.timerRule}
                issuesFor={issuesFor}
                names={names}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
