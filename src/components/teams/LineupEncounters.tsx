import { Plus, Trash2 } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { DEFAULT_ENCOUNTER_RES } from "@/domain/team/constants";
import {
  createAbyssEncounter,
  createStygianEncounter,
} from "@/domain/team/lineup";
import type { Encounter } from "@/domain/team/lineupTypes";
import {
  numericInputFilter,
  useDeferredTextInput,
} from "@/hooks/useDeferredTextInput";
import { useResource } from "@/hooks/useResource";
import { getAssetUrl } from "@/lib/assets/urls.ts";
import { leylineBossResource } from "@/providers/reference/gameDataLoader";
import { newLineupId, useLineupStore } from "@/stores/useLineupStore";
import { ElementResInputs } from "./ElementResInputs";

export const LINEUP_SECTION_CLS =
  "overflow-hidden rounded-xl border border-foreground/20 bg-gradient-card";
export const LINEUP_HEADER_CLS =
  "flex flex-wrap items-center gap-2 border-b border-foreground/15 bg-gradient-select px-3 py-2";
export const LINEUP_ACTION_CLS =
  "h-8 gap-1.5 border-primary/40 bg-primary/10 px-3 text-xs font-semibold text-foreground hover:bg-primary/20";
const LABEL_CLS =
  "whitespace-nowrap text-xs font-semibold text-foreground select-none md:text-sm";
const NUMBER_CLS =
  "h-7 w-12 border-foreground/25 bg-background/50 px-1 py-0 text-center text-xs font-bold focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:ring-offset-0 md:text-sm";

/** Player-facing name of an encounter: the Abyss half or the boss. */
export function useEncounterLabel() {
  const { t, language } = useLanguage();
  const bossData = useResource(leylineBossResource);
  return useCallback(
    (encounter: Encounter): string => {
      if (encounter.mode === "abyss")
        return encounter.half === 1
          ? t.format("lineup.abyssFirstHalf", encounter.chamber)
          : t.format("lineup.abyssSecondHalf", encounter.chamber);
      return (
        bossData?.getBossDisplayName(encounter.bossId, language) ??
        `#${encounter.bossId}`
      );
    },
    [t, language, bossData]
  );
}

/** A seconds or level input that commits on blur or Enter. Empty commits null. */
export function NumberField({
  label,
  value,
  placeholder,
  unit,
  onCommit,
}: {
  label: string;
  value: number | null;
  placeholder?: string;
  unit?: string;
  onCommit: (value: number | null) => void;
}) {
  const input = useDeferredTextInput(
    value == null ? "" : String(value),
    (raw) => {
      const parsed = Number(raw);
      onCommit(raw === "" || !Number.isFinite(parsed) ? null : parsed);
    },
    { filter: numericInputFilter }
  );
  return (
    <div className="flex items-center gap-1">
      <span className={LABEL_CLS}>{label}</span>
      <Input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={input.value}
        placeholder={placeholder}
        onChange={input.onChange}
        onBlur={input.onBlur}
        onKeyDown={input.onKeyDown}
        className={NUMBER_CLS}
      />
      {unit && (
        <span className="text-xs font-bold text-muted-foreground">{unit}</span>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
}) {
  const input = useDeferredTextInput(value, (raw) => onCommit(raw.trim()));
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className={LABEL_CLS}>{label}</span>
      <Input
        type="text"
        aria-label={label}
        value={input.value}
        placeholder={placeholder}
        onChange={input.onChange}
        onBlur={input.onBlur}
        onKeyDown={input.onKeyDown}
        className="h-7 min-w-0 flex-1 border-foreground/25 bg-background/50 px-2 py-0 text-xs focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:ring-offset-0 md:text-sm"
      />
    </div>
  );
}

function EncounterCard({ encounter }: { encounter: Encounter }) {
  const { t } = useLanguage();
  const label = useEncounterLabel()(encounter);
  const bossData = useResource(leylineBossResource);
  const updateEncounter = useLineupStore((s) => s.updateEncounter);
  const removeEncounter = useLineupStore((s) => s.removeEncounter);
  const update = (patch: Partial<Encounter>) =>
    updateEncounter(
      encounter.id,
      (current) => ({ ...current, ...patch }) as Encounter
    );
  const seconds = t.ui("teamComp.dpsSeconds");
  const bossImage =
    encounter.mode === "stygian"
      ? bossData?.getBossImagePath(encounter.bossId)
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-foreground/15 bg-background/30 p-2 md:p-3">
      <div className="flex min-w-0 items-center gap-2">
        {bossImage && (
          <img
            src={getAssetUrl(bossImage)}
            alt=""
            className="h-8 w-8 shrink-0 rounded-md bg-secondary/40 object-contain"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-bold md:text-base">
          {label}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t.ui("common.delete")}
          title={t.ui("common.delete")}
          onClick={() => removeEncounter(encounter.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <NumberField
          label={t.ui("teamComp.enemyLevel")}
          value={encounter.enemyLevel}
          onCommit={(value) => {
            if (value != null && value >= 1)
              update({ enemyLevel: Math.round(value) });
          }}
        />
        <NumberField
          label={t.ui("lineup.downtime")}
          value={encounter.downtimeSeconds}
          unit={seconds}
          onCommit={(value) => update({ downtimeSeconds: value ?? 0 })}
        />
        <NumberField
          label={
            encounter.mode === "abyss"
              ? t.ui("lineup.barAbyss")
              : t.ui("lineup.barStygian")
          }
          value={encounter.timeBarSeconds}
          placeholder="—"
          unit={seconds}
          onCommit={(value) =>
            update({
              timeBarSeconds: value != null && value > 0 ? value : null,
            })
          }
        />
      </div>
      <TextField
        label={t.ui("lineup.targets")}
        value={encounter.targets}
        placeholder={t.ui("lineup.targetsPlaceholder")}
        onCommit={(targets) => update({ targets })}
      />
      <ElementResInputs
        values={encounter.res}
        fallback={DEFAULT_ENCOUNTER_RES}
        onChange={(res) => update({ res })}
      />
    </div>
  );
}

export function LineupEncounters() {
  const { t } = useLanguage();
  const encounters = useLineupStore((s) => s.encounters);
  const addEncounters = useLineupStore((s) => s.addEncounters);
  const bossData = useResource(leylineBossResource);

  const abyssChambers = new Set(
    encounters.flatMap((encounter) =>
      encounter.mode === "abyss" ? [encounter.chamber] : []
    )
  );
  const nextChamber = [1, 2, 3].find((chamber) => !abyssChambers.has(chamber));

  const season =
    bossData?.getCurrentSchedule() ?? bossData?.schedules.at(-1) ?? null;
  const addedBossIds = new Set(
    encounters.flatMap((encounter) =>
      encounter.mode === "stygian" ? [encounter.bossId] : []
    )
  );
  const seasonBossIds = (season?.boss_ids ?? []).filter(
    (bossId) => !addedBossIds.has(bossId)
  );

  const addAbyssChamber = () => {
    if (nextChamber == null) return;
    addEncounters([
      createAbyssEncounter(newLineupId("encounter"), nextChamber, 1),
      createAbyssEncounter(newLineupId("encounter"), nextChamber, 2),
    ]);
  };

  const addStygianSeason = () => {
    if (!bossData) return;
    addEncounters(
      seasonBossIds.flatMap((bossId) => {
        const boss = bossData.getBossInfo(bossId);
        return boss
          ? [createStygianEncounter(newLineupId("encounter"), bossId, boss)]
          : [];
      })
    );
  };

  // Abyss halves first in chamber order, then Stygian bosses as added.
  const ordered = [...encounters].sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === "abyss" ? -1 : 1;
    if (a.mode === "abyss" && b.mode === "abyss")
      return a.chamber - b.chamber || a.half - b.half;
    return 0;
  });

  return (
    <section className={LINEUP_SECTION_CLS}>
      <div className={LINEUP_HEADER_CLS}>
        <h2 className="mr-auto text-base font-bold tracking-tight">
          {t.ui("lineup.encounters")}
        </h2>
        <Button
          variant="outline"
          size="sm"
          className={LINEUP_ACTION_CLS}
          disabled={nextChamber == null}
          onClick={addAbyssChamber}
        >
          <Plus className="h-3.5 w-3.5" />
          {t.ui("lineup.addAbyssChamber")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={LINEUP_ACTION_CLS}
          disabled={seasonBossIds.length === 0}
          onClick={addStygianSeason}
        >
          <Plus className="h-3.5 w-3.5" />
          {t.ui("lineup.addStygianSeason")}
        </Button>
      </div>
      {ordered.length > 0 && (
        <div className="grid gap-2 p-2 md:p-3 lg:grid-cols-2 2xl:grid-cols-3">
          {ordered.map((encounter) => (
            <EncounterCard key={encounter.id} encounter={encounter} />
          ))}
        </div>
      )}
    </section>
  );
}
