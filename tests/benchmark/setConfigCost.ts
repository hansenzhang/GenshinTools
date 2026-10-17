/**
 * Cost benchmark for the team set explorer (docs/design/lineup-solver.md, P1).
 *
 * Measures the building blocks the explorer screens with, so its screening
 * widths can be tuned from numbers instead of guesses:
 *   - TeamBuild construction while one member's set changes;
 *   - one combo evaluation on fixed sheets;
 *   - one full-team generator run.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.app.json tests/benchmark/setConfigCost.ts \
 *     [--team lunar|sandrone|all] [--reps 40] [--generator-reps 5]
 *     [--pipeline] [--account <GOOD.json> --budget-ms 6000 --account-reps 2]
 *
 * `--pipeline` runs the explorer's screening stages (A–C) end to end and
 * prints each member's best choices on generated artifacts.
 *
 * `--account` also times one real-inventory finalist (sets enforced) per
 * team. Node has no Worker, so the optimizer runs its inline single-thread
 * path; browser runs use one worker per member and are faster.
 */

import { buildArtifactSetChoiceCandidates } from "@/domain/combat/analyzer/weaponChoice";
import type { StatSheet } from "@/domain/combat/damage/core/statSheet";
import { TeamBuild } from "@/domain/combat/damage/core/teamBuild";
import type {
  CalcContext,
  ComboFormula,
  ComboLine,
  TeamSlotConfig,
} from "@/domain/combat/damage/types";
import { runGenerator } from "@/domain/combat/generator/generator";
import { buildChoiceRows } from "@/domain/combat/lineup/setAssignments";
import { setChoiceKey } from "@/domain/combat/lineup/setChoices";
import { runSetConfigScreen } from "@/domain/combat/lineup/setConfigScreen";
import type { Element } from "@/domain/enums";
import type { AccountData, ArtifactSetConfig } from "@/domain/models";
import { getCharacterLevelTier } from "@/domain/reference/stats";
import type { CharOptConfig } from "@/domain/team/types";
import { runTeamOptimization } from "@/services/combat/optimizer/teamOptimization";
import {
  characterStatsResource,
  getAllArtifacts,
  loadAccountData,
  weaponStatsResource,
} from "./runner";

const CTX: CalcContext = {
  enemyLevel: 100,
  enemyRes: 0.1,
  rollMultiplier: 0.85,
  substatBudget: "8_6",
};

interface BenchTeam {
  name: string;
  members: [string, string, ArtifactSetConfig][];
}

const fourPiece = (setId: string): ArtifactSetConfig => ({
  type: "4pc",
  setId,
});

const TEAMS: Record<string, BenchTeam> = {
  lunar: {
    name: "Flins · Columbina · Ineffa · Sucrose",
    members: [
      ["flins", "bloodsoaked_ruins", fourPiece("night_of_the_skys_unveiling")],
      [
        "columbina",
        "nocturnes_curtain_call",
        fourPiece("silken_moons_serenade"),
      ],
      ["ineffa", "fractured_halo", fourPiece("aubade_of_morningstar_and_moon")],
      [
        "sucrose",
        "thrilling_tales_of_dragon_slayers",
        fourPiece("viridescent_venerer"),
      ],
    ],
  },
  sandrone: {
    name: "Sandrone · Yae Miko · Odette · Alyosha",
    members: [
      [
        "sandrone",
        "a_teaspoon_of_transcendence",
        fourPiece("disenchantment_in_deep_shadow"),
      ],
      [
        "yae_miko",
        "kaguras_verity",
        fourPiece("disenchantment_in_deep_shadow"),
      ],
      ["odette", "whitelake_frostfeather", fourPiece("heart_of_the_furnace")],
      ["alyosha", "favonius_lance", fourPiece("tenacity_of_the_millelith")],
    ],
  },
};

/** Teams built from owned characters and their equipped weapons. */
const ACCOUNT_TEAMS: Record<string, [string, ArtifactSetConfig][]> = {
  lunar: [
    ["columbina", fourPiece("silken_moons_serenade")],
    ["ineffa", fourPiece("aubade_of_morningstar_and_moon")],
    ["linnea", fourPiece("aubade_of_morningstar_and_moon")],
    ["sucrose", fourPiece("viridescent_venerer")],
  ],
  sandrone: [
    ["sandrone", fourPiece("disenchantment_in_deep_shadow")],
    ["yae_miko", { type: "2pc+2pc", halfSetIds: ["atk%-18", "em-80"] }],
    ["odette", fourPiece("heart_of_the_furnace")],
    ["alyosha", fourPiece("tenacity_of_the_millelith")],
  ],
};

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) args[key.slice(2)] = argv[i + 1] ?? "";
  }
  return args;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length)
  );
  return sorted[index] ?? Number.NaN;
}

function describeTimes(label: string, values: number[]): string {
  return `${label.padEnd(34)} n=${String(values.length).padStart(4)}  median ${percentile(values, 50).toFixed(2)} ms  p90 ${percentile(values, 90).toFixed(2)} ms`;
}

function buildConfigs(team: BenchTeam): TeamSlotConfig[] {
  return team.members.map(([charId, weaponId, artifactSet]) => ({
    charId,
    charLevel: 90,
    constellation: 0,
    weaponId,
    refinement: 1,
    artifactSet,
    talentLevels: { auto: 10, skill: 10, burst: 10 },
  }));
}

function buildDefaultCombo(teamBuild: TeamBuild): ComboFormula {
  const lines: ComboLine[] = [];
  for (const config of teamBuild.configs) {
    for (const [formulaId, count] of Object.entries(
      teamBuild.catalog.getCombo(config.charId)
    )) {
      if (count > 0) lines.push({ charId: config.charId, formulaId, count });
    }
  }
  return {
    id: "__bench__",
    label: { en: "Bench", zh: "Bench" },
    lines,
  };
}

async function generate(
  teamBuild: TeamBuild,
  combo: ComboFormula
): Promise<Record<string, StatSheet>> {
  let sheets: Record<string, StatSheet> = {};
  for await (const update of runGenerator({
    teamBuild,
    carryCharId: combo.lines[0].charId,
    combo,
    calcContext: CTX,
  })) {
    if (update.done) sheets = update.sheetsByChar;
  }
  return sheets;
}

async function benchTeam(
  team: BenchTeam,
  reps: number,
  generatorReps: number
): Promise<void> {
  console.log(`\n## ${team.name}`);
  const configs = buildConfigs(team);
  const baseTeam = new TeamBuild(configs, {}, undefined, [], undefined, CTX);
  const combo = buildDefaultCombo(baseTeam);
  console.log(`combo lines: ${combo.lines.length}`);

  const sheets = await generate(baseTeam, combo);
  const baseDamage = baseTeam.getComboDamageResult(
    combo,
    sheets,
    CTX
  ).totalDamage;
  console.log(`baseline damage: ${Math.round(baseDamage).toLocaleString()}`);

  const candidates = buildArtifactSetChoiceCandidates();
  const construct: number[] = [];
  const evaluate: number[] = [];
  let skipped = 0;
  for (let rep = 0; rep < reps; rep++) {
    const candidate = candidates[rep % candidates.length];
    const memberIndex = rep % configs.length;
    const variant = configs.map((config, index) =>
      index === memberIndex
        ? { ...config, artifactSet: candidate.artifactSet }
        : config
    );
    const startBuild = performance.now();
    let teamBuild: TeamBuild;
    try {
      teamBuild = new TeamBuild(variant, {}, undefined, [], undefined, CTX);
    } catch {
      skipped++;
      continue;
    }
    construct.push(performance.now() - startBuild);
    const startEval = performance.now();
    teamBuild.getComboDamageResult(combo, sheets, CTX);
    evaluate.push(performance.now() - startEval);
  }

  const cachedConstruct: number[] = [];
  for (let rep = 0; rep < reps; rep++) {
    const start = performance.now();
    new TeamBuild(configs, {}, undefined, [], baseTeam.charBuilds, CTX);
    cachedConstruct.push(performance.now() - start);
  }

  const generatorTimes: number[] = [];
  for (let rep = 0; rep < generatorReps; rep++) {
    const start = performance.now();
    await generate(baseTeam, combo);
    generatorTimes.push(performance.now() - start);
  }

  console.log(describeTimes("TeamBuild (set varies)", construct));
  console.log(describeTimes("TeamBuild (cached CharBuilds)", cachedConstruct));
  console.log(describeTimes("getComboDamageResult", evaluate));
  console.log(describeTimes("runGenerator (4 members)", generatorTimes));
  if (skipped > 0) console.log(`unsupported set variants skipped: ${skipped}`);
  const perEval = percentile(construct, 50) + percentile(evaluate, 50);
  console.log(
    `fixed-sheet evaluation ≈ ${perEval.toFixed(2)} ms → 1296 joint assignments ≈ ${((perEval * 1296) / 1000).toFixed(1)} s`
  );
}

async function benchPipeline(team: BenchTeam): Promise<void> {
  console.log(`\n## Pipeline: ${team.name}`);
  const chars = await characterStatsResource.preload();
  const configs = buildConfigs(team);
  const baseTeam = new TeamBuild(configs, {}, undefined, [], undefined, CTX);
  const combo = buildDefaultCombo(baseTeam);
  const stageStart: Record<string, number> = {};
  const stageEnd: Record<string, number> = {};
  const start = performance.now();
  const output = await runSetConfigScreen(
    {
      configs,
      combo,
      combatOptions: {},
      optimizeContext: CTX,
      displayContext: CTX,
      carryCharId: combo.lines[0].charId,
      requirements: Object.fromEntries(
        configs.map((config) => [config.charId, { minEr: 1, minCr: 0 }])
      ),
      elements: Object.fromEntries(
        configs.map((config) => [
          config.charId,
          chars[config.charId].element as Element,
        ])
      ),
      lockedCharIds: new Set(),
      pinned: {},
    },
    (stage) => {
      stageStart[stage] ??= performance.now();
      stageEnd[stage] = performance.now();
    }
  );
  const total = performance.now() - start;
  if (!output) {
    console.log("screen failed");
    return;
  }
  const stages = Object.keys(stageStart)
    .map(
      (stage) =>
        `${stage} ${(stageEnd[stage] - stageStart[stage]).toFixed(0)} ms`
    )
    .join(", ");
  console.log(
    `total ${total.toFixed(0)} ms (${stages}); evaluated ${output.evaluated}, skipped ${output.skipped}, assignments ${output.outcomes.length}`
  );
  const generated = output.outcomes.filter(
    (outcome) => outcome.generatedDamage != null
  );
  const best = Math.max(...generated.map((o) => o.generatedDamage ?? 0));
  const current = output.outcomes[output.currentIndex].generatedDamage ?? 0;
  console.log(
    `generated: ${generated.length} assignments, best vs current ${(((best - current) / current) * 100).toFixed(2)}%`
  );
  const rows = buildChoiceRows(output.outcomes, output.charIds, {});
  for (const charId of output.charIds) {
    const line = rows[charId]
      .filter((row) => row.basis === "generated")
      .slice(0, 8)
      .map((row) => {
        const outcome = output.outcomes[row.outcomeIndex];
        const others = output.charIds
          .filter((id) => id !== charId)
          .map((id) => `${id}=${setChoiceKey(outcome.assignment[id] ?? null)}`)
          .join(" ");
        return `${row.key} ${(((outcome.generatedDamage ?? 0) / best) * 100).toFixed(1)}% [${others}]`;
      });
    console.log(`  ${charId}:\n    ${line.join("\n    ")}`);
  }
}

function buildAccountConfigs(
  account: AccountData,
  members: [string, ArtifactSetConfig][]
): TeamSlotConfig[] {
  return members.map(([charId, artifactSet]) => {
    const owned = account.characters.find((char) => char.key === charId);
    if (!owned?.weapon) throw new Error(`Account lacks ${charId} or a weapon`);
    return {
      charId,
      charLevel: Number(getCharacterLevelTier(owned.level)),
      constellation: owned.constellation,
      weaponId: owned.weapon.key,
      refinement: owned.weapon.refinement,
      artifactSet,
      talentLevels: owned.talent,
    };
  });
}

async function benchAccountFinalist(
  name: string,
  account: AccountData,
  members: [string, ArtifactSetConfig][],
  budgetMs: number,
  reps: number
): Promise<void> {
  console.log(`\n## Account finalist: ${name} (budget ${budgetMs} ms)`);
  const configs = buildAccountConfigs(account, members);
  const teamBuild = new TeamBuild(configs, {}, undefined, [], undefined, CTX);
  const combo = buildDefaultCombo(teamBuild);
  const perChar: Record<string, CharOptConfig> = Object.fromEntries(
    configs.map((config) => [
      config.charId,
      { minEr: 1, minCr: 0, artifactSet: config.artifactSet },
    ])
  );
  const inventory = getAllArtifacts(account);
  for (let rep = 0; rep < reps; rep++) {
    const start = performance.now();
    let damage = 0;
    let failures = "";
    for await (const update of runTeamOptimization({
      teamBuild,
      carryCharId: combo.lines[0].charId,
      combo,
      inventory,
      calcContext: CTX,
      baseSheets: {},
      perChar,
      teamDeadlineMs: performance.now() + budgetMs,
    })) {
      if (!update.done) continue;
      damage = update.bestDamage;
      failures = Object.entries(update.failReasons)
        .map(([charId, reason]) => `${charId}:${reason.kind}`)
        .join(", ");
    }
    console.log(
      `run ${rep + 1}: ${(performance.now() - start).toFixed(0)} ms, damage ${Math.round(damage).toLocaleString()}${failures ? `, failed ${failures}` : ""}`
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reps = Number(args.reps ?? 40);
  const generatorReps = Number(args["generator-reps"] ?? 5);
  const teamArg = args.team ?? "all";
  await Promise.all([
    characterStatsResource.preload(),
    weaponStatsResource.preload(),
  ]);
  const teams =
    teamArg === "all"
      ? Object.values(TEAMS)
      : [TEAMS[teamArg]].filter((team): team is BenchTeam => !!team);
  if (teams.length === 0) throw new Error(`Unknown team: ${teamArg}`);
  for (const team of teams) {
    if (args.pipeline !== undefined) await benchPipeline(team);
    else await benchTeam(team, reps, generatorReps);
  }

  if (!args.account) return;
  const account = loadAccountData(args.account);
  const budgetMs = Number(args["budget-ms"] ?? 6000);
  const accountReps = Number(args["account-reps"] ?? 2);
  const accountTeams =
    teamArg === "all" ? Object.keys(ACCOUNT_TEAMS) : [teamArg];
  for (const key of accountTeams) {
    const members = ACCOUNT_TEAMS[key];
    if (members)
      await benchAccountFinalist(key, account, members, budgetMs, accountReps);
  }
}

await main();
