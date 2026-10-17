import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { useMediaQuery } from "@/components/ui/useMediaQuery";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  collectOwnedWeaponChoices,
  getCompatibleOwnedWeaponChoices,
} from "@/domain/combat/analyzer/weaponChoiceCandidates";
import { extractComboOverrides } from "@/domain/combat/damage/core/comboBuffOverrides";
import type { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type {
  CalcContext,
  ComboFormula,
  TeamSlotConfig,
} from "@/domain/combat/damage/types";
import { resolveCalcContext } from "@/domain/combat/damage/utils";
import { SET_DEFAULT_TIME_BUDGET_SEC } from "@/domain/combat/lineup/constants";
import { setChoiceKey } from "@/domain/combat/lineup/setChoices";
import type { AccountData, ArtifactSetConfig } from "@/domain/models";
import { weaponStatsResource } from "@/domain/reference/stats";
import type {
  SetAssignment,
  SetConfigExplorerFailure,
  SetConfigExplorerSettings,
} from "@/domain/team/setConfigExplorerTypes";
import {
  buildWeaponChoiceCharConfigs,
  getHigherTierEquippedArtifactIds,
} from "@/domain/team/teamConfigUtils";
import {
  teamCalculationInputs,
  teamCompToArrays,
} from "@/domain/team/teamDeltas";
import type {
  ChoiceResultCache,
  TeamComp,
  TeamSetupConfig,
  WeaponChoiceResult,
} from "@/domain/team/types";
import { useAsyncWeaponChoice } from "@/hooks/useAsyncWeaponChoice";
import { useResource } from "@/hooks/useResource";
import {
  type SetConfigExplorerProgress,
  useSetConfigExplorer,
} from "@/hooks/useSetConfigExplorer";
import { useTeamInventory } from "@/hooks/useTeamInventory";
import { selectActiveTierAssignments } from "@/stores/createTierStore";
import { useBuffOverrideStore } from "@/stores/useBuffOverrideStore";
import { useFreezeStore } from "@/stores/useFreezeStore";
import {
  choiceResultsFromTeamResultCache,
  useTeamResultCacheStore,
} from "@/stores/useTeamResultCacheStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { useTierStore } from "@/stores/useTierStore";
import { TeamSetsControls } from "./TeamSetsControls";
import { TeamSetsResults } from "./TeamSetsResults";
import {
  type BuildComparisonMode,
  WeaponChoiceResultCard,
} from "./WeaponChoiceResultCard";

/** Team-sets settings for this session, by team. */
const teamSetSettings = new Map<string, SetConfigExplorerSettings>();

/** Progress bar span of each stage, as fractions of the whole run. */
function teamSetsProgress(
  progress: SetConfigExplorerProgress | null,
  useAccount: boolean
): number {
  if (!progress) return 0;
  const spans: Record<SetConfigExplorerProgress["stage"], [number, number]> =
    useAccount
      ? {
          screen: [0, 0.03],
          joint: [0.03, 0.08],
          generate: [0.08, 0.2],
          optimize: [0.2, 1],
        }
      : {
          screen: [0, 0.05],
          joint: [0.05, 0.3],
          generate: [0.3, 1],
          optimize: [1, 1],
        };
  const [from, to] = spans[progress.stage];
  const share = progress.total > 0 ? progress.done / progress.total : 0;
  return from + (to - from) * share;
}

interface BuildComparisonPanelProps {
  teamComp: TeamComp;
  setupConfig: TeamSetupConfig;
  accountData: AccountData | null;
  teamBuild: TeamBuild | null;
  configs: TeamSlotConfig[];
  objectiveCombo: ComboFormula;
  /** Search context (includes per-character CRIT Rate targets). */
  optimizeContext: CalcContext;
  /** Context for displayed damage. */
  displayContext: CalcContext;
}

export function BuildComparisonPanel({
  teamComp,
  setupConfig,
  accountData,
  teamBuild,
  configs,
  objectiveCombo,
  optimizeContext,
  displayContext,
}: BuildComparisonPanelProps) {
  const { t } = useLanguage();
  const isMobile = useMediaQuery("(max-width: 1023px)");
  const weaponStats = useResource(weaponStatsResource);
  const updateTeamComp = useTeamStore((s) => s.updateTeamComp);
  const updateTeamSetupConfig = useTeamStore((s) => s.updateTeamSetupConfig);
  const resultCache = useTeamResultCacheStore(
    (s) => s.resultsByTeamId[teamComp.id]
  );
  const setChoiceResult = useTeamResultCacheStore((s) => s.setChoiceResult);
  const clearChoiceResults = useTeamResultCacheStore(
    (s) => s.clearChoiceResults
  );
  const [mode, setMode] = useState<BuildComparisonMode>("weapon");
  const [ownedWeaponsOnly, setOwnedWeaponsOnly] = useState(false);
  const owned = mode === "weapon" && ownedWeaponsOnly;
  const { characters, weapons, artifacts } = useMemo(
    () => teamCompToArrays(teamComp),
    [teamComp]
  );
  const ownedChoices = useMemo(
    () => (accountData ? collectOwnedWeaponChoices(accountData) : []),
    [accountData]
  );
  const {
    result: computed,
    isComputing,
    error,
    start,
    stop,
  } = useAsyncWeaponChoice();
  const [localResults, setLocalResults] = useState<ChoiceResultCache>({});
  const [ownedResult, setOwnedResult] = useState<WeaponChoiceResult | null>(
    null
  );
  const inputKey = JSON.stringify({
    teamComp,
    configs,
    objectiveCombo,
    damage: teamCalculationInputs(setupConfig).damage,
    combat: setupConfig.combatOptions,
    requirements: setupConfig.charConfigs,
  });
  const ownedInputKey = JSON.stringify(ownedChoices);
  const previousOwnedInput = useRef(ownedInputKey);
  const previousInput = useRef(inputKey);
  const runInput = useRef<string | null>(null);
  const runOwned = useRef(false);
  const updateSetup = useCallback(
    (
      updater:
        | Partial<TeamSetupConfig>
        | ((config: TeamSetupConfig) => TeamSetupConfig)
    ) => updateTeamSetupConfig(teamComp.id, updater),
    [teamComp.id, updateTeamSetupConfig]
  );

  useEffect(() => {
    if (previousOwnedInput.current === ownedInputKey) return;
    previousOwnedInput.current = ownedInputKey;
    setOwnedResult(null);
    if (runOwned.current) {
      runInput.current = null;
      stop();
    }
  }, [ownedInputKey, stop]);

  useEffect(() => {
    if (previousInput.current === inputKey) return;
    previousInput.current = inputKey;
    runInput.current = null;
    stop();
    setLocalResults({});
    setOwnedResult(null);
    clearChoiceResults(teamComp.id);
  }, [inputKey, stop, clearChoiceResults, teamComp.id]);

  useEffect(() => {
    if (!computed || runInput.current !== inputKey) return;
    const result: WeaponChoiceResult = {
      mode: computed.mode,
      timestamp: computed.timestamp,
      perCharacter: computed.perCharacter,
      artifactAssignmentSuggestion: computed.artifactAssignmentSuggestion,
    };
    if (runOwned.current && computed.mode === "weapon") setOwnedResult(result);
    else {
      setLocalResults((prev) => ({ ...prev, [computed.mode]: result }));
      if (computed.done)
        setChoiceResult(teamComp.id, computed.mode, result, inputKey);
    }
  }, [computed, inputKey, setChoiceResult, teamComp.id]);

  // ─── Team sets ───
  const [setSettings, setSetSettingsState] =
    useState<SetConfigExplorerSettings>(
      () =>
        teamSetSettings.get(teamComp.id) ?? {
          useAccountArtifacts: accountData !== null,
          lockedCharIds: [],
          pinned: {},
          timeBudgetSec: SET_DEFAULT_TIME_BUDGET_SEC,
        }
    );
  const updateSetSettings = (next: SetConfigExplorerSettings) => {
    teamSetSettings.set(teamComp.id, next);
    setSetSettingsState(next);
  };
  const comboOverrides = useBuffOverrideStore((s) => s.comboOverrides);
  const userBuffOverrides = useMemo(
    () => extractComboOverrides(comboOverrides, objectiveCombo.id),
    [comboOverrides, objectiveCombo.id]
  );
  const frozenTeams = useFreezeStore((s) => s.frozenTeams);
  const reuseMode = useFreezeStore((s) => s.reuseMode);
  const standaloneIds = useFreezeStore((s) => s.frozenArtifactIds);
  const tierAssignments = useTierStore(selectActiveTierAssignments);
  const { forceReuseChars } = useTeamInventory(teamComp.id);
  const forcedCharIds = useMemo(
    () => new Set(Object.keys(forceReuseChars)),
    [forceReuseChars]
  );
  const memberIds = configs.map((config) => config.charId);
  const accountKey = useMemo(() => JSON.stringify(accountData), [accountData]);
  const useAccount = setSettings.useAccountArtifacts;
  // Set goals are left out: the explorer searches them, so results survive Apply.
  const teamSetsSignature = useMemo(
    () =>
      JSON.stringify({
        slots: teamComp.slots.map(({ charId, weaponId }) => ({
          charId,
          weaponId,
        })),
        reactions: teamComp.reactions,
        setupConfig,
        objectiveCombo,
        optimizeContext,
        displayContext,
        userBuffOverrides,
        useAccount,
        account: useAccount ? accountKey : null,
        reservations: useAccount
          ? { frozenTeams, reuseMode, standaloneIds, tierAssignments }
          : null,
      }),
    [
      teamComp.slots,
      teamComp.reactions,
      setupConfig,
      objectiveCombo,
      optimizeContext,
      displayContext,
      userBuffOverrides,
      useAccount,
      accountKey,
      frozenTeams,
      reuseMode,
      standaloneIds,
      tierAssignments,
    ]
  );
  const explorer = useSetConfigExplorer(teamComp.id, teamSetsSignature);
  const present: SetAssignment = Object.fromEntries(
    teamComp.slots.flatMap((slot) =>
      slot.charId ? [[slot.charId, slot.artifactSet ?? null]] : []
    )
  );
  const runTeamSets = () => {
    explorer.start({
      teamComp,
      setupConfig,
      accountData,
      objective: objectiveCombo,
      userBuffOverrides,
      carryCharId:
        objectiveCombo.lines.find((line) => line.count > 0)?.charId ??
        memberIds[0] ??
        "",
      optimizeContext,
      displayContext,
      settings: setSettings,
      perCharExcludedArtifactIds: accountData
        ? Object.fromEntries(
            memberIds.flatMap((charId) =>
              setupConfig.charConfigs?.[charId]?.tierAwarePool
                ? [
                    [
                      charId,
                      [
                        ...getHigherTierEquippedArtifactIds(
                          charId,
                          tierAssignments,
                          accountData
                        ),
                      ],
                    ],
                  ]
                : []
            )
          )
        : undefined,
      inventoryReservations: { teams: frozenTeams, reuseMode, standaloneIds },
    });
  };
  const applyAssignment = (assignment: SetAssignment) =>
    updateTeamComp(teamComp.id, {
      ...teamComp,
      slots: teamComp.slots.map((slot) =>
        slot.charId && slot.charId in assignment
          ? { ...slot, artifactSet: assignment[slot.charId] ?? null }
          : slot
      ),
    });
  const togglePin = (charId: string, choice: ArtifactSetConfig | null) => {
    if (!choice) return;
    const key = setChoiceKey(choice);
    const current = setSettings.pinned[charId] ?? [];
    const next = current.some((pin) => setChoiceKey(pin) === key)
      ? current.filter((pin) => setChoiceKey(pin) !== key)
      : [...current, choice];
    updateSetSettings({
      ...setSettings,
      pinned: { ...setSettings.pinned, [charId]: next },
    });
  };
  const teamSetsError = (reason: SetConfigExplorerFailure) => {
    switch (reason) {
      case "no-objective":
        return t.ui("charactersMode.errors.noObjective");
      case "no-account":
        return t.ui("teamComp.teamSetsNeedsAccount");
      case "no-members":
        return t.ui("teamComp.teamSetsNoMembers");
      default:
        return t.ui("charactersMode.errors.calculator");
    }
  };
  const stageLabels: Record<SetConfigExplorerProgress["stage"], string> = {
    screen: t.ui("teamComp.teamSetsStageScreen"),
    joint: t.ui("teamComp.teamSetsStageJoint"),
    generate: t.ui("teamComp.teamSetsStageGenerate"),
    optimize: t.ui("teamComp.teamSetsStageOptimize"),
  };
  const teamSetsBody = (
    <div className="space-y-2">
      {useAccount && !accountData && (
        <p className="text-sm text-muted-foreground text-center">
          {t.ui("teamComp.teamSetsNeedsAccount")}
        </p>
      )}
      {explorer.isComputing && (
        <div className="space-y-1.5">
          <Progress
            value={Math.round(
              teamSetsProgress(explorer.progress, useAccount) * 100
            )}
            className="h-2"
          />
          <p className="text-xs text-muted-foreground">
            {explorer.progress
              ? `${stageLabels[explorer.progress.stage]} ${explorer.progress.done}/${explorer.progress.total}`
              : t.ui("teamComp.weaponChoiceRunning")}
          </p>
        </div>
      )}
      {explorer.error && (
        <p className="text-sm text-destructive">
          {teamSetsError(explorer.error)}
        </p>
      )}
      {explorer.result && (
        <TeamSetsResults
          result={explorer.result}
          present={present}
          userBuffOverrides={userBuffOverrides}
          isMobile={isMobile}
          onApply={applyAssignment}
          onTogglePin={togglePin}
          t={t}
        />
      )}
    </div>
  );

  const run = () => {
    if (mode === "teamSets") return runTeamSets();
    if (!teamBuild || !weaponStats) return;
    runInput.current = inputKey;
    runOwned.current = owned;
    start({
      mode,
      baseConfigs: configs,
      charConfigs: buildWeaponChoiceCharConfigs(
        teamComp,
        setupConfig,
        accountData
      ),
      combo: objectiveCombo,
      calcContext: resolveCalcContext(setupConfig.damage?.calcContext),
      weaponStats,
      opts: setupConfig.combatOptions ?? {},
      enemyAura: setupConfig.damage?.enemyAura,
      extraBuffs: setupConfig.damage?.extraBuffs,
      ownedWeaponChoices: owned ? ownedChoices : undefined,
    });
  };
  const persist = (
    resultMode: "weapon" | "artifact",
    result: WeaponChoiceResult | null
  ) => {
    if (owned && resultMode === "weapon") setOwnedResult(result);
    else {
      setLocalResults((prev) => ({ ...prev, [resultMode]: result }));
      setChoiceResult(teamComp.id, resultMode, result, inputKey);
    }
  };
  if (!teamBuild || !weaponStats) return null;
  const cached = choiceResultsFromTeamResultCache(resultCache);
  if (resultCache?.weaponChoiceInputKey !== inputKey) cached.weapon = undefined;
  if (resultCache?.artifactChoiceInputKey !== inputKey)
    cached.artifact = undefined;
  return (
    <WeaponChoiceResultCard
      teamComp={teamComp}
      setupConfig={setupConfig}
      characters={characters}
      weapons={weapons}
      artifacts={artifacts}
      teamMeta={teamBuild.teamMeta}
      onTeamCompChange={(comp) => updateTeamComp(comp.id, comp)}
      onSetupConfigChange={updateSetup}
      setChoiceResult={persist}
      charIds={characters.filter((id): id is string => id !== null)}
      isComputing={mode === "teamSets" ? explorer.isComputing : isComputing}
      choiceMode={mode}
      ownedWeaponsOnly={owned}
      onChoiceModeChange={(next) => {
        stop();
        runInput.current = null;
        setMode(next);
      }}
      onOwnedWeaponsOnlyChange={(next) => {
        stop();
        runInput.current = null;
        setOwnedWeaponsOnly(next);
      }}
      hasAccount={accountData !== null}
      hasOwnedCompatibleWeapons={configs.some(
        (config) =>
          getCompatibleOwnedWeaponChoices(
            ownedChoices,
            weaponStats[config.weaponId]?.type ?? "",
            weaponStats
          ).length > 0
      )}
      runDisabled={
        mode === "teamSets"
          ? memberIds.length === 0 || (useAccount && !accountData)
          : owned && !accountData
      }
      result={
        mode === "teamSets"
          ? null
          : owned
            ? ownedResult
            : (localResults[mode] ?? cached[mode] ?? null)
      }
      progress={mode === "teamSets" ? undefined : computed?.progress}
      error={mode === "teamSets" ? null : error}
      onRun={run}
      onStop={mode === "teamSets" ? explorer.stop : stop}
      modeControls={
        mode === "teamSets" ? (
          <TeamSetsControls
            memberIds={memberIds}
            settings={setSettings}
            onSettingsChange={updateSetSettings}
            forcedCharIds={forcedCharIds}
            disabled={explorer.isComputing}
            t={t}
          />
        ) : undefined
      }
      modeBody={teamSetsBody}
      t={t}
    />
  );
}
