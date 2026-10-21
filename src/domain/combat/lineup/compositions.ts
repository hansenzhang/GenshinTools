/**
 * Fielding a team template's compositions from the account
 * (docs/design/lineup-solver.md, P2).
 */

import type { AccountData } from "@/domain/models";
import { templateSlotCandidates } from "@/domain/team/lineup";
import type {
  TeamTemplate,
  TemplateComposition,
} from "@/domain/team/lineupTypes";
import {
  detectEquippedSets,
  getEffectiveCombo,
} from "@/domain/team/teamConfigUtils";
import type { TeamComp, TeamDamageConfig } from "@/domain/team/types";
import { collectOwnedWeaponCopies } from "@/domain/team/weaponCopies";
import { joiningMemberLines, resolveActiveCombo } from "../damage/core/combo";
import type { TeamBuild } from "../damage/core/teamBuild";
import type { ComboFormula } from "../damage/types";

/** Owned copies per weapon key. */
export function countWeaponCopies(
  accountData: AccountData | null
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const copy of collectOwnedWeaponCopies(accountData))
    counts[copy.key] = (counts[copy.key] ?? 0) + 1;
  return counts;
}

/**
 * The team with a composition's members. A team character keeps its slot's
 * weapon and set goal; an alternative brings its equipped weapon and the sets
 * its pieces form. A member whose weapon has no copy left takes its equipped
 * weapon. Null when a member is not owned or has no weapon copy left.
 */
export function fieldComposition(
  template: TeamTemplate,
  team: TeamComp,
  composition: TemplateComposition,
  accountData: AccountData
): TeamComp | null {
  const slots = templateSlotCandidates(template, team).map(({ slot }) => slot);
  if (slots.length !== composition.length) return null;
  const copies = countWeaponCopies(accountData);
  const used: Record<string, number> = {};
  const take = (weaponId: string | null | undefined): weaponId is string => {
    if (!weaponId || (used[weaponId] ?? 0) >= (copies[weaponId] ?? 0))
      return false;
    used[weaponId] = (used[weaponId] ?? 0) + 1;
    return true;
  };
  const nextSlots = team.slots.map((slot) => ({ ...slot }));
  for (const [index, charId] of composition.entries()) {
    const slot = slots[index];
    const owned = accountData.characters.find((char) => char.key === charId);
    if (!owned) return null;
    const own = team.slots[slot];
    const isTeamMember = own?.charId === charId;
    const weaponId = [
      isTeamMember ? own.weaponId : null,
      owned.weapon?.key,
    ].find(take);
    if (!weaponId) return null;
    while (nextSlots.length <= slot)
      nextSlots.push({ charId: null, weaponId: null, artifactSet: null });
    nextSlots[slot] = {
      charId,
      weaponId,
      artifactSet: isTeamMember
        ? own.artifactSet
        : detectEquippedSets(Object.values(owned.artifacts)),
    };
  }
  return { ...team, slots: nextSlots };
}

/**
 * The rotation a team is scored on: its saved rotation, or the default one
 * the Analysis workspace builds. Never a single formula, even when the team
 * has one selected: a margin compares whole-team clear times, so every
 * member's damage counts.
 */
export function resolveTeamObjective(
  damage: TeamDamageConfig | undefined,
  team: TeamBuild
): ComboFormula {
  const charIds = team.configs.map((config) => config.charId);
  return getEffectiveCombo({
    formulaMode: "combo",
    combo:
      damage?.combo ?? resolveActiveCombo([], undefined, team, charIds, true),
  });
}

/**
 * The team's objective for other members: lines of members who stay, plus
 * default lines for members who join. Null when no line is left.
 */
export function compositionObjective(
  objective: ComboFormula,
  team: TeamBuild,
  originalCharIds: readonly string[]
): ComboFormula | null {
  const members = new Set(team.configs.map((config) => config.charId));
  const original = new Set(originalCharIds);
  const kept = objective.lines.filter(
    (line) =>
      line.count > 0 &&
      members.has(line.charId) &&
      team.catalog.formulaIndex.has(line.formulaId)
  );
  const removedLines = objective.lines.filter(
    (line) => !members.has(line.charId)
  );
  const joined = team.configs
    .filter((config) => !original.has(config.charId))
    .flatMap((config) => joiningMemberLines(team, config.charId, removedLines));
  const lines = [...kept, ...joined];
  return lines.length > 0
    ? { ...objective, lines, buffOverrides: undefined }
    : null;
}
