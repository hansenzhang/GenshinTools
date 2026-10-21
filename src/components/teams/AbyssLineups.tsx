import { useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { planAbyssChambers } from "@/domain/combat/lineup/abyssPairs";
import { fillAnyPieces, marginsTied } from "@/domain/combat/lineup/candidates";
import {
  LINEUP_DEFAULT_TIME_BUDGET_SEC,
  LINEUP_MARGIN_TIE_PERCENT,
  LINEUP_PAIRINGS_SHOWN,
} from "@/domain/combat/lineup/constants";
import type { ArtifactData } from "@/domain/models";
import type {
  AbyssChamberPlan,
  AbyssPairing,
  AbyssTimerRule,
  CalibratedCandidate,
} from "@/domain/team/lineupSolverTypes";
import { LevellingAdvice } from "./LevellingAdvice";
import { LINEUP_HEADER_CLS, LINEUP_SECTION_CLS } from "./LineupEncounters";
import {
  BindingList,
  CandidateDetail,
  LINEUP_LABEL_CLS,
  LINEUP_SELECT_CLS,
  LineupRow,
  LineupRunControls,
  MarginValue,
  RunOptionToggle,
  type TeamNames,
  TimeBudgetSelect,
  useIssueLines,
  useLineupJob,
  useTemplateNames,
} from "./LineupResults";

/** Abyss lineup settings for this session. */
let sessionSettings: {
  timeBudgetSec: number | null;
  keepersOnly: boolean;
  levelToMax: boolean;
  timerRule: AbyssTimerRule;
} = {
  timeBudgetSec: LINEUP_DEFAULT_TIME_BUDGET_SEC,
  keepersOnly: true,
  levelToMax: false,
  timerRule: "per-half",
};

function pairingKey(pairing: AbyssPairing): string {
  return `${pairing.firstId}|${pairing.secondId}`;
}

function ChamberCard({
  job,
  plan,
  candidates,
  artifacts,
  timerRule,
  issuesFor,
  names,
}: {
  job: ReturnType<typeof useLineupJob>;
  plan: AbyssChamberPlan;
  candidates: readonly CalibratedCandidate[];
  /** The account's pieces, for members that take any pieces. */
  artifacts: readonly ArtifactData[];
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
    candidates.find((entry) => entry.id === id) ?? null;
  const bothHalves =
    plan.bestAlone.first != null && plan.bestAlone.second != null;
  const fielded = [
    candidate(pairing?.firstId),
    candidate(pairing?.secondId),
  ].filter((entry) => entry !== null);
  // The pairing's teams with free pieces for members that take any pieces.
  const shown = fillAnyPieces(fielded, artifacts);
  const shownCandidate = (id: string | null | undefined) =>
    shown.find((entry) => entry.id === id) ?? null;

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
            <CandidateDetail
              label={t.ui("lineup.firstHalf")}
              candidate={shownCandidate(pairing?.firstId)}
              bestAlone={plan.bestAlone.first}
              issues={issuesFor(plan.firstEncounterId)}
              names={names}
              levelled={job.levelToMax}
            />
          )}
          {plan.secondEncounterId && (
            <CandidateDetail
              label={t.ui("lineup.secondHalf")}
              candidate={shownCandidate(pairing?.secondId)}
              bestAlone={plan.bestAlone.second}
              issues={issuesFor(plan.secondEncounterId)}
              names={names}
              levelled={job.levelToMax}
            />
          )}
        </div>
      )}
      {pairing && pairing === plan.pairings[0] && (
        <BindingList items={plan.binding} lineup={fielded} />
      )}
      {pairing && <LevellingAdvice job={job} lineup={fielded} names={names} />}
      {plan.pairings.length > 1 && (
        <div className="flex flex-col gap-1">
          <span
            className={LINEUP_LABEL_CLS}
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
            <LineupRow
              key={pairingKey(entry)}
              candidates={[candidate(entry.firstId), candidate(entry.secondId)]}
              margin={entry.margin}
              tied={
                index > 0 &&
                marginsTied(
                  entry.margin,
                  plan.pairings[0].margin,
                  LINEUP_MARGIN_TIE_PERCENT
                )
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

export function AbyssLineups() {
  const { t } = useLanguage();
  const names = useTemplateNames();
  const [settings, setSettings] = useState(sessionSettings);
  const updateSettings = (next: typeof settings) => {
    sessionSettings = next;
    setSettings(next);
  };
  const job = useLineupJob(
    "abyss",
    settings.timeBudgetSec,
    settings.keepersOnly,
    settings.levelToMax
  );
  const { encounters, calibrations, calibrated } = job;
  const { result } = job.solver;
  // Chambers without a recorded clear on either half have nothing to show.
  const plans = useMemo(
    () =>
      result
        ? planAbyssChambers(
            encounters,
            calibrated,
            result.weaponCopies,
            settings.timerRule,
            LINEUP_MARGIN_TIE_PERCENT,
            LINEUP_PAIRINGS_SHOWN,
            result.setSlotCounts
          ).filter((plan) =>
            calibrations.some(
              (calibration) =>
                calibration.encounterId === plan.firstEncounterId ||
                calibration.encounterId === plan.secondEncounterId
            )
          )
        : [],
    [result, encounters, calibrations, calibrated, settings.timerRule]
  );
  const issuesFor = useIssueLines(job, names);

  if (encounters.length === 0) return null;
  return (
    <section className={LINEUP_SECTION_CLS}>
      <div className={LINEUP_HEADER_CLS}>
        <h2 className="mr-auto text-base font-bold tracking-tight">
          {t.ui("lineup.abyssLineups")}
        </h2>
      </div>
      <div className="flex flex-col gap-2 p-2 md:p-3">
        <LineupRunControls
          job={job}
          needClearHint={t.ui("lineup.needAbyssClear")}
          debugPlan={{ mode: "abyss", chambers: plans }}
          settings={
            <>
              <TimeBudgetSelect
                value={settings.timeBudgetSec}
                disabled={job.solver.isComputing}
                onChange={(timeBudgetSec) =>
                  updateSettings({ ...settings, timeBudgetSec })
                }
              />
              <RunOptionToggle
                label={t.ui("lineup.keepersOnly")}
                tip={t.ui("lineup.keepersOnlyTip")}
                checked={settings.keepersOnly}
                disabled={job.solver.isComputing}
                onChange={(keepersOnly) =>
                  updateSettings({ ...settings, keepersOnly })
                }
              />
              <RunOptionToggle
                label={t.ui("lineup.levelToMax")}
                tip={t.ui("lineup.levelToMaxTip")}
                checked={settings.levelToMax}
                disabled={job.solver.isComputing}
                onChange={(levelToMax) =>
                  updateSettings({ ...settings, levelToMax })
                }
              />
              <div className="flex items-center gap-1">
                <span className={LINEUP_LABEL_CLS}>{t.ui("lineup.timer")}</span>
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
                    className={LINEUP_SELECT_CLS}
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
            </>
          }
        />
        {result && (
          <div className="grid gap-2 2xl:grid-cols-2">
            {plans.map((plan) => (
              <ChamberCard
                key={plan.chamber}
                job={job}
                plan={plan}
                candidates={calibrated}
                artifacts={job.artifacts}
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
