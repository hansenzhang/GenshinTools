import { useMemo } from "react";
import { ArtifactDataHoverCard } from "@/components/shared/ArtifactDataHoverCard";
import { CharAvatar } from "@/components/shared/CharAvatar";
import { ItemIcon } from "@/components/shared/ItemIcon";
import { useLanguage } from "@/contexts/LanguageContext";
import { LINEUP_MARGIN_TIE_PERCENT } from "@/domain/combat/lineup/constants";
import { beatsTie } from "@/domain/combat/lineup/levelling";
import type { ArtifactData } from "@/domain/models";
import type {
  CalibratedCandidate,
  LevellingPiece,
  LevellingRequest,
  LevellingStep,
} from "@/domain/team/lineupSolverTypes";
import { useLevellingAdvice } from "@/hooks/useLevellingAdvice";
import { cn } from "@/lib/utils";
import {
  LINEUP_LABEL_CLS,
  MarginValue,
  type TeamNames,
  type useLineupJob,
} from "./LineupResults";

/** Talent and level steps shown per team. */
const STEPS_SHOWN = 6;

/** Margins this close count as the same in the team's heading. */
const SAME_MARGIN = 0.005;

const percent = (share: number) => (share * 100).toFixed(1);

function PieceIcon({ artifact }: { artifact: ArtifactData }) {
  return (
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
      />
    </ArtifactDataHoverCard>
  );
}

/** One slot's option: the chance to beat the tie, or, muted, the chance of
 *  any gain when it cannot. */
function PieceRow({
  piece,
  margin,
}: {
  piece: LevellingPiece;
  margin: number;
}) {
  const { t } = useLanguage();
  const swapped = piece.replaces && piece.replaces.id !== piece.artifact.id;
  const beats = beatsTie(piece);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1",
        !beats && "text-muted-foreground"
      )}
    >
      <span className="flex shrink-0 items-center gap-1">
        <CharAvatar charId={piece.charId} size={18} />
        <PieceIcon artifact={piece.artifact} />
        <span className="tabular-nums">
          +{piece.artifact.level} → +{piece.toLevel}
        </span>
      </span>
      {swapped && piece.replaces && (
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {t.ui("lineup.insteadOf")}
          <PieceIcon artifact={piece.replaces} />
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-baseline gap-x-2 tabular-nums">
        {beats ? (
          <span
            className="font-semibold"
            title={t.format("lineup.beatChanceTip", LINEUP_MARGIN_TIE_PERCENT)}
          >
            {t.format("lineup.beatChance", (piece.beatChance * 100).toFixed(0))}
          </span>
        ) : (
          <span
            title={t.format("lineup.gainChanceTip", LINEUP_MARGIN_TIE_PERCENT)}
          >
            {t.format("lineup.gainChance", (piece.gainChance * 100).toFixed(0))}
          </span>
        )}
        <span title={t.ui("lineup.expectedGainTip")}>
          {t.format("lineup.expectedGain", percent(piece.expectedGain))}
        </span>
        <span>
          → <MarginValue margin={margin * (1 + piece.expectedGain)} />
        </span>
      </span>
    </div>
  );
}

function StepChip({ step }: { step: LevellingStep }) {
  const { t } = useLanguage();
  const label =
    step.kind === "level"
      ? t.format("teamComp.levelUpGain", step.from, step.to)
      : `${
          step.kind === "auto"
            ? t.ui("accountData.talents.auto")
            : step.kind === "skill"
              ? t.ui("accountData.talents.skill")
              : t.ui("accountData.talents.burst")
        } ${step.from} → ${step.to}`;
  return (
    <span
      className={cn(
        "flex items-center gap-1",
        step.gain * 100 <= LINEUP_MARGIN_TIE_PERCENT && "text-muted-foreground"
      )}
      title={
        step.assumed
          ? t.format("lineup.levelAssumedTip", step.from, step.to)
          : undefined
      }
    >
      <CharAvatar charId={step.charId} size={18} />
      {label}
      <span className="font-semibold tabular-nums">+{percent(step.gain)}%</span>
      {step.assumed && (
        <span className="text-muted-foreground">
          {t.ui("lineup.levelAssumed")}
        </span>
      )}
    </span>
  );
}

/**
 * One team's advice. Keyed by the run's signature and the lineup's candidate
 * ids, so editing a clear or bar keeps it: they change margins, not damage.
 */
function TeamAdvice({
  job,
  team,
  otherIds,
  names,
}: {
  job: ReturnType<typeof useLineupJob>;
  team: CalibratedCandidate;
  /** The lineup's other candidates, sorted and joined. */
  otherIds: string;
  names: TeamNames;
}) {
  const { t } = useLanguage();
  const { request, signature, solver } = job;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the request follows the signature
  const advisorRequest = useMemo<LevellingRequest | null>(() => {
    const candidates = solver.result?.candidates ?? [];
    const find = (id: string) => candidates.find((entry) => entry.id === id);
    const candidate = find(team.id);
    if (!request || !candidate || solver.isComputing) return null;
    return {
      solver: request,
      candidate,
      others: otherIds
        ? otherIds.split(",").flatMap((id) => find(id) ?? [])
        : [],
    };
  }, [signature, solver.result, solver.isComputing, team.id, otherIds]);
  const state = useLevellingAdvice(advisorRequest);

  if (!advisorRequest) return null;
  const { advice } = state;
  // The margin on the team's pieces as they are: below the shown one when
  // the run scored pieces as levelled.
  const margin = advice ? (team.margin * advice.damage) / team.damage : null;
  const asIs =
    margin != null && Math.abs(margin / team.margin - 1) > SAME_MARGIN;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 truncate font-semibold">
          {names.name(team.templateId)}
        </span>
        <MarginValue margin={margin ?? team.margin} />
        {asIs && (
          <span className="text-muted-foreground">{t.ui("lineup.asIs")}</span>
        )}
        {state.isComputing && (
          <span className="text-muted-foreground">
            {t.ui("lineup.levellingRunning")}
          </span>
        )}
      </div>
      {state.error && (
        <p className="text-destructive">{t.ui("lineup.levellingFailed")}</p>
      )}
      {advice && margin != null && (
        <>
          {advice.pieces.length > 0 ? (
            <div className="flex flex-col gap-1">
              {advice.pieces.map((piece) => (
                <PieceRow
                  key={`${piece.charId}:${piece.slot}`}
                  piece={piece}
                  margin={margin}
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">
              {t.ui("lineup.noLevelling")}
            </p>
          )}
          {advice.steps.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                className={LINEUP_LABEL_CLS}
                title={t.format(
                  "lineup.talentsAndLevelsTip",
                  LINEUP_MARGIN_TIE_PERCENT
                )}
              >
                {t.ui("lineup.talentsAndLevels")}
              </span>
              {advice.steps.slice(0, STEPS_SHOWN).map((step) => (
                <StepChip key={`${step.charId}:${step.kind}`} step={step} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * What to level for each team of the lineup shown, weakest first
 * (docs/design/lineup-solver.md, P5): per slot the piece most likely to raise
 * its damage past the margin tie, or, muted, the best smaller gain; then
 * talent and level steps. Worked out once the run has finished, and again
 * only when a team or its lineup changes.
 */
export function LevellingAdvice({
  job,
  lineup,
  names,
}: {
  job: ReturnType<typeof useLineupJob>;
  /** The lineup shown, with margins. */
  lineup: readonly CalibratedCandidate[];
  names: TeamNames;
}) {
  const { t } = useLanguage();
  if (lineup.length === 0 || !job.request || job.solver.isComputing)
    return null;
  const teams = [...lineup].sort((a, b) => a.margin - b.margin);
  const ids = lineup.map((entry) => entry.id).sort();
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs md:text-sm">
      <span
        className={LINEUP_LABEL_CLS}
        title={t.format("lineup.worthLevellingTip", LINEUP_MARGIN_TIE_PERCENT)}
      >
        {t.ui("lineup.worthLevelling")}
      </span>
      {teams.map((team) => (
        <TeamAdvice
          key={team.id}
          job={job}
          team={team}
          otherIds={ids.filter((id) => id !== team.id).join(",")}
          names={names}
        />
      ))}
    </div>
  );
}
