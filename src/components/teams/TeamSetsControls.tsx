import { useId } from "react";
import { CharAvatar } from "@/components/shared/CharAvatar";
import { FilterChip } from "@/components/shared/FilterChip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { useLanguage } from "@/contexts/LanguageContext";
import { SET_TIME_BUDGET_OPTIONS_SEC } from "@/domain/combat/lineup/constants";
import type { SetConfigExplorerSettings } from "@/domain/team/setConfigExplorerTypes";

const LABEL_CLS =
  "font-semibold text-foreground select-none whitespace-nowrap text-xs md:text-sm";

interface TeamSetsControlsProps {
  memberIds: string[];
  settings: SetConfigExplorerSettings;
  onSettingsChange: (settings: SetConfigExplorerSettings) => void;
  /** Members whose saved pieces are reused as they are; always kept. */
  forcedCharIds: ReadonlySet<string>;
  disabled: boolean;
  t: ReturnType<typeof useLanguage>["t"];
}

export function TeamSetsControls({
  memberIds,
  settings,
  onSettingsChange,
  forcedCharIds,
  disabled,
  t,
}: TeamSetsControlsProps) {
  const ownedId = useId();
  const toggleLock = (charId: string) => {
    const locked = new Set(settings.lockedCharIds);
    if (locked.has(charId)) locked.delete(charId);
    else locked.add(charId);
    onSettingsChange({ ...settings, lockedCharIds: [...locked] });
  };
  return (
    <>
      <label
        htmlFor={ownedId}
        className="flex items-center gap-2 text-xs md:text-sm"
      >
        <Checkbox
          id={ownedId}
          className="border-foreground/30"
          checked={settings.useAccountArtifacts}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onSettingsChange({
              ...settings,
              useAccountArtifacts: checked === true,
            })
          }
        />
        {t.ui("teamComp.teamSetsOwnedArtifacts")}
      </label>
      {settings.useAccountArtifacts && (
        <div className="flex items-center gap-1">
          <span className={LABEL_CLS}>{t.ui("teamComp.timeBudget")}</span>
          <Select
            value={String(settings.timeBudgetSec)}
            disabled={disabled}
            onValueChange={(value) =>
              onSettingsChange({ ...settings, timeBudgetSec: Number(value) })
            }
          >
            <SelectTrigger className="font-bold border-foreground/20 bg-background/50 text-xs h-6 w-[60px] px-1 py-0 md:text-sm md:h-7 md:w-[68px] md:px-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SET_TIME_BUDGET_OPTIONS_SEC.map((seconds) => (
                <SelectItem key={seconds} value={String(seconds)}>
                  {seconds}s
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={LABEL_CLS}>{t.ui("teamComp.teamSetsKeepSet")}</span>
        {memberIds.map((charId) => {
          const forced = forcedCharIds.has(charId);
          return (
            <FilterChip
              key={charId}
              active={forced || settings.lockedCharIds.includes(charId)}
              disabled={disabled || forced}
              onClick={() => toggleLock(charId)}
            >
              <CharAvatar charId={charId} size={16} />
              <span className="sr-only">{t.character(charId)}</span>
            </FilterChip>
          );
        })}
      </div>
    </>
  );
}
