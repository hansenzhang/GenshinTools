import { ItemIcon } from "@/components/shared/ItemIcon";
import { useLanguage } from "@/contexts/LanguageContext";
import type { TimedSetEffect } from "@/domain/combat/damage/core/setUptime";
import { NumberField } from "./LineupEncounters";

/** Uptime inputs for the team's timed set effects, one per set. Empty
 *  restores the default, which shows as the placeholder. */
export function SetUptimeFields({
  effects,
  overrides,
  hasRotationSeconds,
  onChange,
}: {
  effects: readonly TimedSetEffect[];
  overrides: Record<string, number> | undefined;
  hasRotationSeconds: boolean;
  onChange: (setId: string, share: number | null) => void;
}) {
  const { t } = useLanguage();
  const bySet = new Map<string, TimedSetEffect>();
  for (const effect of effects) {
    if (!bySet.has(effect.setId)) bySet.set(effect.setId, effect);
  }
  const setIds = [
    ...new Set([...bySet.keys(), ...Object.keys(overrides ?? {})]),
  ];
  if (setIds.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-xs font-semibold text-foreground md:text-sm">
        {t.ui("teamComp.setUptime")}
      </span>
      {setIds.map((setId) => {
        const effect = bySet.get(setId);
        const override = overrides?.[setId];
        const name = t.artifact(setId);
        return (
          <div
            key={setId}
            className="flex items-center gap-1"
            title={
              effect
                ? t.format(
                    "teamComp.setUptimeTip",
                    name,
                    effect.duration,
                    Math.round(effect.defaultUptime * 100)
                  )
                : name
            }
          >
            <ItemIcon artifactSetId={setId} size="xs" />
            <NumberField
              label={name}
              hideLabel
              value={override == null ? null : Math.round(override * 100)}
              placeholder={
                effect ? String(Math.round(effect.defaultUptime * 100)) : "—"
              }
              unit="%"
              onCommit={(value) =>
                onChange(setId, value == null ? null : value / 100)
              }
            />
          </div>
        );
      })}
      {!hasRotationSeconds && (
        <span className="text-xs text-muted-foreground">
          {t.ui("teamComp.setUptimeNeedsRotation")}
        </span>
      )}
    </div>
  );
}
