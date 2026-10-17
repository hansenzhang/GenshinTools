import { Pin, PinOff } from "lucide-react";
import { useState } from "react";
import { CharAvatar } from "@/components/shared/CharAvatar";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { useLanguage } from "@/contexts/LanguageContext";
import type { BuffActivationMap } from "@/domain/combat/damage/types";
import {
  findOrphanedSetOverrideKeys,
  isWithinTie,
} from "@/domain/combat/lineup/setAssignments";
import { assignmentKey, setChoiceKey } from "@/domain/combat/lineup/setChoices";
import type { ArtifactSetConfig } from "@/domain/models";
import { fmtDamage } from "@/domain/team/displayFormatter";
import type {
  SetAssignment,
  SetAssignmentOutcome,
  SetChoiceRow,
  SetConfigExplorerResult,
  SetOutcomeBasis,
} from "@/domain/team/setConfigExplorerTypes";
import { cn } from "@/lib/utils";
import { formatFailReason } from "./StatSheetPanel";
import { TeamCharacterGrid } from "./TeamCharacterGrid";
import {
  ArtifactChoiceRowIcon,
  CharPanelHeader,
  getArtifactSetLabel,
} from "./WeaponChoiceResultCard";

type Translate = ReturnType<typeof useLanguage>["t"];

function basisDamage(
  outcome: SetAssignmentOutcome,
  basis: SetOutcomeBasis
): number | null {
  if (basis === "account")
    return outcome.account ? outcome.account.damage : null;
  if (basis === "generated") return outcome.generatedDamage ?? null;
  return outcome.screenDamage;
}

function bestOnBasis(
  outcomes: readonly SetAssignmentOutcome[],
  basis: SetOutcomeBasis
): number {
  return Math.max(
    0,
    ...outcomes.map((outcome) => basisDamage(outcome, basis) ?? 0)
  );
}

function choiceLabel(choice: ArtifactSetConfig | null, t: Translate): string {
  return choice ? getArtifactSetLabel(choice, t) : t.ui("common.none");
}

function ChoiceIcon({
  choice,
  label,
}: {
  choice: ArtifactSetConfig | null;
  label: string;
}) {
  return choice ? (
    <ArtifactChoiceRowIcon artifactSet={choice} label={label} />
  ) : (
    <div className="w-5 h-5 lg:w-7 lg:h-7 shrink-0" />
  );
}

function unreachableReasons(
  outcome: SetAssignmentOutcome,
  t: Translate
): string[] {
  const account = outcome.account;
  if (!account || account.damage != null) return [];
  const reasons = Object.entries(account.failReasons).map(
    ([charId, reason]) =>
      `${t.character(charId)}: ${formatFailReason(reason, t)}`
  );
  for (const charId of account.unmetCharIds)
    reasons.push(
      `${t.character(charId)}: ${t.ui("teamComp.teamSetsRequirementUnmet")}`
    );
  return reasons.length > 0 ? reasons : [t.ui("teamComp.teamSetsUnreachable")];
}

function RowDetail({
  row,
  outcome,
  charIds,
  damage,
  onApply,
  onTogglePin,
  t,
}: {
  row: SetChoiceRow;
  outcome: SetAssignmentOutcome;
  charIds: string[];
  damage: number | null;
  onApply: () => void;
  onTogglePin: () => void;
  t: Translate;
}) {
  const reasons = unreachableReasons(outcome, t);
  const realized = outcome.account?.realized;
  const realizedDiffers =
    damage != null &&
    realized &&
    assignmentKey(realized, charIds) !== outcome.key;
  return (
    <div className="space-y-2 text-xs">
      <Button size="sm" className="w-full" onClick={onApply}>
        {t.ui("teamComp.artifactAssignmentApply")}
      </Button>
      {damage != null && (
        <div className="flex justify-between">
          <span className="text-muted-foreground">
            {t.ui("teamComp.totalDamage")}
          </span>
          <span className="font-mono font-bold">{fmtDamage(damage)}</span>
        </div>
      )}
      {reasons.length > 0 && (
        <ul className="space-y-0.5 text-destructive">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <div className="border-t border-border pt-1.5">
        <div className="mb-1 font-semibold text-muted-foreground">
          {t.ui("teamComp.teamSetsTeammates")}
        </div>
        {charIds
          .filter((charId) => charId !== row.charId)
          .map((charId) => (
            <div key={charId} className="flex items-center gap-1.5 py-0.5">
              <CharAvatar charId={charId} size={16} />
              <span className="truncate">
                {choiceLabel(outcome.assignment[charId] ?? null, t)}
              </span>
            </div>
          ))}
      </div>
      {realizedDiffers && (
        <div className="border-t border-border pt-1.5">
          <div className="mb-1 font-semibold text-muted-foreground">
            {t.ui("teamComp.teamSetsRealized")}
          </div>
          {charIds.map((charId) => (
            <div key={charId} className="flex items-center gap-1.5 py-0.5">
              <CharAvatar charId={charId} size={16} />
              <span className="truncate">
                {choiceLabel(realized[charId] ?? null, t)}
              </span>
            </div>
          ))}
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={onTogglePin}
      >
        {row.pinned ? (
          <PinOff className="mr-1 h-3.5 w-3.5" />
        ) : (
          <Pin className="mr-1 h-3.5 w-3.5" />
        )}
        {row.pinned
          ? t.ui("teamComp.teamSetsUnpin")
          : t.ui("teamComp.teamSetsPin")}
      </Button>
      {row.pinned && row.basis !== "account" && (
        <p className="text-muted-foreground">
          {t.ui("teamComp.teamSetsPinHint")}
        </p>
      )}
    </div>
  );
}

function ChoiceRow({
  row,
  result,
  presentChoice,
  basisBest,
  isMobile,
  onApply,
  onTogglePin,
  t,
}: {
  row: SetChoiceRow;
  result: SetConfigExplorerResult;
  presentChoice: ArtifactSetConfig | null;
  basisBest: number;
  isMobile: boolean;
  onApply: () => void;
  onTogglePin: () => void;
  t: Translate;
}) {
  const outcome = result.outcomes[row.outcomeIndex];
  const damage = basisDamage(outcome, row.basis);
  const estimate = row.basis !== result.basis;
  const label = choiceLabel(row.choice, t);
  const isCurrent = setChoiceKey(presentChoice) === row.key;
  const isBest = row.outcomeIndex === result.bestIndex;
  const tied =
    !isBest &&
    damage != null &&
    !estimate &&
    isWithinTie(damage, basisBest, result.tiePercent);
  const value =
    damage == null
      ? "—"
      : `${tied ? "≈" : ""}${((damage / basisBest) * 100).toFixed(1)}%`;
  const button = (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "flex w-full items-center gap-1 px-1 py-1.5 text-left text-xs md:text-sm lg:gap-1.5 lg:px-2 lg:text-xs xl:text-sm cursor-pointer hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
        isBest
          ? "bg-primary/10 border border-primary/30"
          : "border border-transparent",
        estimate && "text-muted-foreground"
      )}
    >
      <ChoiceIcon choice={row.choice} label={label} />
      <span className="truncate flex-1 font-medium">{label}</span>
      {row.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
      {isCurrent && (
        <span className="shrink-0 text-muted-foreground">
          {t.ui("teamComp.tabCurrent")}
        </span>
      )}
      <span
        className={cn(
          "w-12 lg:w-14 text-right font-mono font-bold shrink-0",
          isBest && "text-primary",
          damage == null && "text-destructive"
        )}
      >
        {value}
      </span>
    </button>
  );
  const detail = (
    <RowDetail
      row={row}
      outcome={outcome}
      charIds={result.charIds}
      damage={damage}
      onApply={onApply}
      onTogglePin={onTogglePin}
      t={t}
    />
  );
  if (isMobile)
    return (
      <Drawer>
        <DrawerTrigger asChild>{button}</DrawerTrigger>
        <DrawerContent className="bg-popover border-t border-border">
          <DrawerTitle className="sr-only">{label}</DrawerTitle>
          <DrawerDescription className="sr-only">{label}</DrawerDescription>
          <div className="p-4 pt-2 safe-area-bottom max-w-sm mx-auto">
            {detail}
          </div>
        </DrawerContent>
      </Drawer>
    );
  return (
    <Popover>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent
        side="right"
        className="w-64 p-3 border-border bg-popover"
      >
        {detail}
      </PopoverContent>
    </Popover>
  );
}

function MemberPanel({
  charId,
  result,
  present,
  isMobile,
  onApply,
  onTogglePin,
  t,
}: {
  charId: string;
  result: SetConfigExplorerResult;
  present: SetAssignment;
  isMobile: boolean;
  onApply: (assignment: SetAssignment) => void;
  onTogglePin: (charId: string, choice: ArtifactSetConfig | null) => void;
  t: Translate;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = result.rowsByChar[charId] ?? [];
  const main = rows.filter((row) => row.basis === result.basis);
  const estimates = rows.filter((row) => row.basis !== result.basis);
  const visible = showAll ? [...main, ...estimates] : main;
  return (
    <div className="flex flex-col rounded-md border border-border bg-background/30 overflow-hidden">
      <CharPanelHeader charId={charId} t={t} />
      <div className="px-2 py-1 text-right text-xs text-muted-foreground">
        {t.ui("teamComp.percentOfBest")}
      </div>
      <div className="overflow-y-auto max-h-72 md:max-h-96">
        {visible.map((row, index) => (
          <div key={row.key}>
            {showAll && index === main.length && (
              <div className="border-t border-border px-2 py-1 text-xs text-muted-foreground">
                {t.ui("teamComp.teamSetsEstimate")}
              </div>
            )}
            <ChoiceRow
              row={row}
              result={result}
              presentChoice={present[charId] ?? null}
              basisBest={bestOnBasis(result.outcomes, row.basis)}
              isMobile={isMobile}
              onApply={() =>
                onApply(result.outcomes[row.outcomeIndex].assignment)
              }
              onTogglePin={() => onTogglePin(charId, row.choice)}
              t={t}
            />
          </div>
        ))}
      </div>
      {estimates.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="rounded-none border-t border-border text-xs"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? t.ui("teamComp.showTopChoices")
            : `${t.ui("teamComp.showAllChoices")} (${rows.length})`}
        </Button>
      )}
    </div>
  );
}

function BestAssignment({
  result,
  present,
  userBuffOverrides,
  onApply,
  t,
}: {
  result: SetConfigExplorerResult;
  present: SetAssignment;
  userBuffOverrides?: Record<string, BuffActivationMap>;
  onApply: (assignment: SetAssignment) => void;
  t: Translate;
}) {
  const best = result.outcomes[result.bestIndex];
  const bestDamage = basisDamage(best, result.basis);
  if (bestDamage == null) return null;
  const currentDamage = Math.max(
    basisDamage(result.outcomes[result.currentIndex], result.basis) ?? 0,
    result.basis === "account" ? (result.equippedDamage ?? 0) : 0
  );
  const improves =
    currentDamage > 0 &&
    !isWithinTie(currentDamage, bestDamage, result.tiePercent);
  const applied = assignmentKey(present, result.charIds) === best.key;
  const orphaned = findOrphanedSetOverrideKeys(
    userBuffOverrides,
    present,
    best.assignment
  );
  return (
    <div className="rounded-md border border-border bg-background/30 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">
            {t.ui("teamComp.teamSetsBest")}
          </span>
          <span
            className={cn(
              "text-xs font-semibold tabular-nums",
              improves ? "text-primary" : "text-muted-foreground"
            )}
          >
            {improves
              ? `+${(((bestDamage - currentDamage) / currentDamage) * 100).toFixed(1)}% ${t.ui("teamComp.teamSetsVsCurrent")}`
              : t.ui("teamComp.teamSetsCurrentBest")}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-6 px-2 py-1 text-xs"
          disabled={!improves || applied}
          onClick={() => onApply(best.assignment)}
        >
          {applied && improves
            ? t.ui("batchAutoTune.applied")
            : t.ui("teamComp.artifactAssignmentApply")}
        </Button>
      </div>
      <div className="flex flex-wrap justify-center gap-2 p-3 md:gap-6">
        {result.charIds.map((charId) => {
          const choice = best.assignment[charId] ?? null;
          const label = choiceLabel(choice, t);
          const changed =
            setChoiceKey(present[charId] ?? null) !== setChoiceKey(choice);
          return (
            <div
              key={charId}
              className={cn(
                "flex items-center gap-2 min-w-0 rounded-md border px-2 py-1",
                changed ? "border-primary" : "border-transparent"
              )}
            >
              <ChoiceIcon choice={choice} label={label} />
              <CharAvatar charId={charId} size={24} />
              <div className="min-w-0">
                <div className="max-w-24 truncate text-xs font-semibold md:max-w-32">
                  {t.character(charId)}
                </div>
                <div className="max-w-24 truncate text-xs text-muted-foreground md:max-w-32">
                  {label}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {improves && !applied && orphaned.length > 0 && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {t.ui("teamComp.teamSetsOverridesReset")}
        </p>
      )}
    </div>
  );
}

export function TeamSetsResults({
  result,
  present,
  userBuffOverrides,
  isMobile,
  onApply,
  onTogglePin,
  t,
}: {
  result: SetConfigExplorerResult;
  /** The team's set goals right now (they change after Apply). */
  present: SetAssignment;
  userBuffOverrides?: Record<string, BuffActivationMap>;
  isMobile: boolean;
  onApply: (assignment: SetAssignment) => void;
  onTogglePin: (charId: string, choice: ArtifactSetConfig | null) => void;
  t: Translate;
}) {
  return (
    <div className="space-y-2">
      <BestAssignment
        result={result}
        present={present}
        userBuffOverrides={userBuffOverrides}
        onApply={onApply}
        t={t}
      />
      <TeamCharacterGrid className="gap-2">
        {result.charIds.map((charId) => (
          <MemberPanel
            key={charId}
            charId={charId}
            result={result}
            present={present}
            isMobile={isMobile}
            onApply={onApply}
            onTogglePin={onTogglePin}
            t={t}
          />
        ))}
      </TeamCharacterGrid>
    </div>
  );
}
