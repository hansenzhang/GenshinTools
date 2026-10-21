import { useMemo } from "react";
import { ArtifactDataHoverCard } from "@/components/shared/ArtifactDataHoverCard";
import { CharAvatar } from "@/components/shared/CharAvatar";
import { ItemIcon } from "@/components/shared/ItemIcon";
import { useLanguage } from "@/contexts/LanguageContext";
import { LINEUP_MARGIN_TIE_PERCENT } from "@/domain/combat/lineup/constants";
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

/** Talent and level steps shown. */
const STEPS_SHOWN = 6;

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

function PieceRow({
  piece,
  margin,
}: {
  piece: LevellingPiece;
  margin: number;
}) {
  const { t } = useLanguage();
  const swapped = piece.replaces && piece.replaces.id !== piece.artifact.id;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
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
        <span
          className="font-semibold"
          title={t.format("lineup.beatChanceTip", LINEUP_MARGIN_TIE_PERCENT)}
        >
          {t.format("lineup.beatChance", (piece.beatChance * 100).toFixed(0))}
        </span>
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
    >
      <CharAvatar charId={step.charId} size={18} />
      {label}
      <span className="font-semibold tabular-nums">+{percent(step.gain)}%</span>
    </span>
  );
}

/**
 * What to level for the lineup's weakest team (docs/design/lineup-solver.md,
 * P5): per slot the piece most likely to raise its damage past the margin
 * tie, then talent and level steps. Worked out once the run has finished,
 * and again only when the weakest team or its lineup changes.
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
  const { request, signature, solver } = job;
  const weakest =
    lineup.length > 0
      ? lineup.reduce((a, b) => (b.margin < a.margin ? b : a))
      : null;
  const weakestId = weakest?.id ?? null;
  const otherIds = lineup
    .flatMap((entry) => (entry.id === weakestId ? [] : [entry.id]))
    .sort()
    .join(",");
  // Keyed by the run's signature and candidate ids, so editing a clear or
  // bar keeps the advice: they change margins, not damage.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the request follows the signature
  const advisorRequest = useMemo<LevellingRequest | null>(() => {
    const candidates = solver.result?.candidates ?? [];
    const find = (id: string) => candidates.find((entry) => entry.id === id);
    const candidate = weakestId ? find(weakestId) : undefined;
    if (!request || !candidate || solver.isComputing) return null;
    return {
      solver: request,
      candidate,
      others: otherIds
        ? otherIds.split(",").flatMap((id) => find(id) ?? [])
        : [],
    };
  }, [signature, solver.result, solver.isComputing, weakestId, otherIds]);
  const state = useLevellingAdvice(advisorRequest);

  if (!weakest || !advisorRequest) return null;
  const { advice } = state;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-xs md:text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className={LINEUP_LABEL_CLS}
          title={t.format(
            "lineup.worthLevellingTip",
            LINEUP_MARGIN_TIE_PERCENT
          )}
        >
          {t.ui("lineup.worthLevelling")}
        </span>
        <span className="min-w-0 truncate font-semibold">
          {names.name(weakest.templateId)}
        </span>
        <MarginValue margin={weakest.margin} />
        {state.isComputing && (
          <span className="text-muted-foreground">
            {t.ui("lineup.levellingRunning")}
          </span>
        )}
      </div>
      {state.error && (
        <p className="text-destructive">{t.ui("lineup.levellingFailed")}</p>
      )}
      {advice && (
        <>
          {advice.pieces.length > 0 ? (
            <div className="flex flex-col gap-1">
              {advice.pieces.map((piece) => (
                <PieceRow
                  key={`${piece.charId}:${piece.slot}`}
                  piece={piece}
                  margin={weakest.margin}
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">
              {t.format("lineup.noLevelling", LINEUP_MARGIN_TIE_PERCENT)}
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
