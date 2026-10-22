import { useMemo, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { fillAnyPieces } from "@/domain/combat/lineup/candidates";
import {
  LINEUP_DEFAULT_TIME_BUDGET_SEC,
  LINEUP_MARGIN_TIE_PERCENT,
} from "@/domain/combat/lineup/constants";
import type {
  StygianPlanKind,
  StygianPlanRequest,
} from "@/domain/team/lineupSolverTypes";
import { useStygianPlan } from "@/hooks/useStygianPlan";
import { LevellingAdvice } from "./LevellingAdvice";
import {
  LINEUP_HEADER_CLS,
  LINEUP_SECTION_CLS,
  useEncounterLabel,
} from "./LineupEncounters";
import {
  BindingList,
  CandidateDetail,
  LineupRow,
  LineupRunControls,
  MarginValue,
  RunOptionToggle,
  TimeBudgetSelect,
  useIssueLines,
  useLineupJob,
} from "./LineupResults";

/** Stygian lineup settings for this session. */
let sessionTimeBudgetSec: number | null = LINEUP_DEFAULT_TIME_BUDGET_SEC;
let sessionKeepersOnly = true;
let sessionLevelToMax = false;

export function StygianLineup() {
  const { t } = useLanguage();
  const encounterLabel = useEncounterLabel();
  const [timeBudgetSec, setTimeBudgetSec] = useState(sessionTimeBudgetSec);
  const [keepersOnly, setKeepersOnly] = useState(sessionKeepersOnly);
  const [levelToMax, setLevelToMax] = useState(sessionLevelToMax);
  const job = useLineupJob("stygian", timeBudgetSec, keepersOnly, levelToMax);
  const { encounters, calibrated, names } = job;
  const { result } = job.solver;
  const planRequest = useMemo<StygianPlanRequest | null>(
    () =>
      result
        ? {
            encounterIds: encounters.map((encounter) => encounter.id),
            candidates: calibrated,
            weaponCopies: result.weaponCopies,
            setSlotCounts: result.setSlotCounts,
            tiePercent: LINEUP_MARGIN_TIE_PERCENT,
          }
        : null,
    [result, encounters, calibrated]
  );
  const planState = useStygianPlan(planRequest);
  const [selectedKind, setSelectedKind] = useState<StygianPlanKind>("leximin");
  const issuesFor = useIssueLines(job, names);

  if (encounters.length === 0) return null;
  const plans = planState.result?.plans ?? [];
  const plan = plans.find((entry) => entry.kind === selectedKind) ?? plans[0];
  const candidate = (id: string | undefined) =>
    calibrated.find((entry) => entry.id === id) ?? null;
  const chosen = encounters.flatMap((encounter) => {
    const entry = candidate(plan?.candidateIds[encounter.id]);
    return entry ? [entry] : [];
  });
  // The plan's teams with free pieces for members that take any pieces.
  const shown = fillAnyPieces(chosen, job.artifacts);
  const bestAlone = (encounterId: string) => {
    const margins = calibrated.flatMap((entry) =>
      entry.encounterId === encounterId ? [entry.margin] : []
    );
    return margins.length > 0 ? Math.max(...margins) : null;
  };
  const planLabels: Record<StygianPlanKind, string> = {
    leximin: t.ui("lineup.planLeximin"),
    shortfall: t.ui("lineup.planShortfall"),
  };
  // Every boss has candidates, yet no lineup fields them all.
  const noLineup =
    result &&
    planState.result &&
    plans.length === 0 &&
    encounters.every((encounter) =>
      calibrated.some((entry) => entry.encounterId === encounter.id)
    );

  return (
    <section className={LINEUP_SECTION_CLS}>
      <div className={LINEUP_HEADER_CLS}>
        <h2 className="mr-auto text-base font-bold tracking-tight">
          {t.ui("lineup.stygianLineup")}
        </h2>
      </div>
      <div className="flex flex-col gap-2 p-2 md:p-3">
        <LineupRunControls
          job={job}
          needClearHint={t.ui("lineup.needStygianClear")}
          debugPlan={{ mode: "stygian", result: planState.result ?? null }}
          settings={
            <>
              <TimeBudgetSelect
                value={timeBudgetSec}
                disabled={job.solver.isComputing}
                onChange={(seconds) => {
                  sessionTimeBudgetSec = seconds;
                  setTimeBudgetSec(seconds);
                }}
              />
              <RunOptionToggle
                label={t.ui("lineup.keepersOnly")}
                tip={t.ui("lineup.keepersOnlyTip")}
                checked={keepersOnly}
                disabled={job.solver.isComputing}
                onChange={(checked) => {
                  sessionKeepersOnly = checked;
                  setKeepersOnly(checked);
                }}
              />
              <RunOptionToggle
                label={t.ui("lineup.levelToMax")}
                tip={t.ui("lineup.levelToMaxTip")}
                checked={levelToMax}
                disabled={job.solver.isComputing}
                onChange={(checked) => {
                  sessionLevelToMax = checked;
                  setLevelToMax(checked);
                }}
              />
            </>
          }
        />
        {planState.error && (
          <p className="text-sm text-destructive">
            {t.ui("lineup.planFailed")}
          </p>
        )}
        {result && (
          <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-foreground/15 bg-background/30 p-2 md:p-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span
                className="mr-auto text-sm font-bold md:text-base"
                title={
                  plan?.kind === "shortfall"
                    ? t.ui("lineup.planShortfallTip")
                    : t.ui("lineup.planLeximinTip")
                }
              >
                {planLabels[plan?.kind ?? "leximin"]}
              </span>
              {planState.isSolving && (
                <span className="text-xs text-muted-foreground">
                  {t.ui("lineup.solvingRun")}
                </span>
              )}
              {plan && (
                <span className="text-xs md:text-sm">
                  <span className="font-semibold">
                    {t.ui("lineup.weakestBoss")}
                  </span>{" "}
                  <MarginValue margin={plan.weakest} />
                </span>
              )}
            </div>
            {noLineup ? (
              <p className="text-xs text-muted-foreground md:text-sm">
                {t.ui("lineup.noRunLineup")}
              </p>
            ) : (
              <div className="grid gap-2 xl:grid-cols-3">
                {encounters.map((encounter) => (
                  <CandidateDetail
                    key={encounter.id}
                    label={encounterLabel(encounter)}
                    candidate={
                      shown.find(
                        (entry) => entry.id === plan?.candidateIds[encounter.id]
                      ) ?? null
                    }
                    bestAlone={bestAlone(encounter.id)}
                    issues={issuesFor(encounter.id)}
                    names={names}
                    levelled={job.levelToMax}
                  />
                ))}
              </div>
            )}
            {plan?.kind === "leximin" && planState.result && (
              <BindingList items={planState.result.binding} lineup={chosen} />
            )}
            {plan && !noLineup && (
              <LevellingAdvice job={job} lineup={chosen} names={names} />
            )}
            {plans.length > 1 && (
              <div className="flex flex-col gap-1">
                {plans.map((entry) => (
                  <LineupRow
                    key={entry.kind}
                    candidates={encounters.map((encounter) =>
                      candidate(entry.candidateIds[encounter.id])
                    )}
                    margin={entry.weakest}
                    label={planLabels[entry.kind]}
                    tied={false}
                    selected={entry === plan}
                    onSelect={() => setSelectedKind(entry.kind)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
