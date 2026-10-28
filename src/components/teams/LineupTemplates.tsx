import { Camera, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { CharAvatar } from "@/components/shared/CharAvatar";
import { VALUE_COLORS } from "@/components/shared/colors";
import { ItemIcon } from "@/components/shared/ItemIcon";
import { ItemPicker } from "@/components/shared/ItemPicker";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import { resolveTeamObjective } from "@/domain/combat/lineup/compositions";
import { elements } from "@/domain/enums";
import type { AccountData } from "@/domain/models";
import { characterStatsResource } from "@/domain/reference/stats";
import {
  calibratedMargin,
  captureTeamReferenceBuild,
  createTeamTemplate,
  getCharacterTraits,
  referenceMatchesTeam,
  templateCompositions,
} from "@/domain/team/lineup";
import type {
  Calibration,
  CompositionRule,
  Encounter,
  TeamTemplate,
} from "@/domain/team/lineupTypes";
import { buildTeamSlotConfigs } from "@/domain/team/teamConfigUtils";
import {
  teamCompToArrays,
  teamSetUptimes,
  withRotationSeconds,
  withSetUptime,
} from "@/domain/team/teamDeltas";
import type { TeamComp, TeamSetupConfig } from "@/domain/team/types";
import { useActiveAccountData } from "@/hooks/useActiveAccount";
import { useResource } from "@/hooks/useResource";
import { cn } from "@/lib/utils";
import { newLineupId, useLineupStore } from "@/stores/useLineupStore";
import { useTeamStore } from "@/stores/useTeamStore";
import {
  LINEUP_ACTION_CLS,
  LINEUP_HEADER_CLS,
  LINEUP_SECTION_CLS,
  NumberField,
  useEncounterLabel,
} from "./LineupEncounters";
import { SetUptimeFields } from "./SetUptimeFields";

const SELECT_TRIGGER_CLS =
  "h-8 w-auto min-w-0 max-w-full gap-1.5 border-primary/40 bg-primary/10 px-3 text-xs font-semibold text-foreground hover:bg-primary/15 [&>span]:truncate";
const SUBHEAD_CLS =
  "whitespace-nowrap text-xs font-semibold text-foreground select-none md:text-sm";

function teamCharacters(team: TeamComp): string[] {
  return teamCompToArrays(team).characters.filter(
    (charId): charId is string => charId != null
  );
}

function TeamIdentity({
  team,
  index,
  size = 20,
}: {
  team: TeamComp;
  index: number;
  size?: number;
}) {
  const { t } = useLanguage();
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="flex shrink-0 items-center gap-0.5">
        {teamCharacters(team).map((charId) => (
          <CharAvatar key={charId} charId={charId} size={size} />
        ))}
      </span>
      <span className="truncate">
        {team.name || t.format("teamComp.teamIndex", index + 1)}
      </span>
    </span>
  );
}

function TeamSelect({
  teams,
  placeholder,
  onSelect,
}: {
  teams: TeamComp[];
  placeholder: string;
  onSelect: (team: TeamComp) => void;
}) {
  const allTeams = useTeamStore((s) => s.teamComps);
  return (
    <Select
      value=""
      disabled={teams.length === 0}
      onValueChange={(teamId) => {
        const team = teams.find((entry) => entry.id === teamId);
        if (team) onSelect(team);
      }}
    >
      <SelectTrigger className={SELECT_TRIGGER_CLS} aria-label={placeholder}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {teams.map((team) => (
          <SelectItem key={team.id} value={team.id}>
            <TeamIdentity team={team} index={allTeams.indexOf(team)} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ─── Flex slots ───

function FlexSlots({
  template,
  team,
}: {
  template: TeamTemplate;
  team: TeamComp;
}) {
  const { t } = useLanguage();
  const updateTemplate = useLineupStore((s) => s.updateTemplate);
  const { characters } = teamCompToArrays(team);
  const setSlot = (slot: number, next: string[]) =>
    updateTemplate(template.id, (current) => ({
      ...current,
      flexBySlot: [0, 1, 2, 3].map((index) =>
        index === slot ? next : (current.flexBySlot[index] ?? [])
      ),
    }));

  const hasAlternatives = template.flexBySlot.some(
    (alternatives) => alternatives.length > 0
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {characters.map((core, slot) => {
          if (!core) return null;
          const alternatives = template.flexBySlot[slot] ?? [];
          return (
            <div
              key={slot}
              className="flex min-w-0 items-start gap-1.5 rounded-md border border-foreground/15 bg-background/30 p-1.5"
            >
              <ItemIcon characterId={core} size="xs" />
              <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-1.5 border-l border-foreground/15 pl-1.5">
                {alternatives.map((charId) => (
                  <button
                    key={charId}
                    type="button"
                    className="relative"
                    title={t.format(
                      "lineup.removeAlternative",
                      t.character(charId)
                    )}
                    aria-label={t.format(
                      "lineup.removeAlternative",
                      t.character(charId)
                    )}
                    onClick={() =>
                      setSlot(
                        slot,
                        alternatives.filter((entry) => entry !== charId)
                      )
                    }
                  >
                    <ItemIcon characterId={charId} size="xs" />
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-foreground/25 bg-background text-foreground">
                      <X className="h-3 w-3" />
                    </span>
                  </button>
                ))}
                <ItemPicker
                  type="character"
                  value={null}
                  triggerSize="xs"
                  triggerLabel={t.ui("lineup.addAlternative")}
                  filter={(item) => {
                    const { id } = item as { id: string };
                    return (
                      !characters.includes(id) && !alternatives.includes(id)
                    );
                  }}
                  onChange={(charId) =>
                    setSlot(slot, [...alternatives, charId])
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
      {hasAlternatives && (
        <p className="text-xs text-muted-foreground">
          {t.ui("lineup.alternativesDefaultRotation")}
        </p>
      )}
    </div>
  );
}

// ─── Composition rules ───

function ruleKey(rule: CompositionRule): string {
  return rule.kind === "element" ? `element:${rule.element}` : "moonsign";
}

function CompositionRules({
  template,
  compositionCount,
  fieldsOwnTeam,
}: {
  template: TeamTemplate;
  compositionCount: number;
  /** Whether the linked team's own members are one of the compositions. */
  fieldsOwnTeam: boolean;
}) {
  const { t } = useLanguage();
  const updateTemplate = useLineupStore((s) => s.updateTemplate);
  const setRules = (rules: CompositionRule[]) =>
    updateTemplate(template.id, (current) => ({ ...current, rules }));
  const ruleLabel = (rule: CompositionRule) =>
    rule.kind === "element" ? t.element(rule.element) : t.faction("Moonsign");
  const usedKeys = new Set(template.rules.map(ruleKey));
  const allRules: CompositionRule[] = [
    ...elements.map(
      (element): CompositionRule => ({ kind: "element", element, min: 1 })
    ),
    { kind: "moonsign", min: 2 },
  ];
  const options = allRules.filter((rule) => !usedKeys.has(ruleKey(rule)));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={SUBHEAD_CLS}>{t.ui("lineup.rules")}</span>
      {template.rules.map((rule, index) => (
        <span
          key={ruleKey(rule)}
          className="flex items-center gap-0.5 rounded-md border border-primary/30 bg-primary/10 py-0.5 pl-1 pr-0.5 text-xs font-semibold"
        >
          <Select
            value={String(rule.min)}
            onValueChange={(value) =>
              setRules(
                template.rules.map((entry, i) =>
                  i === index ? { ...entry, min: Number(value) } : entry
                )
              )
            }
          >
            <SelectTrigger
              aria-label={ruleLabel(rule)}
              className="h-6 w-auto gap-0.5 border-none bg-transparent px-1 py-0 text-xs font-semibold shadow-none"
            >
              <SelectValue>
                {t.format("lineup.ruleAtLeast", rule.min, ruleLabel(rule))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4].map((min) => (
                <SelectItem key={min} value={String(min)}>
                  {t.format("lineup.ruleAtLeast", min, ruleLabel(rule))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:text-destructive"
            aria-label={t.ui("common.delete")}
            onClick={() =>
              setRules(template.rules.filter((_, i) => i !== index))
            }
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ))}
      {options.length > 0 && (
        <Select
          value=""
          onValueChange={(key) => {
            const rule = options.find((option) => ruleKey(option) === key);
            if (rule) setRules([...template.rules, rule]);
          }}
        >
          <SelectTrigger
            className="h-7 w-auto gap-1 border-foreground/25 bg-background/50 px-2 text-xs"
            aria-label={t.ui("lineup.addRule")}
          >
            <SelectValue placeholder={t.ui("lineup.addRule")} />
          </SelectTrigger>
          <SelectContent>
            {options.map((rule) => (
              <SelectItem key={ruleKey(rule)} value={ruleKey(rule)}>
                {ruleLabel(rule)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <span className="ml-auto text-xs text-muted-foreground">
        {t.format("lineup.compositions", compositionCount)}
      </span>
      {!fieldsOwnTeam && compositionCount > 0 && (
        <p
          className={cn("w-full text-xs", VALUE_COLORS.cap)}
          title={t.ui("lineup.ownTeamExcludedTip")}
        >
          {t.ui("lineup.ownTeamExcluded")}
        </p>
      )}
    </div>
  );
}

// ─── Recorded clears ───

function MarginReadout({
  calibration,
  encounter,
}: {
  calibration: Calibration;
  encounter: Encounter;
}) {
  const { t } = useLanguage();
  const readout = calibratedMargin(1, calibration, encounter);
  if (readout.kind !== "margin")
    return (
      <span className={cn("text-xs font-semibold", VALUE_COLORS.cap)}>
        {readout.kind === "no-bar"
          ? t.ui("lineup.marginNoBar")
          : t.ui("lineup.marginDowntime")}
      </span>
    );
  return (
    <span
      className="whitespace-nowrap text-xs md:text-sm"
      title={t.ui("lineup.marginTip")}
    >
      <span className="font-semibold">{t.ui("lineup.margin")}</span>{" "}
      <span
        className={cn(
          "font-bold tabular-nums",
          readout.margin >= 1 ? VALUE_COLORS.positive : VALUE_COLORS.negative
        )}
      >
        ×{readout.margin.toFixed(2)}
      </span>
    </span>
  );
}

function CalibrationRow({
  calibration,
  encounter,
  teamChanged,
  onRecapture,
}: {
  calibration: Calibration;
  encounter: Encounter;
  teamChanged: boolean;
  onRecapture: (() => void) | null;
}) {
  const { t, language } = useLanguage();
  const label = useEncounterLabel()(encounter);
  const updateCalibration = useLineupStore((s) => s.updateCalibration);
  const removeCalibration = useLineupStore((s) => s.removeCalibration);
  const seconds = t.ui("teamComp.dpsSeconds");
  const savedOn = new Date(calibration.reference.capturedAt).toLocaleDateString(
    language === "zh" ? "zh-CN" : "en-US",
    { month: "short", day: "numeric" }
  );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-foreground/15 bg-background/30 px-2 py-1.5">
      <span className="min-w-0 basis-full truncate text-sm font-semibold sm:basis-auto sm:w-44">
        {label}
      </span>
      <NumberField
        label={t.ui("lineup.clearTime")}
        value={calibration.measuredSeconds}
        unit={seconds}
        onCommit={(value) => {
          if (value != null && value > 0)
            updateCalibration(calibration.id, { measuredSeconds: value });
        }}
      />
      <NumberField
        label={t.ui("lineup.downtime")}
        value={calibration.downtimeSeconds}
        placeholder={String(encounter.downtimeSeconds)}
        unit={seconds}
        onCommit={(value) =>
          updateCalibration(calibration.id, { downtimeSeconds: value })
        }
      />
      <MarginReadout calibration={calibration} encounter={encounter} />
      <span className="ml-auto flex items-center gap-1">
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {t.format("lineup.buildSaved", savedOn)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={!onRecapture}
          title={t.ui("lineup.saveCurrentBuild")}
          aria-label={t.ui("lineup.saveCurrentBuild")}
          onClick={() => onRecapture?.()}
        >
          <Camera className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          title={t.ui("common.delete")}
          aria-label={t.ui("common.delete")}
          onClick={() => removeCalibration(calibration.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </span>
      {teamChanged && (
        <p className={cn("basis-full text-xs", VALUE_COLORS.cap)}>
          {t.ui("lineup.clearTeamChanged")}
        </p>
      )}
    </div>
  );
}

function RecordClear({
  encounters,
  onRecord,
}: {
  encounters: Encounter[];
  onRecord: ((encounterId: string, measuredSeconds: number) => void) | null;
}) {
  const { t } = useLanguage();
  const label = useEncounterLabel();
  const [encounterId, setEncounterId] = useState("");
  const [measured, setMeasured] = useState<number | null>(null);
  const selected = encounters.some((entry) => entry.id === encounterId)
    ? encounterId
    : "";
  if (encounters.length === 0) return null;
  const canRecord = onRecord != null && selected !== "" && (measured ?? 0) > 0;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <Select value={selected} onValueChange={setEncounterId}>
        <SelectTrigger
          className="h-7 w-auto min-w-0 max-w-full gap-1 border-foreground/25 bg-background/50 px-2 text-xs md:text-sm [&>span]:truncate"
          aria-label={t.ui("lineup.encounter")}
        >
          <SelectValue placeholder={t.ui("lineup.encounter")} />
        </SelectTrigger>
        <SelectContent>
          {encounters.map((encounter) => (
            <SelectItem key={encounter.id} value={encounter.id}>
              {label(encounter)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <NumberField
        label={t.ui("lineup.clearTime")}
        value={measured}
        unit={t.ui("teamComp.dpsSeconds")}
        onCommit={setMeasured}
      />
      <Button
        variant="outline"
        size="sm"
        className={LINEUP_ACTION_CLS}
        disabled={!canRecord}
        onClick={() => {
          if (!canRecord || measured == null) return;
          onRecord(selected, measured);
          setEncounterId("");
          setMeasured(null);
        }}
      >
        {t.ui("lineup.recordClear")}
      </Button>
      {onRecord == null && (
        <span className="text-xs text-muted-foreground">
          {t.ui("lineup.needAccount")}
        </span>
      )}
    </div>
  );
}

// ─── Template card ───

function TemplateCard({
  template,
  encounters,
}: {
  template: TeamTemplate;
  encounters: Encounter[];
}) {
  const { t } = useLanguage();
  const teams = useTeamStore((s) => s.teamComps);
  const team = useTeamStore((s) => s.teamCompById[template.teamId]);
  const getSetupConfig = useTeamStore((s) => s.getTeamSetupConfigById);
  const savedConfig = useTeamStore((s) => s.configsByTeamId[template.teamId]);
  const updateTeamSetupConfig = useTeamStore((s) => s.updateTeamSetupConfig);
  const calibrations = useLineupStore((s) => s.calibrations);
  const templates = useLineupStore((s) => s.templates);
  const updateTemplate = useLineupStore((s) => s.updateTemplate);
  const removeTemplate = useLineupStore((s) => s.removeTemplate);
  const saveCalibration = useLineupStore((s) => s.saveCalibration);
  const accountData = useActiveAccountData();
  const characterStats = useResource(characterStatsResource);

  const compositions = useMemo(
    () =>
      team
        ? templateCompositions(template, team, (charId) =>
            getCharacterTraits(charId, characterStats ?? undefined)
          )
        : [],
    [template, team, characterStats]
  );
  const ownMembers = team ? teamCharacters(team) : [];
  const fieldsOwnTeam = compositions.some(
    (composition) =>
      composition.length === ownMembers.length &&
      ownMembers.every((charId) => composition.includes(charId))
  );

  const deleteButton = (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
      title={t.ui("common.delete")}
      aria-label={t.ui("common.delete")}
      onClick={() => removeTemplate(template.id)}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );

  if (!team) {
    const linked = new Set(templates.map((entry) => entry.teamId));
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-foreground/15 bg-background/30 p-2 md:p-3">
        <span className={cn("mr-auto text-sm font-semibold", VALUE_COLORS.cap)}>
          {t.ui("lineup.teamRemoved")}
        </span>
        <TeamSelect
          teams={teams.filter((entry) => !linked.has(entry.id))}
          placeholder={t.ui("lineup.linkTeam")}
          onSelect={(next) =>
            updateTemplate(template.id, (current) => ({
              ...current,
              teamId: next.id,
            }))
          }
        />
        {deleteButton}
      </div>
    );
  }

  const setupConfig = savedConfig ?? getSetupConfig(team.id);
  const capture = accountData
    ? () =>
        captureTeamReferenceBuild(team, setupConfig, accountData, Date.now())
    : null;
  const encountersById = new Map(
    encounters.map((encounter) => [encounter.id, encounter])
  );
  const ownCalibrations = calibrations.filter(
    (calibration) =>
      calibration.templateId === template.id &&
      encountersById.has(calibration.encounterId)
  );
  const calibrated = new Set(ownCalibrations.map((entry) => entry.encounterId));
  const record = (encounterId: string, measuredSeconds: number) => {
    const reference = capture?.();
    if (!reference) return;
    saveCalibration({
      id: newLineupId("calibration"),
      templateId: template.id,
      encounterId,
      reference,
      measuredSeconds,
      downtimeSeconds: null,
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-foreground/15 bg-background/30 p-2 md:p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="mr-auto min-w-0 text-sm font-bold md:text-base">
          <TeamIdentity team={team} index={teams.indexOf(team)} size={24} />
        </span>
        <NumberField
          label={t.ui("lineup.rotation")}
          value={setupConfig.damage?.rotationSeconds ?? null}
          placeholder="—"
          unit={t.ui("teamComp.dpsSeconds")}
          onCommit={(value) =>
            updateTeamSetupConfig(team.id, (config) =>
              withRotationSeconds(config, value)
            )
          }
        />
        {deleteButton}
      </div>
      <TemplateSetUptimes
        team={team}
        setupConfig={setupConfig}
        accountData={accountData}
        onChange={(setId, share) =>
          updateTeamSetupConfig(team.id, (config) =>
            withSetUptime(config, setId, share)
          )
        }
      />
      {!setupConfig.damage?.combo && (
        <p className="text-xs text-muted-foreground">
          {t.ui("lineup.noSavedRotation")}
        </p>
      )}
      <FlexSlots template={template} team={team} />
      <CompositionRules
        template={template}
        compositionCount={compositions.length}
        fieldsOwnTeam={fieldsOwnTeam}
      />
      {encounters.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className={SUBHEAD_CLS}>{t.ui("lineup.clears")}</span>
          {ownCalibrations.map((calibration) => (
            <CalibrationRow
              key={calibration.id}
              calibration={calibration}
              encounter={encountersById.get(calibration.encounterId)!}
              teamChanged={!referenceMatchesTeam(calibration.reference, team)}
              onRecapture={
                capture
                  ? () => {
                      const reference = capture();
                      if (reference)
                        saveCalibration({ ...calibration, reference });
                    }
                  : null
              }
            />
          ))}
          <RecordClear
            encounters={encounters.filter(
              (encounter) => !calibrated.has(encounter.id)
            )}
            onRecord={capture ? record : null}
          />
        </div>
      )}
    </div>
  );
}

export function LineupTemplates() {
  const { t } = useLanguage();
  const templates = useLineupStore((s) => s.templates);
  const encounters = useLineupStore((s) => s.encounters);
  const addTemplate = useLineupStore((s) => s.addTemplate);
  const teams = useTeamStore((s) => s.teamComps);
  const linked = new Set(templates.map((template) => template.teamId));
  const available = teams.filter(
    (team) => !linked.has(team.id) && teamCharacters(team).length > 0
  );

  return (
    <section className={LINEUP_SECTION_CLS}>
      <div className={LINEUP_HEADER_CLS}>
        <h2 className="mr-auto text-base font-bold tracking-tight">
          {t.ui("lineup.teams")}
        </h2>
        <TeamSelect
          teams={available}
          placeholder={t.ui("lineup.addTeam")}
          onSelect={(team) =>
            addTemplate(createTeamTemplate(newLineupId("template"), team))
          }
        />
      </div>
      {templates.length > 0 && (
        <div className="flex flex-col gap-2 p-2 md:p-3">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              encounters={encounters}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Uptime of the timed sets the team wears, scored on its rotation. Sets a
 *  lineup moves to another member keep the share set here. */
function TemplateSetUptimes({
  team,
  setupConfig,
  accountData,
  onChange,
}: {
  team: TeamComp;
  setupConfig: TeamSetupConfig;
  accountData: AccountData | null;
  onChange: (setId: string, share: number | null) => void;
}) {
  const effects = useMemo(() => {
    const configs = buildTeamSlotConfigs(team, setupConfig, accountData);
    if (configs.length === 0) return [];
    try {
      const build = new TeamBuild(
        configs,
        setupConfig.combatOptions ?? {},
        setupConfig.damage?.enemyAura,
        setupConfig.damage?.extraBuffs
      );
      const objective = resolveTeamObjective(setupConfig.damage, build);
      return build.getTimedSetEffects(
        objective.lines,
        teamSetUptimes(setupConfig.damage)
      );
    } catch {
      return [];
    }
  }, [team, setupConfig, accountData]);
  return (
    <SetUptimeFields
      effects={effects}
      overrides={setupConfig.damage?.setUptimes}
      hasRotationSeconds={setupConfig.damage?.rotationSeconds != null}
      onChange={onChange}
    />
  );
}
