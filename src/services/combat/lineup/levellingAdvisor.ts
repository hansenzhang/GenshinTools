/**
 * Levelling advice for a lineup's team (docs/design/lineup-solver.md, P5). The candidate's scoring input is rebuilt from its run's request as the
 * solver built it: the encounter's enemy, the template's rotation for the
 * candidate's members, and the candidate's weapons and sets.
 */

import { getAllArtifacts } from "@/domain/build/artifact/inventory";
import { candidateArtifactIds } from "@/domain/combat/lineup/candidates";
import { LINEUP_MARGIN_TIE_PERCENT } from "@/domain/combat/lineup/constants";
import { adviseLevelling } from "@/domain/combat/lineup/levelling";
import type { SetScreenInput } from "@/domain/combat/lineup/setConfigScreen";
import type { CharacterStatsMap } from "@/domain/reference/stats";
import {
  findCalibration,
  getCharacterTraits,
  templateCompositions,
} from "@/domain/team/lineup";
import type {
  LevellingAdvice,
  LevellingRequest,
} from "@/domain/team/lineupSolverTypes";
import { fieldScoredComposition, type Task, taskScoring } from "./lineupSolver";
import { prepareTeamSetsJob } from "./setConfigExplorer";

const sameMembers = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((charId) => b.includes(charId));

/**
 * The candidate's scoring input: its composition's share of the rotation
 * under the encounter's enemy, with the candidate's weapons and sets. Null
 * when its team, clear or composition is no longer in the request.
 */
export function candidateScreen(
  request: LevellingRequest,
  chars: CharacterStatsMap
): SetScreenInput | null {
  const { solver, candidate } = request;
  const team = solver.teams.find(
    (entry) => entry.template.id === candidate.templateId
  );
  const encounter = solver.encounters.find(
    (entry) => entry.id === candidate.encounterId
  );
  const calibration = findCalibration(
    solver.calibrations,
    candidate.templateId,
    candidate.encounterId
  );
  if (!team || !encounter || !calibration) return null;
  const task: Task = { team, encounter, calibration };
  const scoring = taskScoring(task, solver.accountData, solver.comboOverrides);
  if (!scoring) return null;
  const charIds = candidate.members.map((member) => member.charId);
  const composition = templateCompositions(
    team.template,
    team.teamComp,
    (charId) => getCharacterTraits(charId, chars)
  ).find((entry) => sameMembers(entry, charIds));
  const scored =
    composition &&
    fieldScoredComposition(task, scoring, composition, solver.accountData);
  if (!scored) return null;
  const setup = prepareTeamSetsJob(
    {
      teamComp: scored.fielded,
      setupConfig: team.setupConfig,
      accountData: solver.accountData,
      objective: scored.combo,
      userBuffOverrides: scoring.userBuffOverrides,
      carryCharId: scored.combo.lines[0].charId,
      optimizeContext: scoring.contexts.optimize,
      displayContext: scoring.contexts.display,
      // Only the scoring input is used; pieces come from the candidate.
      settings: {
        useAccountArtifacts: false,
        lockedCharIds: [],
        pinned: {},
        timeBudgetSec: 0,
      },
    },
    chars
  );
  if (setup.kind !== "ready") return null;
  const { screen } = setup.job;
  return {
    ...screen,
    configs: screen.configs.map((config) => {
      const member = candidate.members.find(
        (entry) => entry.charId === config.charId
      );
      return member
        ? {
            ...config,
            weaponId: member.weaponId,
            refinement: member.refinement,
            artifactSet: member.artifactSet,
          }
        : config;
    }),
  };
}

/**
 * What to level for the candidate's team, with the lineup's other teams
 * keeping their pieces. A piece beats the current one when it raises the
 * team's damage by more than the margin tie. Null when the team cannot be
 * scored.
 */
export function adviseCandidateLevelling(
  request: LevellingRequest,
  chars: CharacterStatsMap
): LevellingAdvice | null {
  const screen = candidateScreen(request, chars);
  if (!screen) return null;
  const artifacts = [
    ...new Map(
      getAllArtifacts(request.solver.accountData).map((artifact) => [
        artifact.id,
        artifact,
      ])
    ).values(),
  ];
  const advice = adviseLevelling({
    screen,
    members: request.candidate.members,
    artifacts,
    reservedIds: new Set(request.others.flatMap(candidateArtifactIds)),
    bar: LINEUP_MARGIN_TIE_PERCENT / 100,
    accountLevels: Object.fromEntries(
      request.solver.accountData.characters.map((character) => [
        character.key,
        character.level,
      ])
    ),
  });
  return advice && { candidateId: request.candidate.id, ...advice };
}
