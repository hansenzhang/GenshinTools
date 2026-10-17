/**
 * Team set explorer job (docs/design/lineup-solver.md, P1).
 *
 * Screens set assignments for one team (domain/combat/lineup/setConfigScreen),
 * then optimizes the finalists on the account's artifacts one at a time and
 * re-scores the pieces it finds with the sets they actually form.
 */

import { TIER_LIST_SUPPORT_ARTIFACT_SETS } from "@/config/gameConstants";
import { buildBuffOverrides } from "@/domain/combat/damage/core/comboBuffOverrides";
import { StatSheet } from "@/domain/combat/damage/core/statSheet";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type { ComboFormula } from "@/domain/combat/damage/types";
import {
  SET_ACCOUNT_TIE_PERCENT,
  SET_GENERATED_TIE_PERCENT,
  SET_MAX_FINALISTS,
  SET_MIN_RUN_MS,
} from "@/domain/combat/lineup/constants";
import {
  buildChoiceRows,
  pickBestOutcome,
  selectFinalists,
} from "@/domain/combat/lineup/setAssignments";
import {
  evaluateAssignment,
  runSetConfigScreen,
  type SetRequirement,
  type SetScreenInput,
} from "@/domain/combat/lineup/setConfigScreen";
import {
  canWearSetConfig,
  countSetSlots,
  isAssignmentJointlyFeasible,
} from "@/domain/combat/lineup/setFeasibility";
import { allSlots, type Element, type Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import { artifactsById } from "@/domain/reference/catalog";
import type { CharacterStatsMap } from "@/domain/reference/stats";
import { computeTeamInventory } from "@/domain/team/artifactInventory";
import type {
  SetAccountOutcome,
  SetAssignment,
  SetAssignmentOutcome,
  SetConfigExplorerMessage,
  SetConfigExplorerRequest,
  SetConfigExplorerResult,
} from "@/domain/team/setConfigExplorerTypes";
import {
  buildTeamSlotConfigs,
  detectEquippedSets,
} from "@/domain/team/teamConfigUtils";
import type { CharOptConfig, OptFailReason } from "@/domain/team/types";
import { runTeamOptimization } from "../optimizer/teamOptimization";

type Report = (message: SetConfigExplorerMessage) => void;
type ArtifactsByChar = Record<string, Record<Slot, ArtifactData | null>>;

/** Requirements as the Artifacts tab optimizer reads them. */
function resolveRequirement(
  request: SetConfigExplorerRequest,
  charId: string
): SetRequirement {
  const config = request.setupConfig.charConfigs?.[charId];
  return {
    minEr: config?.minEr ?? 1,
    minCr: config?.crMode === "target" ? 0 : (config?.minCr ?? 0),
  };
}

function collectAccountArtifacts(
  request: SetConfigExplorerRequest
): ArtifactData[] {
  const account = request.accountData;
  if (!account) return [];
  return [
    ...new Map(
      [
        ...account.characters.flatMap((char) =>
          Object.values(char.artifacts).filter(
            (artifact): artifact is ArtifactData => !!artifact
          )
        ),
        ...account.extraArtifacts,
      ].map((artifact) => [artifact.id, artifact])
    ).values(),
  ];
}

function sheetsFromPieces(
  artifactsByChar: ArtifactsByChar
): Record<string, StatSheet> {
  return Object.fromEntries(
    Object.entries(artifactsByChar).map(([charId, slots]) => [
      charId,
      StatSheet.fromArtifacts(
        Object.values(slots).filter(
          (artifact): artifact is ArtifactData => artifact !== null
        )
      ),
    ])
  );
}

/** Sets the pieces form; unknown set keys count as no set. */
function realizedSets(
  artifactsByChar: ArtifactsByChar,
  charIds: readonly string[]
): SetAssignment {
  return Object.fromEntries(
    charIds.map((charId) => [
      charId,
      detectEquippedSets(
        Object.values(artifactsByChar[charId] ?? {}).filter(
          (artifact) => artifact !== null && !!artifactsById[artifact.setKey]
        )
      ),
    ])
  );
}

function findUnmetMembers(
  screen: SetScreenInput,
  assignment: SetAssignment,
  sheets: Record<string, StatSheet>
): string[] {
  const team = new TeamBuild(
    screen.configs.map((config) => ({
      ...config,
      artifactSet: assignment[config.charId] ?? null,
    })),
    screen.combatOptions,
    screen.enemyAura,
    screen.extraBuffs,
    undefined,
    screen.displayContext
  );
  return screen.configs.flatMap((config) => {
    const requirement = screen.requirements[config.charId];
    if (!requirement?.minEr && !requirement?.minCr) return [];
    const stats = team.getTeamStats(
      sheets,
      config.charId,
      screen.displayContext
    )[config.charId];
    const er = stats?.get("er", null) ?? 0;
    const cr = stats?.get("cr", null) ?? 0;
    return er + 1e-6 < requirement.minEr || cr + 1e-6 < requirement.minCr
      ? [config.charId]
      : [];
  });
}

/** Score a complete set of real pieces with the sets they actually form. */
function scorePieces(
  screen: SetScreenInput,
  artifactsByChar: ArtifactsByChar,
  failReasons: Record<string, OptFailReason>
): SetAccountOutcome {
  const charIds = screen.configs.map((config) => config.charId);
  const realized = realizedSets(artifactsByChar, charIds);
  const complete = charIds.every((charId) =>
    allSlots.every((slot) => artifactsByChar[charId]?.[slot])
  );
  const ids = charIds.flatMap((charId) =>
    Object.values(artifactsByChar[charId] ?? {}).flatMap((artifact) =>
      artifact ? [artifact.id] : []
    )
  );
  // The optimizer post-fills members it failed on; those pieces don't count.
  const failed = Object.values(failReasons).some(
    (reason) => reason.kind !== "timeout"
  );
  if (failed || !complete || new Set(ids).size !== ids.length)
    return {
      damage: null,
      realized,
      artifactsByChar,
      failReasons,
      unmetCharIds: [],
    };
  const sheets = sheetsFromPieces(artifactsByChar);
  const unmetCharIds = findUnmetMembers(screen, realized, sheets);
  const damage =
    unmetCharIds.length > 0
      ? null
      : evaluateAssignment(screen, realized, sheets);
  return { damage, realized, artifactsByChar, failReasons, unmetCharIds };
}

function buildResult(
  base: Omit<SetConfigExplorerResult, "rowsByChar" | "bestIndex">,
  current: SetAssignment,
  pinned: SetConfigExplorerRequest["settings"]["pinned"]
): SetConfigExplorerResult {
  const { outcomes, charIds } = base;
  const account = base.basis === "account";
  const score = (outcome: SetAssignmentOutcome) =>
    account
      ? (outcome.account?.damage ?? null)
      : (outcome.generatedDamage ?? null);
  const scored = outcomes.flatMap((outcome, index) =>
    score(outcome) == null ? [] : [index]
  );
  const bestIndex =
    pickBestOutcome(
      outcomes,
      scored,
      score,
      current,
      charIds,
      base.tiePercent
    ) ?? base.currentIndex;
  return {
    ...base,
    bestIndex,
    rowsByChar: buildChoiceRows(outcomes, charIds, pinned),
  };
}

export async function runSetConfigExplorer(
  request: SetConfigExplorerRequest,
  chars: CharacterStatsMap,
  report: Report
): Promise<void> {
  const fail = (
    reason: Extract<SetConfigExplorerMessage, { type: "error" }>["reason"],
    details?: string
  ) => report({ type: "error", reason, details });
  const { settings } = request;
  if (settings.useAccountArtifacts && !request.accountData)
    return fail("no-account");
  const configs = buildTeamSlotConfigs(
    request.teamComp,
    request.setupConfig,
    request.accountData
  );
  if (configs.length === 0) return fail("no-members");
  const charIds = configs.map((config) => config.charId);
  const current: SetAssignment = Object.fromEntries(
    configs.map((config) => [config.charId, config.artifactSet ?? null])
  );

  const probe = new TeamBuild(
    configs,
    request.setupConfig.combatOptions ?? {},
    request.setupConfig.damage?.enemyAura,
    request.setupConfig.damage?.extraBuffs,
    undefined,
    request.displayContext
  );
  const combo: ComboFormula = {
    ...request.objective,
    lines: request.objective.lines.filter(
      (line) => line.count > 0 && probe.catalog.formulaIndex.has(line.formulaId)
    ),
    buffOverrides: undefined,
  };
  if (combo.lines.length === 0) return fail("no-objective");

  const allArtifacts = collectAccountArtifacts(request);
  const reservations = request.inventoryReservations;
  const inventoryFor = (assignment: SetAssignment) =>
    computeTeamInventory({
      allArtifacts,
      frozenTeams: reservations?.teams ?? {},
      reuseMode: reservations?.reuseMode ?? "none",
      standaloneFrozenIds: reservations?.standaloneIds ?? [],
      teamId: request.teamComp.id,
      teamCharacters: request.teamComp.slots.map((slot) => slot.charId),
      teamArtifacts: request.teamComp.slots.map((slot) =>
        slot.charId ? (assignment[slot.charId] ?? null) : null
      ),
    });
  const useAccount = settings.useAccountArtifacts;
  const baseInventory = useAccount ? inventoryFor(current) : null;
  const forced = baseInventory?.forceReuseChars ?? {};
  const poolFor = (charId: string, inventory = baseInventory) => {
    if (!inventory) return [];
    const excluded = new Set(request.perCharExcludedArtifactIds?.[charId]);
    return [
      ...inventory.availableArtifacts,
      ...(inventory.perCharExtraArtifacts[charId] ?? []),
    ].filter((artifact) => !excluded.has(artifact.id));
  };
  const countsByChar = Object.fromEntries(
    charIds.map((charId) => [charId, countSetSlots(poolFor(charId))])
  );
  const sharedCounts = countSetSlots(baseInventory?.availableArtifacts ?? []);

  const screen: SetScreenInput = {
    configs,
    combo,
    userBuffOverrides: request.userBuffOverrides,
    combatOptions: request.setupConfig.combatOptions ?? {},
    enemyAura: request.setupConfig.damage?.enemyAura,
    extraBuffs: request.setupConfig.damage?.extraBuffs,
    optimizeContext: request.optimizeContext,
    displayContext: request.displayContext,
    carryCharId: charIds.includes(request.carryCharId)
      ? request.carryCharId
      : combo.lines[0].charId,
    requirements: Object.fromEntries(
      charIds.map((charId) => [charId, resolveRequirement(request, charId)])
    ),
    elements: Object.fromEntries(
      charIds.map((charId) => [charId, chars[charId]?.element as Element])
    ),
    lockedCharIds: new Set([
      ...settings.lockedCharIds,
      ...Object.keys(forced).filter((charId) => charIds.includes(charId)),
    ]),
    pinned: settings.pinned,
    fixedSheets: sheetsFromPieces(
      Object.fromEntries(
        Object.entries(forced).filter(([charId]) => charIds.includes(charId))
      )
    ),
    ...(useAccount
      ? {
          canWear: (charId, choice) =>
            canWearSetConfig(choice, countsByChar[charId]),
          isJointlyFeasible: (assignment) =>
            isAssignmentJointlyFeasible(assignment, sharedCounts),
        }
      : {}),
  };

  const output = await runSetConfigScreen(screen, (stage, done, total) =>
    report({ type: "progress", stage, done, total })
  );
  if (!output)
    return fail("calculator-error", "The current sets cannot be scored.");
  const { outcomes, currentIndex } = output;
  let evaluated = output.evaluated;
  let skipped = output.skipped;

  const generatedResult = buildResult(
    {
      basis: "generated",
      outcomes,
      charIds,
      currentIndex,
      equippedDamage: null,
      tiePercent: SET_GENERATED_TIE_PERCENT,
      evaluated,
      skipped,
      partial: useAccount,
    },
    current,
    settings.pinned
  );
  if (!useAccount) {
    report({ type: "result", result: generatedResult });
    return;
  }
  report({ type: "partial", result: generatedResult });

  const budgetMs = Math.max(1, settings.timeBudgetSec) * 1000;
  const maxRuns = Math.max(2, Math.floor(budgetMs / SET_MIN_RUN_MS));
  const finalists = selectFinalists({
    outcomes,
    charIds,
    score: (outcome) => outcome.generatedDamage ?? null,
    bestIndex: generatedResult.bestIndex,
    currentIndex,
    teamBuffSetIds: TIER_LIST_SUPPORT_ARTIFACT_SETS,
    pinned: settings.pinned,
    max: Math.min(SET_MAX_FINALISTS, maxRuns - 1),
  });
  const runs = [currentIndex, ...finalists];
  const runMs = budgetMs / runs.length;
  const account = request.accountData!;

  for (const [done, index] of runs.entries()) {
    report({ type: "progress", stage: "optimize", done, total: runs.length });
    const outcome = outcomes[index];
    const inventory = inventoryFor(outcome.assignment);
    const forcedNow = Object.fromEntries(
      Object.entries(inventory.forceReuseChars).filter(([charId]) =>
        charIds.includes(charId)
      )
    );
    const forcedIds = new Set(
      Object.values(forcedNow).flatMap((slots) =>
        Object.values(slots).flatMap((artifact) =>
          artifact ? [artifact.id] : []
        )
      )
    );
    const runConfigs = configs.map((config) => ({
      ...config,
      artifactSet: outcome.assignment[config.charId] ?? null,
    }));
    const team = new TeamBuild(
      runConfigs,
      screen.combatOptions,
      screen.enemyAura,
      screen.extraBuffs,
      undefined,
      request.optimizeContext
    );
    const baseSheets: Record<string, StatSheet> = {};
    for (const charId of charIds) {
      const owned = account.characters.find((char) => char.key === charId);
      baseSheets[charId] = StatSheet.fromArtifacts(
        Object.values(owned?.artifacts ?? {}).filter(
          (artifact): artifact is ArtifactData => !!artifact
        )
      );
    }
    Object.assign(baseSheets, sheetsFromPieces(forcedNow));
    const perChar: Record<string, CharOptConfig> = {};
    for (const config of runConfigs) {
      if (forcedNow[config.charId]) continue;
      perChar[config.charId] = {
        ...screen.requirements[config.charId],
        artifactSet: config.artifactSet,
      };
    }
    let found: ArtifactsByChar | null = null;
    let failReasons: Record<string, OptFailReason> = {};
    try {
      for await (const update of runTeamOptimization({
        teamBuild: team,
        carryCharId: screen.carryCharId,
        combo: {
          ...combo,
          buffOverrides: buildBuffOverrides(
            combo.lines,
            team,
            baseSheets,
            request.displayContext,
            request.userBuffOverrides
          ),
        },
        inventory: inventory.availableArtifacts.filter(
          (artifact) => !forcedIds.has(artifact.id)
        ),
        calcContext: request.optimizeContext,
        baseSheets,
        perChar,
        teamDeadlineMs: performance.now() + runMs,
        perCharExtraArtifacts: Object.fromEntries(
          Object.entries(inventory.perCharExtraArtifacts).map(
            ([charId, artifacts]) => [
              charId,
              forcedNow[charId]
                ? []
                : artifacts.filter((artifact) => !forcedIds.has(artifact.id)),
            ]
          )
        ),
        perCharExcludedArtifactIds: request.perCharExcludedArtifactIds,
      })) {
        if (!update.done) continue;
        found = { ...update.bestArtifactsByChar, ...forcedNow };
        failReasons = update.failReasons;
      }
    } catch (error) {
      failReasons = Object.fromEntries(
        Object.keys(perChar).map((charId) => [
          charId,
          {
            kind: "worker-error",
            message: error instanceof Error ? error.message : String(error),
          },
        ])
      );
    }
    evaluated++;
    outcome.account = scorePieces(screen, found ?? {}, failReasons);
    if (outcome.account.damage == null) skipped++;
    report({
      type: "partial",
      result: buildResult(
        {
          basis: "account",
          outcomes,
          charIds,
          currentIndex,
          equippedDamage: null,
          tiePercent: SET_ACCOUNT_TIE_PERCENT,
          evaluated,
          skipped,
          partial: true,
        },
        current,
        settings.pinned
      ),
    });
  }

  report({
    type: "result",
    result: buildResult(
      {
        basis: "account",
        outcomes,
        charIds,
        currentIndex,
        equippedDamage: scoreEquipped(screen, request, baseInventory, charIds),
        tiePercent: SET_ACCOUNT_TIE_PERCENT,
        evaluated,
        skipped,
        partial: false,
      },
      current,
      settings.pinned
    ),
  });
}

/** Damage of the members' equipped pieces, when every one is still available. */
function scoreEquipped(
  screen: SetScreenInput,
  request: SetConfigExplorerRequest,
  inventory: ReturnType<typeof computeTeamInventory> | null,
  charIds: readonly string[]
): number | null {
  if (!inventory) return null;
  const artifactsByChar: ArtifactsByChar = {};
  for (const charId of charIds) {
    const owned = request.accountData?.characters.find(
      (char) => char.key === charId
    );
    const available = new Set(
      [
        ...inventory.availableArtifacts,
        ...(inventory.perCharExtraArtifacts[charId] ?? []),
      ].map((artifact) => artifact.id)
    );
    const slots = Object.fromEntries(
      allSlots.map((slot) => [slot, owned?.artifacts[slot] ?? null])
    ) as Record<Slot, ArtifactData | null>;
    if (allSlots.some((slot) => !slots[slot] || !available.has(slots[slot].id)))
      return null;
    artifactsByChar[charId] = slots;
  }
  return scorePieces(screen, artifactsByChar, {}).damage;
}
