import type { CalcContext, TeamSlotConfig } from "@/domain/combat/damage/types";
import {
  ELEMENT_KEYS,
  type Element,
  type ElementalOrPhysical,
  type Faction,
  type Slot,
} from "@/domain/enums";
import type { ArtifactData, BossInfo } from "@/domain/models";
import { charactersById } from "@/domain/reference/catalog";
import {
  type CharacterStatsMap,
  getCharacterDisplayMeta,
} from "@/domain/reference/stats";
import { charInfo } from "@/generated/catalog/characterInfo";
import { DEFAULT_ENCOUNTER_RES, STYGIAN_FEARLESS_TIER } from "./constants";
import type {
  AbyssEncounter,
  Calibration,
  CalibrationTimes,
  CompositionRule,
  Encounter,
  ReferenceBuild,
  StygianEncounter,
  TeamTemplate,
  TemplateComposition,
} from "./lineupTypes";
import { teamCompToArrays } from "./teamDeltas";
import type { TeamComp } from "./types";

// ─── Encounters ───

export function createAbyssEncounter(
  id: string,
  chamber: number,
  half: 1 | 2
): AbyssEncounter {
  return {
    id,
    mode: "abyss",
    name: "",
    chamber,
    half,
    enemyLevel: 100,
    res: {},
    targets: "",
    downtimeSeconds: 0,
    timeBarSeconds: null,
  };
}

/** A Stygian encounter at Fearless with the boss's level and base RES. */
export function createStygianEncounter(
  id: string,
  bossId: number,
  boss: BossInfo
): StygianEncounter {
  const tier = boss.tiers[String(STYGIAN_FEARLESS_TIER)];
  if (!tier) throw new Error(`Stygian boss ${bossId} has no Fearless tier.`);
  const res: Partial<Record<ElementalOrPhysical, number>> = {};
  for (const element of ELEMENT_KEYS) {
    const percent = boss.res?.[element];
    if (percent != null) res[element] = percent / 100;
  }
  return {
    id,
    mode: "stygian",
    name: "",
    bossId,
    enemyLevel: tier.level,
    res,
    targets: "",
    downtimeSeconds: 0,
    timeBarSeconds: null,
  };
}

export function encounterRes(
  encounter: Encounter,
  element: ElementalOrPhysical
): number {
  return encounter.res[element] ?? DEFAULT_ENCOUNTER_RES;
}

/** A team's calculation context against this encounter's enemy. */
export function encounterCalcContext(
  encounter: Encounter,
  base: CalcContext
): CalcContext {
  return {
    ...base,
    enemyLevel: encounter.enemyLevel,
    enemyRes: DEFAULT_ENCOUNTER_RES,
    enemyResByElement: Object.fromEntries(
      ELEMENT_KEYS.map((element) => [element, encounterRes(encounter, element)])
    ),
  };
}

// ─── Team templates ───

export function createTeamTemplate(id: string, team: TeamComp): TeamTemplate {
  return {
    id,
    name: team.name,
    teamId: team.id,
    flexBySlot: [[], [], [], []],
    rules: [],
  };
}

export type CharacterTraits = { element?: Element; faction?: Faction };

export function getCharacterTraits(
  charId: string,
  stats: CharacterStatsMap | undefined
): CharacterTraits {
  const resource = charactersById[charId];
  return {
    element: resource
      ? getCharacterDisplayMeta(resource, stats?.[charId]).element
      : undefined,
    faction: charInfo[charId]?.faction,
  };
}

export function compositionMeetsRules(
  composition: TemplateComposition,
  rules: CompositionRule[],
  traits: (charId: string) => CharacterTraits
): boolean {
  return rules.every((rule) => {
    const count = composition.filter((charId) => {
      const trait = traits(charId);
      return rule.kind === "element"
        ? trait.element === rule.element
        : trait.faction === "Moonsign";
    }).length;
    return count >= rule.min;
  });
}

/** Candidates for each filled slot: the team's character, then its alternatives. */
export function templateSlotCandidates(
  template: TeamTemplate,
  team: TeamComp
): string[][] {
  const { characters } = teamCompToArrays(team);
  return characters
    .map((charId, slot) => [
      ...new Set([
        ...(charId ? [charId] : []),
        ...(template.flexBySlot[slot] ?? []),
      ]),
    ])
    .filter((candidates) => candidates.length > 0);
}

/** Every composition the template allows: one candidate per slot, no
 *  character twice, and every rule met. */
export function templateCompositions(
  template: TeamTemplate,
  team: TeamComp,
  traits: (charId: string) => CharacterTraits
): TemplateComposition[] {
  let partial: TemplateComposition[] = [[]];
  for (const candidates of templateSlotCandidates(template, team)) {
    partial = partial.flatMap((composition) =>
      candidates
        .filter((charId) => !composition.includes(charId))
        .map((charId) => [...composition, charId])
    );
  }
  return partial.filter((composition) =>
    compositionMeetsRules(composition, template.rules, traits)
  );
}

// ─── Calibration ───

/** The build a clear was played with, copied so later account changes do
 *  not alter it. */
export function captureReferenceBuild(
  slots: TeamSlotConfig[],
  equippedByChar: Record<string, Partial<Record<Slot, ArtifactData | null>>>,
  capturedAt: number
): ReferenceBuild {
  return {
    capturedAt,
    slots: structuredClone(slots),
    artifactsByChar: Object.fromEntries(
      slots.map(({ charId }) => [
        charId,
        structuredClone(
          Object.values(equippedByChar[charId] ?? {}).filter(
            (artifact): artifact is ArtifactData => artifact != null
          )
        ),
      ])
    ),
  };
}

export function findCalibration(
  calibrations: Calibration[],
  templateId: string,
  encounterId: string
): Calibration | undefined {
  return calibrations.find(
    (calibration) =>
      calibration.templateId === templateId &&
      calibration.encounterId === encounterId
  );
}

export type MarginReadout =
  | { kind: "margin"; margin: number }
  | { kind: "no-bar" }
  | { kind: "downtime-too-long" };

export function calibrationTimes(
  calibration: Calibration,
  encounter: Encounter
): CalibrationTimes | null {
  if (encounter.timeBarSeconds == null) return null;
  return {
    measured: calibration.measuredSeconds,
    downtime: calibration.downtimeSeconds ?? encounter.downtimeSeconds,
    bar: encounter.timeBarSeconds,
  };
}

/**
 * Calibrated margin of a build whose model DPS is `ratio` times the
 * reference build's: ratio · (T_req − D) / (T_meas − D). Above 1 clears the
 * bar with room to spare. The reference build itself has ratio 1.
 */
export function calibratedMargin(
  ratio: number,
  calibration: Calibration,
  encounter: Encounter
): MarginReadout {
  const times = calibrationTimes(calibration, encounter);
  if (!times) return { kind: "no-bar" };
  const { measured, downtime, bar } = times;
  if (measured <= downtime || bar <= downtime)
    return { kind: "downtime-too-long" };
  return {
    kind: "margin",
    margin: (ratio * (bar - downtime)) / (measured - downtime),
  };
}
