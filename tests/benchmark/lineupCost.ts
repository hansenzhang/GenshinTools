/**
 * Cost benchmark for the lineup solver (docs/design/lineup-solver.md, P2).
 *
 * Runs the whole solver on an account for one Abyss chamber: the Lunar team
 * on the first half and the Sandrone team on the second, each with one flex
 * slot, recorded at their equipped builds. Prints when each stage starts,
 * the candidates found per half and the best pairings.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.app.json tests/benchmark/lineupCost.ts \
 *     --account <GOOD.json> [--budget-sec 30] [--dump <result.json>]
 *
 * Node has no Worker, so the optimizer runs its inline single-thread path;
 * browser runs use one worker per member and are faster.
 */

import { planAbyssChambers } from "@/domain/combat/lineup/abyssPairs";
import { calibrateCandidates } from "@/domain/combat/lineup/candidates";
import {
  LINEUP_MARGIN_TIE_PERCENT,
  LINEUP_PAIRINGS_SHOWN,
} from "@/domain/combat/lineup/constants";
import type { AccountData } from "@/domain/models";
import {
  captureTeamReferenceBuild,
  createAbyssEncounter,
  createTeamTemplate,
} from "@/domain/team/lineup";
import type {
  LineupSolverResult,
  LineupSolverTeam,
} from "@/domain/team/lineupSolverTypes";
import type { Calibration, Encounter } from "@/domain/team/lineupTypes";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";
import { runLineupSolver } from "@/services/combat/lineup/lineupSolver";
import {
  characterStatsResource,
  loadAccountData,
  weaponStatsResource,
} from "./runner";

/** Members and flex alternatives per slot, with equipped weapons. */
const TEAMS: Record<string, { members: string[]; flex: string[][] }> = {
  lunar: {
    members: ["columbina", "ineffa", "linnea", "sucrose"],
    flex: [[], [], ["aino"], []],
  },
  sandrone: {
    members: ["sandrone", "yae_miko", "odette", "alyosha"],
    flex: [[], [], [], ["bennett"]],
  },
};

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) args[key.slice(2)] = argv[i + 1] ?? "";
  }
  return args;
}

function solverTeam(name: string, account: AccountData): LineupSolverTeam {
  const { members, flex } = TEAMS[name];
  const teamComp = teamCompInputToComp({
    id: name,
    characters: members,
    weapons: members.map((charId) => {
      const owned = account.characters.find((char) => char.key === charId);
      if (!owned?.weapon)
        throw new Error(`Account lacks ${charId} or a weapon`);
      return owned.weapon.key;
    }),
  });
  return {
    template: {
      ...createTeamTemplate(`template-${name}`, teamComp),
      flexBySlot: flex,
    },
    teamComp,
    setupConfig: { combatOptions: {}, damage: { formulaMode: "combo" } },
  };
}

function printResult(
  result: LineupSolverResult,
  encounters: Encounter[],
  calibrations: Calibration[]
): void {
  const calibrated = calibrateCandidates(
    result.candidates,
    calibrations,
    encounters
  );
  for (const encounter of encounters) {
    console.log(`\n### ${encounter.id}`);
    for (const candidate of calibrated.filter(
      (entry) => entry.encounterId === encounter.id
    ))
      console.log(
        `  ${candidate.id} ×${candidate.margin.toFixed(3)} r=${candidate.ratio.toFixed(3)} ${candidate.origin} ${candidate.members
          .map((member) => member.charId)
          .join(",")}`
      );
  }
  for (const issue of result.issues)
    console.log(
      `issue: ${issue.templateId} ${issue.encounterId} ${issue.reason}`
    );
  const [plan] = planAbyssChambers(
    encounters,
    calibrated,
    result.weaponCopies,
    "per-half",
    LINEUP_MARGIN_TIE_PERCENT,
    LINEUP_PAIRINGS_SHOWN
  );
  console.log("\n### Pairings");
  console.log(
    `  alone: first ×${plan.bestAlone.first?.toFixed(3)} second ×${plan.bestAlone.second?.toFixed(3)}`
  );
  for (const pairing of plan.pairings)
    console.log(
      `  ${pairing.firstId} + ${pairing.secondId}: ×${pairing.margin.toFixed(3)}`
    );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.account) throw new Error("Pass --account <GOOD.json>.");
  const [chars, weapons] = await Promise.all([
    characterStatsResource.preload(),
    weaponStatsResource.preload(),
  ]);
  const account = loadAccountData(args.account);
  const teams = [solverTeam("lunar", account), solverTeam("sandrone", account)];
  const encounters: Encounter[] = ([1, 2] as const).map((half) => ({
    ...createAbyssEncounter(`12-1-${half}`, 1, half),
    downtimeSeconds: 10,
    timeBarSeconds: 120,
  }));
  const calibrations: Calibration[] = teams.map((team, index) => ({
    id: `calibration-${index}`,
    templateId: team.template.id,
    encounterId: encounters[index].id,
    reference: captureTeamReferenceBuild(
      team.teamComp,
      team.setupConfig,
      account,
      0
    )!,
    measuredSeconds: 100,
    downtimeSeconds: null,
  }));
  const budgetSec = Number(args["budget-sec"] ?? 30);
  console.log(`## Lineup solver (budget ${budgetSec} s per team)`);
  const start = performance.now();
  let stage = "";
  let result: LineupSolverResult | null = null;
  await runLineupSolver(
    {
      accountData: account,
      encounters,
      teams,
      calibrations,
      comboOverrides: {},
      timeBudgetSec: budgetSec,
    },
    chars,
    weapons,
    (message) => {
      if (message.type === "progress") {
        const key = `${message.task}:${message.stage}`;
        if (key !== stage) {
          stage = key;
          console.log(
            `  ${((performance.now() - start) / 1000).toFixed(1)} s: task ${message.task + 1}/${message.tasks} ${message.stage}`
          );
        }
      }
      if (message.type === "result") result = message.result;
      if (message.type === "error")
        console.log(`error: ${message.reason} ${message.details ?? ""}`);
    }
  );
  console.log(`total ${((performance.now() - start) / 1000).toFixed(1)} s`);
  if (result) printResult(result, encounters, calibrations);
  if (result && args.dump)
    (await import("node:fs")).writeFileSync(args.dump, JSON.stringify(result));
}

await main();
