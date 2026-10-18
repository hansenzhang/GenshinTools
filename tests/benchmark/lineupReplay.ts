/**
 * Replays a lineup run from its debug export (Lineups › Export debug file).
 *
 * Prints the exported run first: each encounter's chosen team with weapons,
 * sets, every piece and the members' final stats, then how the job got there
 * (compositions, screened sets and real-inventory runs). Unless `--no-run` is
 * given, it then runs the solver again on the exported inputs in Node and
 * prints the same view, so changes to the solver can be checked against the
 * user's own teams and account.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.app.json tests/benchmark/lineupReplay.ts \
 *     --file <lineup-debug.json> [--no-run] [--budget-sec 30] [--trace]
 *     [--dump <replayed.json>]
 *
 * Node has no Worker, so the optimizer runs its inline single-thread path.
 */

import { readFileSync, writeFileSync } from "node:fs";
import loadHighs from "highs";
import { planAbyssChambers } from "@/domain/combat/lineup/abyssPairs";
import { calibrateCandidates } from "@/domain/combat/lineup/candidates";
import {
  LINEUP_DEBUG_FORMAT,
  LINEUP_DEBUG_VERSION,
  LINEUP_MARGIN_TIE_PERCENT,
  LINEUP_PAIRINGS_SHOWN,
} from "@/domain/combat/lineup/constants";
import { buildLineupDebugExport } from "@/domain/combat/lineup/debugExport";
import { setChoiceKey } from "@/domain/combat/lineup/setChoices";
import { planStygianRun } from "@/domain/combat/lineup/stygianPlan";
import { allSlots } from "@/domain/enums";
import type { ArtifactSetConfig } from "@/domain/models";
import type {
  CalibratedCandidate,
  LineupDebugExport,
  LineupDebugPlan,
  LineupSolverRequest,
  LineupSolverResult,
} from "@/domain/team/lineupSolverTypes";
import type { Encounter } from "@/domain/team/lineupTypes";
import type { SetAssignment } from "@/domain/team/setConfigExplorerTypes";
import { solveMilp } from "@/services/combat/lineup/highsSolver";
import { runLineupSolver } from "@/services/combat/lineup/lineupSolver";
import { characterStatsResource, weaponStatsResource } from "./runner";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    args[key.slice(2)] = value && !value.startsWith("--") ? value : "true";
  }
  return args;
}

function readExport(path: string): LineupDebugExport {
  const data = JSON.parse(readFileSync(path, "utf8")) as LineupDebugExport;
  if (data.format !== LINEUP_DEBUG_FORMAT)
    throw new Error(`${path} is not a lineup debug export.`);
  if (data.version !== LINEUP_DEBUG_VERSION)
    throw new Error(
      `${path} is version ${data.version}; this script reads ${LINEUP_DEBUG_VERSION}.`
    );
  return data;
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const setLabel = (choice: ArtifactSetConfig | null) => setChoiceKey(choice);
const assignmentLabel = (assignment: SetAssignment, charIds: string[]) =>
  charIds
    .map((charId) => `${charId}=${setLabel(assignment[charId] ?? null)}`)
    .join(" ");

function encounterLabel(encounter: Encounter): string {
  return encounter.mode === "abyss"
    ? `${encounter.id} (Abyss ${encounter.chamber}-${encounter.half})`
    : `${encounter.id} (Stygian boss ${encounter.bossId}, Lv ${encounter.enemyLevel})`;
}

function templateLabel(request: LineupSolverRequest, templateId: string) {
  const team = request.teams.find((entry) => entry.template.id === templateId);
  return team?.teamComp.name || templateId;
}

function printCandidate(
  candidate: CalibratedCandidate,
  result: LineupSolverResult,
  request: LineupSolverRequest
): void {
  console.log(
    `  ${templateLabel(request, candidate.templateId)} · ${candidate.id} ×${candidate.margin.toFixed(3)} r=${candidate.ratio.toFixed(3)} ${candidate.origin}`
  );
  const stats = result.trace.memberStats[candidate.id] ?? {};
  for (const member of candidate.members) {
    const sheet = stats[member.charId] ?? {};
    const statLine = Object.entries(sheet)
      .map(([key, value]) =>
        ["hp", "atk", "def", "em"].includes(key)
          ? `${key} ${value.toFixed(0)}`
          : `${key} ${percent(value)}`
      )
      .join(" · ");
    console.log(
      `    ${member.charId} — ${member.weaponId} R${member.refinement} — ${setLabel(member.artifactSet)}`
    );
    if (statLine) console.log(`      ${statLine}`);
    for (const slot of allSlots) {
      const artifact = member.artifacts[slot];
      if (!artifact) {
        console.log(`      ${slot.padEnd(7)} (empty)`);
        continue;
      }
      const substats = Object.entries(artifact.substats)
        .map(([key, value]) => `${key} ${value}`)
        .join(", ");
      console.log(
        `      ${slot.padEnd(7)} ${artifact.setKey} +${artifact.level} ${artifact.rarity}★ ${artifact.mainStatKey} [${substats}]${artifact.lock ? " locked" : ""}`
      );
    }
  }
}

function printTrace(result: LineupSolverResult): void {
  for (const task of result.trace.tasks) {
    console.log(
      `\n#### ${task.templateId} on ${task.encounterId}: recorded damage ${task.referenceDamage?.toFixed(0) ?? "unscored"}`
    );
    const recordedIds = Object.keys(task.referenceSets);
    console.log(
      `  recorded sets: ${assignmentLabel(task.referenceSets, recordedIds)}`
    );
    console.log("  compositions (generated, current sets):");
    for (const entry of task.compositions)
      console.log(
        `    ${entry.charIds.join(",")} ${entry.damage.toFixed(0)} (×${(entry.damage / (task.referenceDamage ?? 1)).toFixed(3)} of recorded)`
      );
    console.log("  screened sets (generated), in run order:");
    for (const screen of task.screens) {
      console.log(`    ${screen.charIds.join(",")}`);
      for (const outcome of screen.outcomes)
        console.log(
          `      ${outcome.generatedDamage.toFixed(0)} ${assignmentLabel(outcome.assignment, screen.charIds)}`
        );
    }
    const runs = result.trace.runs.filter(
      (run) =>
        run.templateId === task.templateId &&
        run.encounterId === task.encounterId
    );
    console.log("  real-inventory runs:");
    for (const run of runs) {
      const ratio =
        run.damage != null && task.referenceDamage
          ? `×${(run.damage / task.referenceDamage).toFixed(3)}`
          : "unreachable";
      const fails = Object.entries(run.failReasons)
        .map(([charId, reason]) => `${charId}:${reason.kind}`)
        .join(",");
      console.log(
        `    ${run.kind} ${ratio} in ${(run.elapsedMs / 1000).toFixed(1)}s of ${(run.runMs / 1000).toFixed(1)}s` +
          `${run.excludedArtifactCount ? ` excl ${run.excludedArtifactCount}` : ""}` +
          `${fails ? ` failed ${fails}` : ""}` +
          `${run.saturatedCharIds.length ? ` saturated ${run.saturatedCharIds.join(",")}` : ""}` +
          `${run.unmetCharIds.length ? ` unmet ${run.unmetCharIds.join(",")}` : ""}` +
          ` → ${run.candidateId ?? "no candidate"}`
      );
      console.log(
        `      asked  ${assignmentLabel(run.assignment, run.charIds)}`
      );
      console.log(`      formed ${assignmentLabel(run.realized, run.charIds)}`);
    }
  }
}

async function plan(
  request: LineupSolverRequest,
  result: LineupSolverResult,
  calibrated: CalibratedCandidate[]
): Promise<LineupDebugPlan> {
  const encounters = request.encounters.filter(
    (encounter) => encounter.mode === request.mode
  );
  if (request.mode === "abyss")
    return {
      mode: "abyss",
      chambers: planAbyssChambers(
        encounters,
        calibrated,
        result.weaponCopies,
        "per-half",
        LINEUP_MARGIN_TIE_PERCENT,
        LINEUP_PAIRINGS_SHOWN
      ),
    };
  const highs = await loadHighs();
  return {
    mode: "stygian",
    result: planStygianRun(
      {
        encounterIds: encounters.map((encounter) => encounter.id),
        candidates: calibrated,
        weaponCopies: result.weaponCopies,
        tiePercent: LINEUP_MARGIN_TIE_PERCENT,
      },
      (model) => solveMilp(highs, model)
    ),
  };
}

/** Each encounter's chosen candidate id in the plan's best lineup. */
function chosenIds(
  debugPlan: LineupDebugPlan
): Record<string, string | null | undefined> {
  if (debugPlan.mode === "stygian")
    return debugPlan.result?.plans[0]?.candidateIds ?? {};
  const chosen: Record<string, string | null | undefined> = {};
  for (const chamber of debugPlan.chambers) {
    const [best] = chamber.pairings;
    if (chamber.firstEncounterId)
      chosen[chamber.firstEncounterId] = best?.firstId;
    if (chamber.secondEncounterId)
      chosen[chamber.secondEncounterId] = best?.secondId;
  }
  return chosen;
}

function printRun(
  title: string,
  request: LineupSolverRequest,
  result: LineupSolverResult,
  calibrated: CalibratedCandidate[],
  debugPlan: LineupDebugPlan,
  withTrace: boolean
): void {
  console.log(`\n## ${title}`);
  if (debugPlan.mode === "stygian") {
    for (const entry of debugPlan.result?.plans ?? [])
      console.log(`  ${entry.kind} weakest ×${entry.weakest.toFixed(3)}`);
    for (const item of debugPlan.result?.binding ?? [])
      console.log(
        `  without ${item.kind} ${item.id}: ${item.marginWithout?.toFixed(3) ?? "no lineup"}`
      );
  }
  const chosen = chosenIds(debugPlan);
  for (const encounter of request.encounters.filter(
    (entry) => entry.mode === request.mode
  )) {
    console.log(`\n### ${encounterLabel(encounter)}`);
    const pick = calibrated.find((entry) => entry.id === chosen[encounter.id]);
    if (pick) printCandidate(pick, result, request);
    else console.log("  no candidate in the plan");
    const others = calibrated
      .filter((entry) => entry.encounterId === encounter.id && entry !== pick)
      .sort((a, b) => b.margin - a.margin);
    if (others.length > 0)
      console.log(
        `  others: ${others
          .map(
            (entry) =>
              `${entry.id} ×${entry.margin.toFixed(3)} ${entry.members.map((member) => member.charId).join(",")} ${entry.origin}`
          )
          .join(" | ")}`
      );
  }
  for (const issue of result.issues)
    console.log(
      `issue: ${issue.templateId} ${issue.encounterId} ${issue.reason}`
    );
  if (withTrace) printTrace(result);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) throw new Error("Pass --file <lineup-debug.json>.");
  const exported = readExport(args.file);
  printRun(
    `Exported run (${exported.exportedAt})`,
    exported.request,
    exported.result,
    exported.calibrated,
    exported.plan,
    args.trace === "true"
  );
  if (args["no-run"] === "true") return;

  const [chars, weapons] = await Promise.all([
    characterStatsResource.preload(),
    weaponStatsResource.preload(),
  ]);
  const request: LineupSolverRequest = {
    ...exported.request,
    timeBudgetSec: Number(args["budget-sec"] ?? exported.request.timeBudgetSec),
  };
  const start = performance.now();
  let result: LineupSolverResult | null = null;
  await runLineupSolver(request, chars, weapons, (message) => {
    if (message.type === "result") result = message.result;
    if (message.type === "error")
      console.log(`error: ${message.reason} ${message.details ?? ""}`);
  });
  const finished = result as LineupSolverResult | null;
  if (!finished) return;
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  const calibrated = calibrateCandidates(
    finished.candidates,
    request.calibrations,
    request.encounters
  );
  const replayed = await plan(request, finished, calibrated);
  printRun(
    `Replay (${seconds} s, ${request.timeBudgetSec} s per team)`,
    request,
    finished,
    calibrated,
    replayed,
    true
  );
  if (args.dump)
    writeFileSync(
      args.dump,
      JSON.stringify(
        buildLineupDebugExport(
          request,
          finished,
          calibrated,
          replayed,
          new Date()
        )
      )
    );
}

await main();
