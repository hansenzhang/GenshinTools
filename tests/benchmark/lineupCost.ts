/**
 * Cost benchmark for the lineup solver (docs/design/lineup-solver.md, P2–P3).
 *
 * Runs the whole solver on an account, with every team recorded at its
 * equipped build:
 *   - `--mode abyss` (default): one chamber, the Lunar team on the first half
 *     and the Sandrone team on the second, each with one flex slot; prints the
 *     best pairings.
 *   - `--mode stygian`: three bosses for the Lunar, Sandrone and national
 *     teams; Bennett is a flex pick for Sandrone and core for national. Solves
 *     the run with HiGHS and prints the plans and what is hardest to lose.
 * Prints when each stage starts and the candidates found per encounter.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.app.json tests/benchmark/lineupCost.ts \
 *     --account <GOOD.json> [--mode abyss|stygian] [--budget-sec 30]
 *     [--dump <result.json>]
 *
 * Node has no Worker, so the optimizer runs its inline single-thread path;
 * browser runs use one worker per member and are faster.
 */

import { writeFileSync } from "node:fs";
import loadHighs from "highs";
import { planAbyssChambers } from "@/domain/combat/lineup/abyssPairs";
import { calibrateCandidates } from "@/domain/combat/lineup/candidates";
import {
  LINEUP_MARGIN_TIE_PERCENT,
  LINEUP_PAIRINGS_SHOWN,
} from "@/domain/combat/lineup/constants";
import { planStygianRun } from "@/domain/combat/lineup/stygianPlan";
import type { AccountData } from "@/domain/models";
import {
  captureTeamReferenceBuild,
  createAbyssEncounter,
  createTeamTemplate,
} from "@/domain/team/lineup";
import type {
  CalibratedCandidate,
  LineupSolverResult,
  LineupSolverTeam,
} from "@/domain/team/lineupSolverTypes";
import type {
  Calibration,
  Encounter,
  EncounterMode,
} from "@/domain/team/lineupTypes";
import { teamCompInputToComp } from "@/domain/team/teamDeltas";
import { solveMilp } from "@/services/combat/lineup/highsSolver";
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
  national: {
    members: ["xiangling", "xingqiu", "bennett", "kaeya"],
    flex: [[], [], [], []],
  },
};

const MODE_TEAMS: Record<EncounterMode, string[]> = {
  abyss: ["lunar", "sandrone"],
  stygian: ["lunar", "sandrone", "national"],
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

function encountersFor(mode: EncounterMode, count: number): Encounter[] {
  return Array.from({ length: count }, (_, index): Encounter => {
    const timing = { downtimeSeconds: 10, timeBarSeconds: 120 };
    return mode === "abyss"
      ? {
          ...createAbyssEncounter(`12-1-${index + 1}`, 1, index === 0 ? 1 : 2),
          ...timing,
        }
      : {
          id: `boss-${index + 1}`,
          mode: "stygian",
          bossId: index + 1,
          enemyLevel: 105,
          res: {},
          resPhases: [],
          targets: "",
          ...timing,
        };
  });
}

const describe = (candidate: CalibratedCandidate) =>
  `${candidate.id} ×${candidate.margin.toFixed(3)} ${candidate.members
    .map((member) => member.charId)
    .join(",")}`;

async function printPlan(
  mode: EncounterMode,
  calibrated: CalibratedCandidate[],
  result: LineupSolverResult,
  encounters: Encounter[]
): Promise<void> {
  if (mode === "abyss") {
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
    for (const item of plan.binding)
      console.log(
        `  without ${item.kind} ${item.id}: ${item.marginWithout?.toFixed(3) ?? "none"}`
      );
    return;
  }
  const highs = await loadHighs();
  const start = performance.now();
  const plan = planStygianRun(
    {
      encounterIds: encounters.map((encounter) => encounter.id),
      candidates: calibrated,
      weaponCopies: result.weaponCopies,
      tiePercent: LINEUP_MARGIN_TIE_PERCENT,
    },
    (model) => solveMilp(highs, model)
  );
  console.log(
    `\n### Plans (solved in ${(performance.now() - start).toFixed(0)} ms)`
  );
  for (const entry of plan.plans)
    console.log(
      `  ${entry.kind} weakest ×${entry.weakest.toFixed(3)}: ${Object.values(
        entry.candidateIds
      ).join(", ")}`
    );
  for (const item of plan.binding)
    console.log(
      `  without ${item.kind} ${item.id}: ${item.marginWithout?.toFixed(3) ?? "none"}`
    );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.account) throw new Error("Pass --account <GOOD.json>.");
  const mode: EncounterMode = args.mode === "stygian" ? "stygian" : "abyss";
  const [chars, weapons] = await Promise.all([
    characterStatsResource.preload(),
    weaponStatsResource.preload(),
  ]);
  const account = loadAccountData(args.account);
  const teams = MODE_TEAMS[mode].map((name) => solverTeam(name, account));
  const encounters = encountersFor(mode, teams.length);
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
  console.log(`## Lineup solver: ${mode} (budget ${budgetSec} s per team)`);
  const start = performance.now();
  let stage = "";
  let result: LineupSolverResult | null = null;
  await runLineupSolver(
    {
      mode,
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
  const finished = result as LineupSolverResult | null;
  if (!finished) return;
  const calibrated = calibrateCandidates(
    finished.candidates,
    calibrations,
    encounters
  );
  for (const encounter of encounters) {
    console.log(`\n### ${encounter.id}`);
    for (const candidate of calibrated.filter(
      (entry) => entry.encounterId === encounter.id
    ))
      console.log(`  ${describe(candidate)} ${candidate.origin}`);
  }
  for (const issue of finished.issues)
    console.log(
      `issue: ${issue.templateId} ${issue.encounterId} ${issue.reason}`
    );
  await printPlan(mode, calibrated, finished, encounters);
  if (args.dump) writeFileSync(args.dump, JSON.stringify(finished));
}

await main();
