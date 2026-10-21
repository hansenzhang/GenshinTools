# Lineup solver

Status: decisions and design, 2026-10-16. P1 is implemented as Build comparison › Team sets,
P0 as Team Comp › Lineups (2026-10-18), P2 as Lineups › Abyss lineups and P3 as Lineups ›
Stygian lineup (2026-10-19), with the fixes in "P3 fixes". P4–P6 are not.
Source: the feasibility study in `~/mistilteinn/reference/notes/team-solver-study.md`, which
compares this repo with Genshin Optimizer (GO) and gcsim, and the decisions made with the user
after it.

## Goal

- Find the best **locked lineups** from the imported account:
  - **Spiral Abyss, full stars**: 2 teams per chamber, one per half. Gear changes between
    chambers.
  - **Stygian Onslaught Fearless, clear**: 3 teams, locked for the whole run.
- **Objective: leximin over calibrated margins.** Maximize the weakest team's margin, then the
  next weakest, and so on.
- Say which unlevelled artifacts are worth levelling **for the weakest team**.

## Decisions

- **One damage library: this repo's.** GO is a cross-check, not a second engine. GO *ideas* are
  ported into this codebase:
  - per-element enemy RES;
  - set-shape search with bonuses valued;
  - `upopt`'s E[improvement] for levelling;
  - LP-fitted linear bounds, deferred until per-team search is the measured bottleneck.

  gcsim is used only to validate teams whose characters it has. It lacks Sandrone and Linnea.
- **Unit of solving: one locked lineup, not the account.** Pieces, characters and weapon copies
  are exclusive only inside a lineup.
  - An Abyss chamber is solved pairwise.
  - A Stygian run is solved as a MILP.
- **Margin** = calibrated DPS ÷ required DPS, from one measured clear (see Calibration). It is
  the only quantity compared across teams. Margins within a few percent of each other count as
  tied.
- **MILP solver: HiGHS**, via the npm package `highs` (lovasoa/highs-js, MIT; 1.15.3 at the time
  of writing). Pin the version when adding it.
  - The model is built as plain data in `domain` and solved in a `services` worker.
  - Unsatisfiable cores from a SAT solver are optional later. Elastic shortfalls already say
    which boss is short and by how much.
- **Additive changes only**, following `docs/architecture.md`, so the feature can be offered
  upstream once proven.

## New models (`domain/team`)

- **Encounter**: mode (Abyss chamber half, or Stygian boss), enemy level, **RES per element**,
  a target-count note, downtime estimate, and the time bar.
  - Abyss bar: the third-star remaining-time condition.
  - Stygian bar: the time limit.
- **Team template**: core character IDs, flex candidates per slot, and composition rules (e.g.
  double Cryo, ≥ 2 Moonsign).
- **Rotation seconds** per template, which gives DPS. The current `dpsSeconds` in
  `components/teams/DamageCard.tsx` is display-only and not saved.
- **Calibration** per (template, encounter): reference build, measured clear time `T_meas`,
  downtime `D`, and bar `T_req`.
- **Candidate**: composition (core + flex), weapon copy IDs, set config, artifact IDs per
  character, and margin per encounter.
- **Lineup plan**: mode, encounters, chosen candidates, margins, shortfalls, binding items.

## Calibration (relative model use only)

For a candidate, take the model's DPS ratio against the calibrated reference build of the same
template: `r = DPS_model(candidate) / DPS_model(reference)`. Then

```
margin = r · (T_req − D) / (T_meas − D)
```

- No enemy HP is needed, and a consistent peak bias in the damage model cancels out. Only the
  within-team ratio `r` comes from the model.
- **The team-to-boss assignment is a user input in v1.** Enumerate it only where calibrations
  exist for the alternative pairings.
- **Abyss timer.** If both halves share one chamber timer, the star bar constrains the *sum* of
  the two halves' clear times, not each margin separately. Pairwise evaluation handles either
  rule.

## Pipeline

1. **Inputs**: encounters, templates, rotation seconds, calibration clears.
2. **Candidates per (template, encounter)**:
   1. Enumerate:
      - flex picks;
      - set configs: 4pc options, 2pc bundle pairs by `halfSetIds`, and who carries a
        team-buff set, using the permutations of `buildUniqueArtifactAssignments` in
        `domain/combat/analyzer/weaponChoice.ts`;
      - owned weapon copies, resolved per physical copy as in `domain/team/weaponCopies.ts`.
   2. Screen with generated artifacts, following `evaluateArtifactAssignment` /
      `runGenerator` (`domain/combat/generator/generator.ts`). Keep the top 10–50.
   3. Run `runTeamOptimization` (`services/combat/optimizer/teamOptimization.ts`) on the real
      inventory for the survivors. Each result becomes a candidate.
   4. Diversify: re-run with the most-contested pieces excluded (`perCharExcludedArtifactIds`).
      That gives the lineup solver conflict-free alternatives.
3. **Solve the lineup**:
   - **Abyss**: per chamber, try every half-1 × half-2 pair that shares no character, piece or
     weapon copy. Rank by (lower margin, then higher margin), or by the summed-time rule.
   - **Stygian**: binary `x_c` for each candidate, exactly one per boss, and ≤ 1 user per
     character, artifact and weapon copy.
     1. Max-min: maximize `z` subject to `margin_c · x_c ≥ z` per boss.
     2. Leximin: repeat, holding the levels already reached.
     3. If even "every margin ≥ 1" is infeasible, re-solve with elastic slack `s_b ≥ 0` and
        report each boss's shortfall.
4. **Explain**: margins, which team is weakest, and the binding items. Remove a contested piece
   or character, re-solve, and report the drop.
5. **Levelling advisor**:
   - For each unlevelled piece, take the distribution of +20 outcomes from Mistilteinn's exact
     mechanics (`upgradeDistribution`, `outlook` in `~/mistilteinn/src/lib/mechanics.ts`, to be
     ported).
   - Map it to damage through the weakest team's gradient (`domain/combat/damage/core/marginalGain.ts`).
   - Value = E[max(0, gain − bar)]. The bar comes from the re-solve in step 4.
   - Rank by P(beats the incumbent), not by expected value, to avoid the optimizer's curse.
   - see if character level/talent levels can improve damage meaningfully as well?

## Phases (one gate)

| Phase | Scope | Ships on its own |
|---|---|---|
| P0 | Per-element RES in `CalcContext` and the damage formula, defaulting to today's single value. Saved rotation seconds. Encounter, template and calibration models with their UI. Existing damage tests unchanged when all RES are equal | prerequisite for P2+ |
| P1 | **Set-config explorer on the real inventory, one team**: carrier permutations plus 2pc bundles, screened with generated artifacts, then finalists optimized on the inventory. Answers "who carries Silken Moon" and "Yae's 2 + 2" | yes |
| P2 | Candidate generation + Abyss pairwise solver | yes |
| P3 | Stygian MILP (HiGHS worker), leximin, elastic shortfalls, binding items | yes |
| P4 | **Gate.** Run the study's decisive experiment on one Stygian Fearless lineup. Compare the floor under: strongest-first sequential, weakest-first sequential, set-search sequential, joint max-min, joint leximin. If joint ≈ set-search sequential within model error, stop the multi-team work and keep P1 + P5 | decision |
| P5 | Levelling advisor | yes |
| P6 | Validation: spot-check a few hits per team on GO's site (covers Sandrone and Linnea); gcsim where the characters exist | — |

P1 compares builds within one team only, so it needs neither per-element RES nor calibration.
It can start before P0, and it gives the first useful answers soonest.

## Where code goes (`docs/architecture.md`)

| Folder | Contents |
|---|---|
| `domain/team/` | Encounter, template, calibration and lineup-plan models and schemas |
| `domain/combat/lineup/` | Candidate enumeration and screening, pairwise packing, MILP model builder (plain data), leximin and elastic driver logic, levelling value math. Pure, no workers |
| `services/combat/lineup/` | Job orchestration over `runTeamOptimization`, plus `lineup.worker.ts` running HiGHS. Caches results by inputs, like `useTeamResultCacheStore` |
| `stores/` | Persistence for encounters, templates and calibrations, with a schema version bump and migration |
| `components/teams/` + `pages/teams/` | A "Lineups" destination next to Analysis and Saved Loadouts (`pages/teams/TeamAnalysisPage.tsx`) |
| `i18n/messages.ts` | English plus natural community-wording Chinese |

Validate with `npm run check` and `npm run depcheck`.

## Out of scope for v1

- Rotation search.
- Syncing energy with damage counts.
- Running gcsim in the app.
- Characters and weapons that aren't owned.
- Price-based column generation. Exclusion-based diversity comes first; add pricing only if
  P4 shows the candidate lists collide too often.
- LP-fitted bounds.

## Open

- **Runtime budget.** Each `runTeamOptimization` call takes seconds, and dozens run per template.
  That's minutes in a background job. Measured in P2 (see "P2 measurements"); screening widths
  are not tuned yet.
- **Calibration burden.** Assignments the user doesn't play need extra clears, or the model has
  to be trusted across bosses.

## P0 as built (2026-10-18)

- **Per-element RES**: `CalcContext.enemyResByElement`, read through `resolveEnemyRes` for the
  formula tag's element, the element RES shred already scopes to. Missing elements use
  `enemyRes`. The enemy settings row in Damage, Builds and Characters has a RES by element
  popover.
- **Rotation seconds**: `TeamDamageConfig.rotationSeconds`, saved from the DPS input. It is left
  out of result-cache and result-reset keys (`teamCalculationInputs`), since it only turns
  rotation damage into DPS. Team store v25, cloud teams v7.
- **Models** (`domain/team/lineupTypes.ts`, `lineup.ts`):
  - Encounters have no names. An Abyss half is labelled by chamber and half; a Stygian
    encounter references a boss in the Stygian archive, which supplies Fearless level and base
    RES. `encounterCalcContext` sets all eight elements, so a team's own enemy settings never
    leak into an encounter.
  - A template links an Analysis team, which supplies the core, rotation, rotation seconds and
    settings. The template adds flex alternatives per slot and element or Moonsign rules.
    `templateCompositions` enumerates what it allows.
  - A calibration saves the team's current build by value: the Current tab's slot configs plus
    equipped pieces, so later levelling does not move the reference. There is at most one
    calibration per (template, encounter). Downtime defaults to the encounter's estimate.
    `calibratedMargin(r, …)` returns a margin or a reason it cannot (no bar, or downtime ≥ the
    clear or the bar). The Lineups tab shows the reference margin (`r = 1`).
- **Persistence**: `lineup-storage` v1. It is device-local, outside cloud backup: adding it needs
  a new cloud namespace in the Worker. Hydration keeps valid items and drops orphaned
  calibrations.
- **Left for P2**: model DPS of the reference build under the encounter context, which gives `r`
  for candidates.

## P1 measurements (2026-10-16)

Measured with `tests/benchmark/setConfigCost.ts` in Node (single thread). The browser is
usually somewhat slower per evaluation, but it runs one optimizer worker per member.

| Step | Lunar (Flins · Columbina · Ineffa · Sucrose) | Sandrone · Yae · Odette · Alyosha |
|---|---|---|
| `new TeamBuild` while a member's set changes | 0.3–0.4 ms | 0.2–0.3 ms |
| `getComboDamageResult` on fixed sheets | 0.5 ms | 0.5 ms |
| Full-team `runGenerator` | 55 ms | 60–65 ms |
| One real-inventory finalist, sets enforced, 6 s budget (own account) | 9.1 s | 7.4 s |

- A fixed-sheet evaluation costs about 1 ms, so ~2,400 joint assignments take ~2.5 s. No
  CharBuild cache is needed.
- The generator is cheap enough to re-score dozens of screened assignments. It runs on the top
  joint assignments and on every witness, not only on the finalists.
- The real-inventory optimizer is the cost: it takes 6–9 s per finalist even at a 2 s budget
  (inline path). Results were identical across repeats and between 2 s and 6 s budgets. At
  12 s, the Sandrone team gained 0.8%. So account results within 1% count as tied.
- In the browser (dev build, one optimizer worker per member), a full Team sets run with owned
  artifacts and the default 60 s budget took 67–73 s end to end. Three runs of the same team gave
  identical percentages.

## P2 as built (2026-10-19)

- **Job** (`services/combat/lineup/lineupSolver.ts`, run by `lineupSolver.worker.ts`): one task
  per Abyss half that a template has a recorded clear for. That clear is the user's
  team-to-half choice. Each task:
  1. Scores the recorded build under the half's enemy (`encounterCalcContext`). It uses the
     sets its pieces form and the team's current rotation, limited to the recorded members.
  2. Fields the template's compositions with `fieldComposition`:
     - a team character keeps its slot's weapon and set goal;
     - an alternative brings its equipped weapon and the sets its pieces form;
     - a member whose weapon has no copy left takes its equipped weapon;
     - compositions with unowned characters are skipped.

     `compositionObjective` keeps the lines of members who stay and adds the default lines of
     members who join (`joiningMemberLines`, shared with character replacement). The objective
     is always a rotation (see "Scoring objective", 2026-10-21).
  3. Ranks up to 64 compositions with generated artifacts at their current sets. The P1 screen
     then runs for up to 4: the best, the best without each member that some composition
     leaves out, then the next best.
  4. Optimizes finalists on the real inventory round-robin across compositions (each one's
     best, then its next), up to 6 runs within Time per team (default 30 s). The P1 job was
     split for this into `prepareTeamSetsJob` and `optimizeAssignmentOnAccount`.
  5. Records each reachable result as a candidate: members with weapon, refinement, pieces
     and realized sets, plus damage and `r = damage ÷ recorded build's damage`. Rotation
     seconds are per template, so `r` is the damage ratio.
- **Margins are left to the caller.** `calibrateCandidates` applies the current clear and bar
  to `r`, so editing `T_meas`, `D` or the bar keeps a finished run. Those fields are not part
  of the run's inputs.
- **Weapon copies are counted per weapon**, not tracked per physical copy. Candidates can be
  fielded together when no weapon has more users than owned copies. Refinement differences
  between copies of one weapon are not modelled: each team assumes its best copy. The same
  count is the MILP constraint for P3: `Σ uses_c · x_c ≤ copies`.
- **Weapons are not searched.** They change only to resolve copy shortages, as above.
- **Diversify.** Per chamber, the best candidate per template and composition on one half is
  paired with each such candidate on the other. A pair that shares pieces or weapon copies,
  but no character, is fixed in both directions, up to 4 fixes per chamber:
  1. The composition's sets are screened again with the other candidate's pieces excluded for
     every member, since the remaining pieces may not form the original sets. The best
     assignment is then optimized.
  2. A weapon the other candidate needs and the account lacks copies of is replaced by the
     best free owned weapon of its type, re-scoring the same pieces.
- **Pairing** (`domain/combat/lineup/abyssPairs.ts`) tries every first × second candidate that
  shares no character or piece and overuses no weapon.
  - Per half: the weaker margin ranks first. Margins within 3% are tied, and then the
    stronger half decides.
  - Shared timer: the halves' bars add up to the chamber's, and the chamber margin is
    `(Σ bar − Σ D) ÷ Σ predicted active time`. Ties go to the weaker half.
  - A pairing that matches a better one on both halves (same template and members, margins
    tied) is dropped.
  - A chamber with one calibrated half lists that half's candidates.
- **UI**: Lineups › Abyss lineups has Time per team, Timer and Find lineups. Each chamber
  shows its best pairing. Per half it shows the margin, the change against the recorded build,
  the margin that half would reach alone, whether the team left the other half's artifacts or
  took a free weapon copy, and each member's weapon, pieces and sets. Other pairings can be
  selected, and tied margins are marked with ≈. Results last for the session. The job keeps
  running while the tab is closed and stops when its inputs change.
- **Left for later**: Stygian (P3), binding items and the drop when one is removed (Explain),
  and saved results.

## P2 measurements (2026-10-19)

Measured with `tests/benchmark/lineupCost.ts` on the own account (2,530 artifacts), in Node on a
single thread (inline optimizer path), with Time per team 30 s. Lunar (Columbina · Ineffa ·
Linnea or Aino · Sucrose) takes 12-1 first half and Sandrone (Sandrone · Yae · Odette ·
Alyosha or Bennett) the second, both recorded at their equipped builds.

| Step | Lunar | Sandrone |
|---|---|---|
| Composition ranking and set screens (2 compositions) | 9.1 s | 11.3 s |
| Real-inventory runs | 41 s | 30 s |

- Diversify ran 4 fixes, each a set screen plus one run, in 47–49 s. The chamber took
  139–140 s in total, and two runs gave identical candidates.
- Alone, the best builds reach ×1.354 and ×1.262, but they share one piece. The fixes give two
  conflict-free pairings: Lunar keeps the piece at ×1.354 with Sandrone at ×1.182, or gives it
  up at ×1.195 with Sandrone at ×1.262. Their weaker halves are within 3%, so the first is
  listed first.
- A full Abyss of 3 chambers × 2 teams extrapolates to about 7 minutes in Node. The browser
  runs one optimizer worker per member. A two-member test account took about 13 s there end
  to end.
- Real-inventory runs overshoot their per-run time on the inline path, as in P1. Runs and the
  re-run set screens dominate; the composition screen does not.

## P3 as built (2026-10-19)

- **Solver**: `highs` 1.15.3, pinned (1.15.4 was three days old). `stygianPlan.worker.ts`
  loads it once per session and solves whenever candidates or clears change. The loader finds
  `highs.wasm` beside itself: Vite serves it from `node_modules` in development and emits it as
  an asset in the build. A `highs/runtime?url` import was avoided, because dependency-cruiser
  cannot resolve a query on a package export. `highsSolver.ts` writes the plain-data
  `MilpModel` (`domain/combat/lineup/milpModel.ts`) in CPLEX LP format and maps the result.
  Tests load the Wasm bytes from disk (`tests/helpers/highs.ts`), since jsdom looks like a
  browser to the loader.
- **Run model** (`domain/combat/lineup/stygianPlan.ts`): a binary `x_c` per candidate, exactly
  one per boss. Characters and pieces used on two or more bosses get `Σ x ≤ 1`, and weapons get
  `Σ uses_c · x_c ≤ copies` when the possible demand exceeds the copies. Bosses without a
  candidate are left out and reported.
- **Leximin**: for k = 1…bosses, maximize the sum of the k smallest margins. That sum is
  `max_t k·t − Σ_b max(0, t − y_b)`, with one free `t` and `d_b ≥ t − y_b`. Each level is held
  at its optimum minus the 3% tie, but level 1 never drops a clearing lineup below 1. The
  Abyss tie rule follows the same never-below-1 rule (`marginsTied`).
- **Elastic shortfall**: when the weakest margin is below 1, a second plan minimizes `Σ s_b`
  with `s_b + y_b ≥ 1`, and ties go to total margin (weight 1e-3). It is listed only when it
  differs from the leximin plan.
- **Binding items** (Explain): gear of the plan that a candidate for another boss also uses,
  checked in the order characters, then weapons, then pieces, up to 16 items. Each is removed
  (a weapon loses one copy) and the max-min is solved again. Items whose loss lowers the max-min
  are reported, worst first. Abyss chambers report the same for their best pairing, using the
  best pairing margin left.
  - This only re-solves over the candidates found. Gear that every found build of a team uses
    shows as "No alternative" even when other pieces could replace it. On real accounts that
    is most of a carry's pieces.
- **Candidates for Stygian**: the job takes a `mode`. A Stygian run is one group for
  diversification. Besides pairwise fixes, it builds two boss-by-boss lineups, weakest and
  strongest first. Each pick is the strongest candidate that shares no character with earlier
  picks and, when it can, leaves alone characters every candidate of a later boss needs. Each
  pick is kept clear of the earlier picks' pieces (re-screened and re-run) and weapon copies
  (swapped). At least one full lineup then fits. Identical builds and repeated re-runs are
  reused.
- **UI**: Lineups › Stygian lineup has Time per team and Find lineups. It shows the best
  lineup's weakest boss, and per boss the team, margin, "Needs +X% damage" below the bar, and
  gear. It also shows Hardest to lose, and the shortfall plan when there is one. Both sections
  share `LineupResults.tsx`, and the job hook keeps one job per mode.
- **Left for later**: re-optimizing without a binding item (not only re-solving over found
  candidates), saved results, and the P4 comparison.

## P3 measurements (2026-10-19)

`tests/benchmark/lineupCost.ts --mode stygian` on the own account, in Node on a single thread,
with Time per team 30 s. Three bosses: Lunar (Linnea or Aino), Sandrone (Alyosha or Bennett),
and a national team (Xiangling · Xingqiu · Bennett · Kaeya) whose every build needs Bennett.

| Step | Lunar | Sandrone | National |
|---|---|---|---|
| Composition ranking and set screens | 9.8 s | 11.7 s | 2.5 s |
| Real-inventory runs | 46 s | 31 s | 25 s |

- Diversify (chains and pairwise fixes, up to 8 re-runs) took 82 s; the run took 208 s in
  total. Two runs gave identical candidates.
- HiGHS solved the whole plan, with leximin, shortfall check and 16 binding re-solves, in
  90 ms.
- The best run is Lunar ×1.195 (without a contested piece), Sandrone with Alyosha ×1.217 and
  national ×4.43. Before chains kept Bennett for the national team, the only full lineup
  found had its weakest boss at ×1.074.
- The national team's margins are high because its recorded build is weak. Only the ratio to
  that build matters.

## P3 fixes (2026-10-19)

A real Stygian run gave carries 4pc sets of +0/+4 pieces with no CR/CD (Sandrone in Shimenawa,
Ineffa in Tenacity, Columbina in Noblesse) and dropped the Lunar team's Aubade. Causes:

- **The set screen ignored piece quality.** It ranked sets on generated artifacts, which rate
  every set as if its pieces were ideal, and `canWear` only asked for one piece per slot. The
  account had no Shimenawa, Tenacity, Noblesse, Instructor or VV piece at +16 or higher.
- **Recorded sets never ran on the account.** P1 always runs the current sets; the lineup job
  ran only the screen's finalists, 1–2 per composition, so a team could end below its record.
- **Saturation never fired.** The optimizer skipped members with an ER requirement, and the
  default requirement is 100%, so every support was searched with zero weights. Their arbitrary
  pieces then showed as contested gear.

Changes:

- **Debug export.** Lineups › Export debug file saves the request (account included), candidates,
  margins, plan and a trace: compositions and screened sets with their generated damage and
  account estimate, every real-inventory run (budget, time, fail reasons, saturated members,
  weights), and each candidate member's final stats. `tests/benchmark/lineupReplay.ts` prints an
  export and runs it again in Node.
- **Account estimate** (`estimateOnAccount` in `setConfigScreen.ts`, piece values in
  `accountEstimate.ts`, set shapes in `domain/combat/optimizer/setShapePicks.ts`). Each member's
  pieces are valued by marginal damage per stat at the generated build, the best pieces that form
  the set are picked (most stat-sensitive member first, no piece twice), picked again at those
  real pieces, and the team is scored on them. Members short of ER/CR re-pick with that stat
  valued higher, or the estimate is infeasible. The screen keeps each member's best three choices
  on its own pieces, and estimates every re-scored assignment. Compositions and finalists are
  ranked by the estimate; P1 picks its finalists by it too. On the own account it was within 1%
  of the real run for the same sets.
- **Recorded floor.** The recorded build is a candidate (`origin: "recorded"`, r = 1) when its
  members are one of the template's compositions and its pieces are still owned, and its sets
  run on the account first.
- **Any pieces.** A candidate member whose artifact stats are worth under
  `LINEUP_ANY_PIECES_PERCENT` (2%) of team damage, with its ER/CR requirement met without them,
  only needs its set. Its pieces are not exact gear: they are left out of conflicts, binding items
  and re-run exclusions. Instead the Stygian MILP and Abyss pairing bound pieces per set and
  slot (`setSlotCounts`): exact pieces plus such members' set slots stay within what is owned.
  The cards fill those members with free pieces of their set (`fillAnyPieces`).
- **Saturation in the optimizer** is now "no stat moves damage and ER/CR are met without
  artifacts", so the default 100% ER no longer blocks it. Its fill forms sets with
  `pickForChoice` (2+2s included) and reports `set-impossible` like the search, unless the member
  may drop its set.
- **Budgets.** Time per team is 30 s, 2, 5, 10 or 20 min, or Until done (no deadline; the
  optimizer's per-worker fallback timeouts apply only with a budget). Runs per task scale with
  the budget up to 24, taking finalists further down the estimates. Runs with a timed-out member
  give no candidate.
- **Kept artifacts only** (on by default): members whose pieces matter use locked pieces, pieces
  Triage recommends locking and recorded builds' pieces; any-pieces members use everything.
- **Template hints**: a warning when the team itself breaks the template's rules (every margin
  is then measured against a team that is never fielded), and a note that joining alternatives
  use their default rotation.


## P3 run cost (2026-10-20)

A Stygian run with Kept artifacts only and Until done showed "Team 1/3 · Optimizing owned
artifacts 22/24" after 954 min. The timer is wall clock, and the Mac was awake for 1–2 h of
that, so a run took ~3–5 min in the browser (dev server).

Measured in Node on the own account with the user's three teams (627 locked plus recorded
pieces):

| Step, no deadline | Pool | Time |
|---|---|---|
| One member's search at its set goal (4pc, or Yae's 2+2 with ≤4,680 set patterns) | ~630 | 0.0–0.3 s |
| One member's search with no set | ~630 | 0.7–7 s |
| An any-pieces member (Diona), 2+2 / no set | 2,089 | 0.2–1.2 s / 24 s |
| Whole `runTeamOptimization`, every phase | ~630 | 8.8–14.9 s |

- **The pool is not the bottleneck.** An exact dominance filter (drop a piece with ≥4 dominators
  in its slot, set and main stat on the member's stats) keeps 616–625 of 633 pieces: low-level
  pieces rarely dominate each other.
- **The browser takes 15–30× longer than Node.** The suspect is worker start-up on the dev
  server: each run starts 4 module workers for Phase 1 and 4 more per Phase 3 round. Not
  confirmed yet.

To confirm it, runs are now observable:
- The progress line shows the optimizer phase, the members still searching (Phase 1) or the
  refinement round (Phase 3), and the optimization's own time.
- Every run's trace records its spans (`init`, `phase1` with contested-piece re-runs, `phase2`,
  one `phase3` span per round) and when each member's parallel search ended.
- A partial result with the trace goes out before and after every run. A stopped job can
  therefore be exported; `trace.inFlight` names the run it was on. Debug export version 2.
- `tests/benchmark/lineupReplay.ts --trace` prints the spans and the run in progress. With
  `--budget-sec 0` it times the same runs in Node.

## P3 fixes (2026-10-21)

A Stygian export (Domovoy Sculptor, Overseer Device, Guardian Blade) listed Yae and Odette as
any pieces, though they deal 20–30% of their teams' damage, and gave the Mizuki team with
Faruzan ×3.0. Causes:

- **Teams without a saved rotation were scored on one formula.** With no damage settings, a
  team resolved to single-formula mode with slot 1's first formula: `sandrone-normal ×1` and
  `mizuki-skill-initial ×1` (851 damage). On the default rotation Yae deals 39% of the
  Sandrone team's damage and Odette 58% of the Mizuki team's. Under one Sandrone or Mizuki hit
  they moved nothing, so they fell under `LINEUP_ANY_PIECES_PERCENT`. The search geared Mizuki
  for ATK to raise that one hit. Re-scored on the default rotation, the ×3.0 Faruzan build is
  ×0.43 of the recorded build, and the Sucrose build with the recorded sets (×1.46) is ×0.88.
- **A composition's finalists could be skipped.** The run round-robin de-duplicated finalists
  by `assignmentKey`, which names each slot's sets but not its member. A joining alternative
  takes the slot of the member it replaces, so its finalists matched the core's and were never
  run on the account.

Changes:

- **Scoring objective.** A lineup scores the team's saved rotation, or the default rotation
  when none is saved. A selected single formula is never used: margins compare whole-team clear
  times. A template whose team has no saved rotation says so.
- Planned runs are keyed by members and sets.

Replayed in Node at 30 s per team, Yae and Odette are no longer any pieces. Faruzan's best
account build is ×0.97 against Sucrose's ×1.10, and its composition ranks below Sucrose's
(account estimate ×0.86 against ×1.15 at the current sets).

Found in the same replay, not fixed:

- **The optimizer prunes a slot before it groups by set.** `prepareSlotData` keeps the top
  `maxArtsPerSlot` pieces per slot by score (and, for the carry, drops unlevelled pieces past
  the top N) before it checks the set goal. Mizuki's 4★ Instructor flowers and plumes fell
  out, so 7 of the Mizuki team's 10 runs failed `set-impossible`. The account estimate ranked
  those runs at ×1.33–1.49, because it picks from the whole inventory. The pool is shared by
  every optimizer caller, so the fix belongs with the optimizer.
- **The pruning also blocks the better lineup.** At the export's 600 s per team (941 s in
  Node, 13 of 69 search runs `set-impossible`), the best lineup is Sandrone ×1.00 (recorded),
  Mizuki ×0.75 (recorded) and Lunar with Fischl and Bennett ×0.401; the shortfall plan's
  weakest is ×0.355. Lunar reaches ×0.528 only with Sucrose, which needs Faruzan on the Mizuki
  team. Every Faruzan build found shares pieces with every Lunar build with Sucrose, and takes
  the account's one VV flower. Both chain re-runs that would have kept Faruzan clear failed on
  Mizuki's Instructor pool. At 30 s per team no full lineup fit at all.
