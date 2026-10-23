# Lineup solver

Status: decisions and design, 2026-10-16. P1 is implemented as Build comparison › Team sets,
P0 as Team Comp › Lineups (2026-10-18), P2 as Lineups › Abyss lineups and P3 as Lineups ›
Stygian lineup (2026-10-19), with the fixes in "P3 fixes". P5 is implemented as Lineups ›
Worth levelling (2026-10-21, "P5 levelling advisor"), with "P5 follow-ups". P4 has five
measured runs ("P4 comparison" and the later exports, 2026-10-21 and 22); P6 is not done.
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

Found in the same replay:

- **The optimizer pruned a slot before it grouped by set.** `prepareSlotData` kept the top
  `maxArtsPerSlot` pieces per slot by score (and, for the carry, dropped unlevelled pieces past
  the top 50) before it checked the set goal. Mizuki's +0 4★ Instructor flowers and plumes fell
  out, so every Mizuki-in-Instructor run failed `set-impossible`, although the account estimate,
  which picks from the whole inventory, ranked them ×1.33–1.49. At the export's 600 s per team
  (941 s in Node), 13 of 69 search runs failed this way, including both chain re-runs that would
  have kept Faruzan clear of the Lunar team's pieces. The best lineup was Sandrone ×1.00, Mizuki
  ×0.75 and Lunar with Fischl and Bennett ×0.401. At 30 s per team no full lineup fit.
- **Fixed:** both cuts now also keep a piece that ranks within the cut among the pieces of its
  goal group: the 4pc set, or one half of a 2pc+2pc. Off-set pieces still stop at the cut. The
  fix sits in the shared optimizer, so every caller gets it; the generator's golden file is
  unchanged. Replayed at 600 s per team (1,132 s in Node), all 69 search runs succeed and the
  weakest boss rises to ×0.528: Sandrone ×0.914, Mizuki with Faruzan (Mizuki in Instructor)
  ×0.881, Lunar with Sucrose ×0.528.

- **HiGHS presolve misreported a feasible plan as infeasible.** Replaying the export with RES
  phases, leximin level 2 came back infeasible although the level-1 optimum satisfies every row.
  HiGHS 1.15.3 logged "Solution with objective 1.38551 has untransformed violations: row = 1"
  for every solution and reported the model infeasible; with presolve off it is optimal at the
  same objective. Any run could hit this and show no lineup. `solveMilp` now turns presolve off.
  A whole plan (20 solves with binding items) took 92–126 ms with presolve and takes 152–199 ms
  without. The failing model is a test fixture.

## RES phases (design, 2026-10-21)

Stygian bosses change RES during a fight: the Domovoy Sculptor starts at 90% and loses 20% per
broken sculpture (Anemo 25%), up to 3 stacks; the Overseer Device sits at 200% while spinning
and at Cryo −30% / others 30% while stunned; the Guardian Blade drops to −40% for 10 s after each
of its two shields breaks. One RES per element cannot price RES shred across such phases: VV's
−40% adds 22% damage at 200% RES and 50% at 30%.

Decided with the user (2026-10-21): weight each phase by **time in phase**; enter phases **per
encounter**; **save Stygian phases per boss** so a returning boss needs no re-entry.

- **Phase**: `ResPhase { seconds; all: number | null; res: per-element }`. A phase's RES for
  an element is its own entry, else `all`, else the encounter's base RES (else
  `DEFAULT_ENCOUNTER_RES`). Every phase but the last lasts `seconds`; the last runs to the end
  of the clear and ignores its seconds, which are kept for when a phase is added after it.
  `Encounter.resPhases` is empty for a constant RES, as before.
- **Weights** come from the calibration's measured clear `T_meas`: the phases take their
  seconds in order until `T_meas` is used up, and the last takes the rest. Phases past `T_meas`
  weigh nothing. Downtime is not placed in time, so it does not change the weights.
- **Formula**: `CalcContext.enemyResPhases` holds `{ weight, resByElement }` per phase, resolved
  for all eight elements. The RES multiplier becomes `Σ weight · f(RES − shred)`, with `f` the
  usual three-branch curve, so shred is priced in each phase. Shred is constant in practice, so
  the optimizer's compiled formula still folds it to one constant; the rare variable-shred
  branch uses the weighted mean RES, as it uses the linear branch today. `resolveEnemyRes`
  returns the weighted mean for display; breakdowns never show a lineup context.
  `encounterCalcContext(encounter, base, clearSeconds)` builds it; `TeamBuild` carries it.
- **Saved per boss**: the lineup store keeps `resPhasesByBoss`. Adding a Stygian encounter
  copies its boss's saved phases, and editing a Stygian encounter's phases saves them for its
  boss. Abyss halves change every cycle, so their phases stay on the encounter.
- **Persistence**: `lineup-storage` v2 adds `resPhases: []` to each encounter and an empty
  `resPhasesByBoss` (`stores/migration/lineup.ts`, old shape documented there). The store stays
  device-local. Debug export v3 carries the phases; the replay reads v2 as no phases.
- **Run inputs**: phases are part of the job signature. A calibration's measured clear joins
  it when its encounter has phases, since the weights depend on it; otherwise editing the clear
  still keeps a finished run.
- **UI**: the encounter card lists phases: seconds (or "rest of the clear" for the last), All
  RES and per-element overrides in the existing RES-by-element popover; add and remove.

Examples, from the user's notes:

| Boss | Phases |
|---|---|
| Domovoy Sculptor | 10 s All 90 · 16 s All 70, Anemo 65 · 16 s All 50, Anemo 40 · rest All 30, Anemo 15 |
| Overseer Device | until the first stun (seconds the user plays) All 200 · rest All 30, Cryo −30; Nightsoul mode as an All 110 phase for teams that trigger it |
| Guardian Blade | 20 s All −40 · rest at base RES (All empty) |

Limits:

- Every candidate uses the recorded clear's weights. A faster build would spend more of its
  clear in the early phases.
- Damage is assumed even over the clear: bursting into a low-RES window is not weighted up.
- Fixed-HP events and HP gates are not RES and are not modelled: the Sculptor's 1,000,000 HP
  explosions, the Guardian's 80% floor and shield time (downtime), the Overseer's energy.
- Margins are ratios to the recorded build on the same boss, so phases matter where a
  template's options differ in element or shred (Sucrose's VV against Faruzan, the Lunar flex
  slot), not for a team whose members all face the same curve.

Tests: phases with equal RES match a single RES (existing damage tests unchanged); shred is
applied per phase; weights for clears shorter and longer than the listed phases; a v1 store
fixture through hydration; a boss's phases reused by a new encounter.

## RES phases as built (2026-10-21)

- **Formula**: `CalcContext.enemyResPhases` (`domain/combat/damage/types.ts`);
  `enemyResMultiplier` and `resMultiplier` in `domain/combat/damage/utils.ts` replace the RES
  curve in `computeResMult` and the constant branch of `computeResMultExpr`. `TeamBuild` keeps
  the phases in its baseline context.
- **Model**: `ResPhase` and `Encounter.resPhases` (`domain/team/lineupTypes.ts`);
  `resPhaseWeights` and `encounterCalcContext(encounter, base, clearSeconds)`
  (`domain/team/lineup.ts`). The lineup job passes each task's measured clear.
- **Store**: `lineup-storage` v2 with `migrateLineupStore` (`stores/migration/lineup.ts`),
  `resPhasesByBoss`, and `setResPhases`, which saves a Stygian boss's phases. The job signature
  includes a calibration's measured clear when its encounter has phases. Debug export v3; the
  replay reads v2 as no phases.
- **UI**: the encounter card's RES phases list (`LineupEncounters.tsx`). The RES-by-element
  popover moved from `GeneratorControls.tsx` to `ElementResInputs.tsx` (`ElementResPopover`)
  and takes a fallback per element, so a phase's empty cells show the RES they stand for.
  Checked in the dev server at 1440 px and 375 px wide, with no horizontal scroll.
- **Measured** on the export at 600 s per team in Node, with the user's Sculptor phases (10 s at
  90%, 16 s at 70/Anemo 65, 16 s at 50/Anemo 40, then 30/Anemo 15), Overseer phases (an assumed
  15 s spin at 200%, then 30/Cryo −30) and Guardian phases (20 s at −40%, then base RES):

  | Boss | Recorded damage | Chosen lineup without → with phases |
  |---|---|---|
  | Sculptor (Sandrone) | ×0.75 | ×0.914 → ×0.857 |
  | Overseer (Mizuki, Faruzan) | ×1.04 | ×0.881 → ×0.918 |
  | Guardian (Lunar, Sucrose) | ×1.02 | ×0.528 → ×0.528 |

  The lineup and its weakest boss are unchanged. Sucrose stays ahead of Faruzan for the Mizuki
  team (best ×1.135 against ×1.012 with phases, ×1.119 against ×0.997 without). As the limits
  above predict, phases move absolute damage more than the ratios that margins use.
- **Open**: the Overseer's spin length is a guess until the user enters it; phases in the
  browser need the user's own run.

## P5 levelling advisor (design, 2026-10-21)

The question: which unlevelled pieces should be levelled for the lineup's weakest team, and do
its talents or character levels matter as much. P4 has not run; P5 ships on its own either way.

- **Which team**: the weakest boss of the Stygian plan shown, and in each Abyss chamber the
  weaker half of the pairing shown. Gains are relative to that team's damage, rebuilt from the
  run's inputs, and a margin moves with damage (`margin ∝ r`). Raising the weakest team lifts
  the lineup's floor only up to the next-weakest team's margin. The advisor does not cap at
  that margin; the plan already shows it.
- **Options**:
  - Pieces: for each member whose pieces matter (not any pieces) and each slot, every owned 4★
    or 5★ piece of that slot below max level. Pieces another team of the lineup needs, or another
    member of this team wears, are left out. A swap must keep the sets the member's pieces form;
    any main stat may replace another. The worn piece, if unlevelled, is one of the options. Kept
    artifacts only does not apply: deciding what to level is how a piece becomes worth keeping.
  - Steps: each member's Normal Attack, Skill and Burst one level up (base level below 10), and
    the character's next level tier (70 → 80 → 90 → 95 → 100), as in Analysis.
- **Roll odds** (Mistilteinn's `upgradeDistribution`, ported to damage units): a 5★ piece has
  5 upgrades and a 4★ piece 4, one per +4 level. Below four lines an upgrade adds a line, drawn
  by weight (flat HP/ATK/DEF 6, HP/ATK/DEF%, ER and EM 4, CR and CD 3) from the stats that are
  neither the main stat nor an existing line. The line is known when the game has shown it
  (GOOD's `unactivatedSubstats`). With four lines each upgrade raises one line, uniformly.
  Every roll is one of the four tier values, uniformly. The main stat goes to its max-level
  value.
- **Damage**: the fixed part is scored exactly: the piece at max level with its current lines,
  the known line activated, and the sets re-formed. Rolls go through the member's marginal
  damage per stat at that point (`memberStatWeights`), the delta method of GO's `upopt`. The
  gradient is taken there, not at the current build, because a main stat moves it (a CR circlet
  makes a CD roll worth more and a CR roll worth less). The distribution of the sum is exact,
  binned at 0.01% of team damage.
- **Value and rank**: a piece **beats the current one** when the team's damage rises by more
  than the margin tie, 3%. Below that, the gain is within model error. The advisor reports:
  - P(beats);
  - E[max(0, gain)], the expected gain if a worse result is not worn. This is
    `E[max(0, gain − bar)]` with the plan as built as the bar; one swap at a time, the rest of
    the lineup held.

  Each slot lists its best option, ranked by P(beats), then by expected gain (P within one
  point counts as tied). Levelling one piece raises the bar for the others in its slot: level
  it, then run again. Options with no chance to beat the current piece are left out. Steps are
  certain, so they are listed by gain, with those under the tie marked.
- **Screen**: exact scoring takes about 20 evaluations per option, so options are first ranked by
  the gradient at the current build: the fixed part's linear change plus the expected rolls per
  stat (Mistilteinn's `expectedRollsByStat`). The top 6 per member and slot, and the worn piece,
  are scored exactly.
- **Where**:
  - Roll odds and option math go in `domain/combat/lineup/levelling.ts`.
  - Rebuilding the candidate's scoring input from the run's request goes in
    `services/combat/lineup/levellingAdvisor.ts`. The solver's context helpers are reused.
  - `levellingAdvisor.worker.ts` runs it; `hooks/useLevellingAdvice.ts` asks it.
  - The cards are in `components/teams/LevellingAdvice.tsx`, under Hardest to lose.
  - Nothing is saved. Advice follows the shown plan and is recomputed when that plan's team or
    lineup changes. Clear times only change the margins shown.
- **Limits**:
  - One swap at a time: X freeing the worn piece for another team is not valued, and the
    lineup is not re-solved per outcome.
  - The gradient is linear within one piece's rolls; CR past 100% and ER requirements are not
    re-checked per outcome.
  - A swap that would change the member's sets is not considered.

Tests: roll odds against brute-force enumeration (sums to 1; four lines match a binomial; a
known line); exact P and E against enumeration for a small linear case; sets kept; pieces of
other teams left out; a +0 worn piece with the right main stat recommended; steps.

## P5 as built (2026-10-21)

- **Domain** (`domain/combat/lineup/levelling.ts`): `pendingRolls`, `levelledPiece`,
  `rollGainDistribution`, `expectedRollsByStat`, `summarizeOutcome` and `adviseLevelling`.
  Constants: `LEVELLING_GAIN_BIN`, `LEVELLING_SCREENED_PER_SLOT` (6) and `LEVELLING_CHANCE_STEP`
  (1 point). `setConfigScreen.ts` now exports `formedSet` and `heldEvaluator`. A swap that leaves
  a member short of its ER or CR requirement at the fixed point is dropped.
- **Service** (`services/combat/lineup/levellingAdvisor.ts`, `levellingAdvisor.worker.ts`):
  `candidateScreen` rebuilds the scoring input with the solver's own `taskScoring` and
  `fieldScoredComposition`, now shared by `generateTaskCandidates`. A test checks that it
  reproduces every candidate's damage to 1e-9.
- **UI** (`components/teams/LevellingAdvice.tsx`): under Hardest to lose in the Stygian plan
  card and in each Abyss chamber card, for the weaker team of what is shown.
  - Each row shows the member, the piece and its levels, the piece it replaces, the chance,
    the expected gain and the margin it would reach.
  - Talents and levels follow; steps under 3% are muted.
  - The request is keyed by the run's signature and candidate ids, so editing a clear or bar
    keeps the advice. Nothing runs while the solver does.
- **Replay**: `tests/benchmark/lineupReplay.ts --levelling` prints the advice for each lineup's
  weakest team, timed.
- **Measured** on the Stygian export of 2026-10-21 06:57 (debug v2, 600 s per team), with
  `--no-run`. Node, single thread. That export predates the scoring-objective fix, so the
  advisor rescores the teams on the current objective.

  | Team (plan margin) | Time | Best options |
  |---|---|---|
  | Lunar, Sucrose (×0.500, weakest) | 1.0 s | Ineffa goblet +13 Aubade: 25%, +2.5%; Ineffa circlet +0 Gladiator's CR: 9%, +1.7%; Columbina flower +4: 1%. Ineffa Lv 90 → 95 +3.5% |
  | Sandrone (×0.793) | 0.3 s | a +0 Shimenawa ATK% sands in place of the worn +4: 100%, +4.9%; a +4 goblet: 95%, +4.1%; the worn +4 plume: 89%, +3.7% |
  | Mizuki (×2.21) | 0.5 s | a +4 EM sands and goblet in place of the +20 ATK% ones: 100%, +9.5% and +7.4% |

  The Lunar team's carries are at +20, so levelling cannot close its gap. Its weakest boss
  needs ~+100%, and the best certain step is Ineffa's next level tier. Sucrose's pieces are
  worth 2.6% of team damage. Levelling her +4 EM sands adds a certain 1.9%, under the tie,
  so none of her pieces is listed.
- **Browser** (dev server, headless Chromium):
  - Account: two teams on a small test account.
  - A Stygian run plus advice took 40–53 s.
  - The weaker team (×0.95) was told to level its unlevelled Gladiator's pieces: 100% each,
    +12% expected, reaching ×1.07.
  - Checked at 1440 px and 375 px (no horizontal scroll), in English (Nodkrai theme) and
    Chinese (Mondstadt theme).
  - The Abyss card shares the component; it is covered by a component test, not checked in
    the browser.
- **Open**:
  - The advice on the user's own run in the browser.
  - Advice for a team other than the weakest.
  - Weapon levels.
  - The next-weakest team's margin as a cap on the floor gain.
  - P4 still decides whether the multi-team work continues; P5 stands either way.

## P5 follow-ups (design, 2026-10-21)

From testing on the Stygian export of 2026-10-21 12:01 (20 min per team). The account has 1,338
pieces at +4 and 458 at +0 against 34 at max, and the advisor listed nothing for the weakest
team (Lunar, ×0.528): no single swap beat the 3% tie. Ineffa, Columbina and Linnea are Lv 89,
and the advisor offered "Lv 90 → 95".

- **Level artifacts to max** (run option, off by default, kept for the session like Kept
  artifacts only):
  - The run scores every 4★ and 5★ piece below max level as levelled: main stat at max, the
    lines the game has shown, and its pending rolls at their expected value (expected rolls
    per stat × the mean roll). `expectedLevelledPiece` in `levelling.ts`. Expected rolls are
    the mean outcome, so a lineup is planned on what levelling gives on average.
  - It is applied once, to the request's account at the run's entry, so the account estimate,
    the optimizer, scoring, any-pieces checks and the MILP all see the same pieces. The
    recorded build is not levelled: it is the build that was played, and `r` stays its ratio.
  - Results carry the real pieces (the solver maps them back when it reports), so cards show
    their real levels; a piece the run levelled shows "+4→20" (not for any-pieces members, whose
    stats don't matter). Margins assume levelling.
  - `LineupSolverRequest.levelToMax`, optional (absent: off), so debug exports stay version 3;
    part of the job signature. The replay's `--level-to-max` turns it on.
- **Advice for every team** of the lineup shown, weakest first, each with the other teams'
  pieces reserved. Abyss chambers advise both halves.
- **Gains under the tie**: a slot's best option is listed when it can beat the tie (as before)
  or its expected gain is at least 0.1% (`LEVELLING_MIN_GAIN`). Options that cannot beat the tie
  are muted and show the chance of any gain (`gainChance`, P(gain > 0)) in place of the chance
  to beat the tie. Ranking is unchanged.
- **Margin readout**: the advice reports the team's damage on its real pieces, and "→ ×margin"
  scales the shown margin by that damage ÷ the candidate's. Without levelling the ratio is 1;
  with it, the base is the margin the team has before anything is levelled.
- **Lv 89 → 90, in the advisor only** (decided with the user, 2026-10-21): the rest of the app
  keeps scoring a character at its level's tier (70/80/90/95/100), so an 89 counts as 90.
  - A member whose account level is below the level it is scored at, and above 70, gets the
    step "account level → scored level", with gain = damage at the scored level ÷ damage at the
    account level − 1. Its chip says the margins already count the higher level. Other members
    get the next tier as before. Levels up to 70 have no tier below to interpolate from.
  - To score an off-tier level, the damage core takes any level from 70 to 100:
    `resolveCharacterStats` interpolates HP/ATK/DEF from the tier below with its ascension
    phase's slope, and takes the ascension stat from the tier below. Growth curves are linear
    within a phase (checked against GO's `expCurve.json`), so 81–89 and 91–99 are exact. The 70
    and 80 rows straddle an ascension, so 71–79 use the 80 → 90 slope (≤1% of the step off).
    Reaction level multipliers cover levels 1–100 (GO's
    `transformativeReactionLevelMultipliers`).
  - Callers outside the damage core that pass account levels (Score-up's idle stat sheet, the
    CR budget) round to the tier themselves, so their numbers do not change. Team configs
    already round.

Tests: an expected levelled piece against the mean of the roll distribution; a run with
`levelToMax` that wears unlevelled pieces and reports them at their real level; sub-tie options
listed with their gain chance; the off-tier step; an off-tier level's base stats between the
tiers; advice requests for every team of the lineup.

## P5 follow-ups as built (2026-10-21)

- **Level artifacts to max**: `expectedLevelledPiece` (`levelling.ts`); `levelledAccount` and
  `withRealPieces` in `lineupSolver.ts`. The Stygian and Abyss settings rows share
  `RunOptionToggle` (`LineupResults.tsx`), which replaced `KeepersToggle`; `CandidateDetail`
  takes `levelled` for the "+4→20" labels.
- **Every team**: `LevellingAdvice.tsx` renders one `TeamAdvice` per candidate, each with its
  own request. `LevellingAdvice.damage` gives the "as is" margin.
- **Under the tie**: `LevellingPiece.gainChance`, `beatsTie` and `LEVELLING_MIN_GAIN`.
- **Lv 89 → 90**: `LevellingInput.accountLevels` and `LevellingStep.assumed`;
  `offTierLevelStats` in `domain/reference/stats.ts`, the full `LEVEL_MULTIPLIERS` table in
  `damageFormula.ts`. `ScoreUpCard` and `maxCrBuff` round to the tier.
- **Found while measuring, fixed**: diversify compared candidates by exact pieces only. A member
  that takes any pieces carries no exact pieces, but the MILP bounds its set's slots
  (`setSlotCounts`). In the levelled run, the weakest-first chain kept Mizuki's team with Lan Yan
  (any pieces, VV) as it was, wearing the account's only VV flower, which Lunar's Sucrose also
  wore. The chain's lineup could not be fielded, and the plan gave Sucrose to the Mizuki team.
  `findContestedGear` now also reports `setSlotKeys` (`overusedSetSlots` in `candidates.ts`), and
  `keepClear` and the pairwise fixes re-run on them.
- **Measured** on the Stygian export of 2026-10-21 12:01 at 30 s per team, in Node with other jobs
  on the machine (commit hooks, a browser run), so times are high:

  | Run | Lunar | Mizuki | Sandrone | Time |
  |---|---|---|---|---|
  | Pieces as they are, before and after the set-slot fix | ×0.528 | ×0.872 (Lan Yan) | ×0.914 | 283–557 s |
  | Level artifacts to max, before the fix | ×0.489 (Linnea, Xiangling) | ×1.254 (Sucrose) | ×1.255 | 296–318 s |
  | Level artifacts to max, with the fix | ×0.576 | ×1.096 (Lan Yan) | ×1.255 | 328 s |

  - Alone, the levelled Lunar team reaches ×0.584 (×0.528 as is). The levelled plan is ×0.340,
    ×0.743 and ×0.826 on the pieces as they are. Its Lunar team plans on Ineffa's +0 Gladiator CR
    circlet and +4 Aubade goblet; the advice ranks them first (100%, +22.3% and +11.6% expected
    from as is).
  - Advice on the exported plan, without a re-run: the Lunar team now lists 11 slots, all under the
    tie (best: Sucrose's +4 EM sands, a certain +1.4%). Ineffa Lv 89 → 90 is +0.7% and Columbina
    +0.3%, already in the margins. Mizuki's +0 4★ Instructor EM circlet and goblet: 100%, +3.7%
    each. Yae's +0 Wanderer's ATK% sands: 100%, +8.3%. 0.7–1.3 s per team.
- **Browser** (dev server, headless Chromium; the export's account, teams and clears seeded
  through the stores; 30 s per team with Level artifacts to max): run and advice for all three
  teams took 301 s. Lunar ×0.57, Mizuki ×1.08, Sandrone ×1.19 (worker path, so not the Node
  numbers). The cards showed 41 "+N→max" labels; the advice showed three teams with their as-is
  margins, 21 muted rows and two Lv 89 → 90 steps marked as already in the margins. No
  horizontal scroll at 375 px. English only.
- **Open**:
  - The levelled plan at the user's 20 min per team, in the browser.
  - An any-pieces member's set slots are the ones it was scored with. The re-run frees them in
    diversify, but the MILP bound stays per slot, so a member that could take its set in other
    slots still counts against those.
  - Margins of a levelled run are means; the advice gives each piece's spread, one at a time.
  - Outside the advisor, Lv 89 still counts as 90 (decided with the user).

## P4 comparison (2026-10-21)

The question from testing: does building the boss-by-boss lineup weakest boss first or strongest
first make a difference, and does the joint plan need both?

- **Trace**: diversify records each pass per encounter group in `trace.diversify`
  (`LineupDiversifyTrace`): the weakest-first and strongest-first lineups in pick order, and
  the candidates each pass's re-runs and weapon swaps gave, including ones an earlier pass had
  found; the pairwise fixes are one more pass. The field is new in debug export version 3; the
  replay reads older exports as having none.
- **Replay**: `tests/benchmark/lineupReplay.ts --diversify` prints each boss-by-boss lineup's
  margins and floor (the study's "sequential with set search", both orders) beside the joint
  leximin plan, then plans again without the candidates only one pass found. Run until done
  (`--budget-sec 0`), runs are deterministic and the pairwise fixes are picked before the chains,
  so dropping strongest-first matches a run without it; strongest-first can pick what
  weakest-first found, so dropping weakest-first alone is approximate.

Measured on the Stygian export of 2026-10-21 12:01, replayed until done in Node (1,092 s; three
replays ran in parallel). Margins, weakest first:

| Setup | Lunar (Guardian) | Mizuki (Overseer) | Sandrone (Sculptor) | Floor |
|---|---|---|---|---|
| Sequential with set search, strongest first (Sandrone, Mizuki, Lunar) | ×0.508 | ×0.712 | ×1.266 | ×0.508 |
| Sequential with set search, weakest first (Lunar, Mizuki, Sandrone) | ×0.528 | ×0.872 | ×0.914 | ×0.528 |
| Joint leximin, every pass | ×0.528 | ×0.872 | ×0.914 | ×0.528 |
| Joint, without strongest-first, or without the pairwise fixes | same | same | same | ×0.528 |
| Joint, without weakest-first (approximate) | ×0.508 | ×0.712 | ×1.266 | ×0.508 |
| Joint, pairwise fixes only, or no diversify | ×0.401 (Fischl, Bennett) | ×0.750 | ×1.000 | ×0.401 |

- **Order matters, a little, and weakest first wins.** Strongest first gives the strongest boss
  its unconstrained best (×1.266, worth nothing to the floor) and leaves Lunar the leftovers:
  −3.8% on the floor, just past the 3% tie, and −18% on the second-weakest team.
- **The joint plan is the weakest-first lineup exactly.** On this export, the study's (3) equals
  (4) and (5): leximin over the found candidates adds nothing to weakest-first sequential with
  set search. The strongest-first chain and the pairwise fixes add nothing either.
- **The re-runs are what matter, not the MILP.** Without the chains' re-runs, the best lineup
  the MILP can field from per-team candidates drops to ×0.401: every strong Lunar build shares
  Sucrose or her pieces with another team. The MILP only selects among found candidates; it does
  not search jointly.
- **Cost**: the strongest-first chain's two re-runs took 16 s of optimizer time, of 920 s over
  79 runs. Keeping it is cheap insurance for an export where it does find something.
- **A re-run optimizes one assignment**: the screen's best by account estimate. The same team
  re-run in two replays that saw different screens came out ×0.914 and ×0.870 (Sandrone), and
  ×0.872 and ×0.889 (Mizuki), on builds whose value did not change between the replays (see
  "Buff uptime"). The second- and third-weakest margins carry that noise.
- **P4 on one export**: (4) − (3) is zero, well inside model error, which meets the gate's stop
  condition. Whether one export decides it is the user's call. Not checked: the study's (1) and
  (2) without set search, other exports, and Abyss.
- **Open**: re-run the top two or three screened assignments in `keepClear` rather than one, to
  take the noise out of later picks.

## Buff uptime (experiment and design, 2026-10-21)

The question from testing: Instructor's 4pc (team EM +120 for 8 s after the wearer triggers a
reaction) counts on every hit of the rotation, though a support that triggers it once per 16–20 s
rotation covers 40–50% of it. Does that skew the lineup?

- **Every timed buff counts at 100%.** No buff carries a duration. Instructor, Noblesse (12 s
  after a Burst), Tenacity (3 s after a Skill hit), VV's shred, Heart of the Furnace and the rest
  apply to every hit, whether the wearer triggers them once or all the time.
- **Margins are ratios to the recorded build**, so an overstated buff cancels only when a
  candidate and the recorded build wear the same timed sets on the same kind of member. The
  12:01 export's recorded Sandrone build wears Noblesse (Alyosha) and Tenacity (Diona); the
  recorded Mizuki build wears Tenacity (Cryo Traveler).

Experiment, worktree only (not committed): the 12:01 export's 82 candidates rescored on their own
pieces with a set's static team buffs scaled by an uptime, as ratios to the rescored recorded
build. Scaling the stat stands in for the mixture (by Jensen it values a partial buff slightly
higher than `u · with + (1 − u) · without` would).

| Variant | Sandrone best | Mizuki best | Lunar best (floor) | Plan's Mizuki team |
|---|---|---|---|---|
| As now | ×1.266, Diona in Instructor | ×1.119, Mizuki in Instructor | ×0.528 | ×0.872 |
| Instructor 45% on every wearer | ×1.221, Diona in Tenacity | ×1.067 | ×0.528 | ×0.835 |
| Instructor 45%, Mizuki 100% | ×1.221, Diona in Tenacity | ×1.119 | ×0.528 | ×0.872 |
| Instructor 44%, Noblesse 67%, Tenacity 33% (≈ duration ÷ 18 s), Mizuki 100% | ×1.253, Diona in Instructor | ×1.157 | ×0.528 | ×0.902 |

- Instructor at full uptime is worth 4–5% of team damage where it is worn, just above the 3% tie.
- **Scaling Instructor alone misleads**: Diona moves to Tenacity, whose 3 s buff is overstated
  more. Scaled together, Diona keeps Instructor and the top Sandrone builds reshuffle within 1%.
- Mizuki wears Instructor herself and swirls on field, so her uptime is likely near full; her
  team keeps Mizuki in Instructor in every variant.
- The floor team (Lunar: Aubade, VV, Silken Moon) wears none of the three, so the floor does not
  move. Its own timed sets (VV's shred, Silken Moon) were not scaled.

### Using rotation length

The engine already prices partial uptime: a `BuffActivationMap` gives each formula part the hits a
buff covers, `buildStatVariants` cuts the part there, and the activation reaches the set screen,
the account estimate and the optimizer's compiled formulas through `buildBuffOverrides`. A buff
up a share `u` of the rotation is `u · hits` on every part it applies to, which is exact when
damage is spread evenly (the RES phases' assumption). What is missing:

1. **Durations**: no buff carries one.
2. **How often the wearer re-triggers.** Rotation length alone gives `min(1, d ÷ R)` only for a
   trigger the wearer fires once per rotation. An on-field driver (Mizuki) or an off-field
   applicator (Xiangling's Pyronado, Fischl's Oz) refreshes Instructor throughout.
3. **Rotation seconds**: none of the export's three teams has one saved (Analysis' DPS input).
4. **Overrides follow the wearer.** A buff override's key includes the provider, so "Instructor
   on Diona at 45%" stops applying when the solver moves Instructor to Layla, which then looks
   better than Diona.

Recommended (needs the user's decision before any code):

- An uptime per timed **set** effect per team, keyed by set id so it follows the set to any
  wearer and applies to the recorded build too. It defaults to 100%, or to `min(1, triggers · d
  ÷ R)` when the team has rotation seconds and the wearer's rotation lines fire the trigger a
  countable number of times (casts of E or Q); a wearer with on-field or ticking lines stays at
  100%. Editable in the template.
- Durations for the timed team sets first (Instructor, Noblesse, Tenacity, VV, Deepwood,
  Archaic Petra, Scroll of the Hero of Cinder City, Silken Moon, Heart of the Furnace, Scarlet
  Proof, …), checked against game text. Character and weapon buffs are the same across a
  template's candidates and mostly cancel in `r`; they can follow.
- This changes damage numbers everywhere a team has rotation seconds, not only in lineups, so
  whether Analysis shows it too is part of the decision.

Replays until done with only Instructor scaled to 45% (every wearer, and every wearer but
Mizuki), beside the baseline of "P4 comparison":

- The plan and its floor are unchanged: Lunar ×0.528, built weakest first in both; strongest
  first gives ×0.507.
- The Mizuki team's re-run picks Mizuki in EM 2+2, Odette in Heart of the Furnace (×0.889, r
  ×1.186) in both variants, over the baseline's Mizuki in Instructor (×0.872, r ×1.163). That
  build wears no Instructor 4pc, so it is worth ×0.889 in the baseline too, where the re-run
  never tried it. Re-run screens are not traced; the likely reason is that full-uptime
  Instructor variants filled the shortlist. It wins in the Mizuki-at-100% variant too, so the
  crowding came from the other members' Instructor variants, not Mizuki's own.
- The Sandrone team's re-run drops from ×0.914 to ×0.870 (Yae in Disenchantment instead of
  2+2); neither build wears Instructor. That is the re-run's one-assignment pick, not uptime.
- Without the chains' re-runs, neither variant fields a full lineup (the baseline: ×0.401).

So the hunch holds in a weaker form: full-uptime Instructor does not move this floor, but it
crowds the set screen enough to hide builds within the 3% tie.

### Decision: set uptime from rotation length (2026-10-21)

The user accepted the recommendation above, with Analysis showing the same numbers as lineups.

- **Durations** live on the buff: `BuffSource.duration` (seconds after the trigger), checked against
  the 4pc text in `src/generated/catalog/artifact_en.json`. First batch, team buffs only:
  Instructor 8 s, Noblesse 12 s, Tenacity 3 s, VV's RES shred 10 s, Deepwood 8 s, Archaic Petra
  10 s, Scroll of the Hero of Cinder City 15 s (Nightsoul part 20 s), Silken Moon's Serenade 8 s,
  Celestial Gift 20 s. Self buffs (Heart of the Furnace's ATK, Scarlet Proof) and character or
  weapon buffs can follow.
- **One uptime per set per team**, stored as `damage.setUptimes[setId]` (a share, 0–1). Keyed by
  set id, it follows the set to any wearer and applies to the recorded build too. Absent means the
  derived default.
- **Derived default** (`src/domain/combat/damage/core/setUptime.ts`): 100% without
  `rotationSeconds`. With it, 100% when the wearer has an on-field Normal, Charged or Plunge line
  (a driver) or an off-field line (an applicator that refreshes throughout). Otherwise
  `min(1, casts · duration ÷ rotationSeconds)`, where casts are the wearer's line counts on the
  abilities the trigger names (E → Skill, Q → Burst, anything else → both), and at least 1: a
  support whose Burst deals no counted damage still casts it.
- **Pricing**: a buff at uptime `u` activates `u · hits` on every part it can reach, on top of
  stack-limit defaults and under the per-part activations a user sets in the buff dialog. The
  existing activation path carries it to Analysis, the set screen, the account estimate and the
  optimizer.
- **Edited** next to Rotation (s) in Analysis' damage card and in the lineup template, showing the
  default until overridden.
- **Persistence**: rotation seconds become a calculation input (`teamCalculationInputs` keeps it),
  so changing them clears cached results. Team store v26 and cloud v8 add the optional field (no
  transform; absent keeps the default). The result cache moves to v8 and is cleared, because
  results cached for a team with rotation seconds were priced at full uptime.

#### As built (2026-10-21)

- Durations on nine sets' team buffs in `impl/artifact4pc.ts`. Scroll's buff merges the 12% (15 s)
  and Nightsoul 28% (20 s) parts into one value, so it takes 20 s when the wearer is Nightsoul,
  slightly overstating the 12% part.
- `core/setUptime.ts` derives defaults and per-line activations; `TeamBuild` layers them between
  stack-limit defaults and user activations in `computeComboPartialBuffSpecs` and
  `getComboFormulaDefaults`, so the buff dialog's sliders start from the priced uptime.
- Callers pass `teamSetUptimes(damage)`: Analysis' workspace, the investment analyzer (which now
  computes activations when any build has a timed buff, not only stack-limited ones), the set
  screen, the set explorer's optimization and the lineup's recorded-build score.
- UI: `SetUptimeFields` beside the enemy fields on each of the damage card's three tabs, and under
  Rotation in each lineup template (sets the team wears, plus any with a saved share). The
  placeholder is the default; clearing restores it.
- `teamCalculationInputs` is gone: every setup change now clears the team's cached results.
- Tests: `tests/domain/combat/damage/setUptime.test.ts` (defaults; half uptime prices exactly the
  mean of on and off), `tests/stores/migration/teamDamageV26.test.ts` (v25 hydration, invalid
  shares, cloud v7 → v8), result cache v7 → v8 clear. `npm run check` passes.
- Not measured: a lineup replay. The 12:01 export's teams have no rotation seconds, so their
  numbers do not change until a rotation length or share is entered.
- Follow-ups: self timed buffs (Heart of the Furnace's ATK, Scarlet Proof), character and weapon
  durations, and a second wearer of the same set (one share per set; `noStackId` already keeps
  one buff).

## P4 comparison, second export (2026-10-21)

The Stygian export of 2026-10-21 18:20, read from its own diversify trace (`lineupReplay.ts
--no-run --diversify`; the run finished inside its 1,200 s budget, 76 runs, 79 candidates). Its
teams now have rotation seconds (20 s each) and set shares entered by hand: Sandrone's team
Noblesse and Instructor 40%, Mizuki's VV and Tenacity 60%, Lunar's VV 60% and Silken Moon 100%.
The recorded clears give the recorded builds ×1.000 (Sandrone), ×0.750 (Mizuki) and ×0.500
(Lunar). Margins:

| Setup | Lunar (10123) | Mizuki (10013) | Sandrone (10121) | Floor |
|---|---|---|---|---|
| Sequential with set search, weakest first | ×0.712 (Sucrose, Cryo Traveler) | none | — | incomplete |
| Sequential with set search, strongest first | ×0.513 | ×1.195 | ×1.411 | ×0.513 |
| Joint leximin, every pass (the exported plan) | ×0.542 (Linnea, Xiangling) | ×0.731 (Diona) | ×1.198 (Layla) | ×0.542 |
| Joint, without either chain | same | same | same | ×0.542 |
| Joint, without the pairwise fixes | ×0.513 | ×1.195 | ×1.411 | ×0.513 |
| Joint, no diversify | | | | no lineup |
| Least shortfall (the export's second plan) | ×0.513 | ×1.195 | ×1.411 | ×0.513 |

- **Weakest first fails on characters, not gear.** Lunar's best build takes Sucrose and Cryo
  Traveler, and every Mizuki candidate has one of them. The chain reserves only characters that
  are in *every* candidate of a later boss (Mizuki, Odette), so it cannot see that the pick
  leaves Mizuki nothing.
- **The joint plan beats the best sequential lineup by 5.6% on the floor**, past the 3% tie, so
  this export does not meet the gate's stop condition. The gain comes from the MILP fielding a
  searched Lunar build (Linnea, Xiangling) that no chain kept, beside a pairwise-fix Sandrone
  re-run. Without the pairwise fixes the joint plan is the strongest-first lineup.
- **The floor costs Mizuki her clear.** Lunar ×0.542 keeps two pieces Mizuki's Cryo Traveler
  builds use (Ineffa's Aubade ATK% sands and goblet), so Mizuki falls to Diona, ×1.195 → ×0.731:
  two bosses short instead of one, for 5.6% on a boss that needs 1.85× its damage either way.
- **The candidate that would beat both plans was never run**: Mizuki with Cryo Traveler cleared
  of the ×0.542 Lunar build's pieces. Strongest first clears the other way (Lunar of Mizuki,
  ×0.542 → ×0.513), and the pairwise fixes spend their four re-runs
  (`LINEUP_MAX_DIVERSIFY_RUNS`) on the pairs whose weaker team is strongest, which are all
  Sandrone ↔ Mizuki; no Lunar pair gets one.
- **Reading for the gate**: the joint plan wins here because the chain's character reservation is
  too narrow, not because jointly packed candidates beat sequential set search. A weakest-first
  chain that keeps every later boss at least one character-free candidate would pick the Linnea,
  Xiangling Lunar build first and then try that Mizuki re-run. Not measured: that chain, and a
  replay until done.

## P4 comparison, 2026-10-22 exports

Two more Stygian runs, read from their diversify traces as above. Both finished inside the
1,200 s budget. The 19:06 export is the 18:52 run exported again (same request, result and
plan).

**11:35** (one team per boss: Lunar-Stellar, Mizuki Faruzan, Sandrone No Odette; 78 runs, 81
candidates). Both chains build the same lineup in opposite orders, and the joint plan is that
lineup: Mizuki Faruzan ×0.749 (searched), Sandrone ×1.053 and Lunar-Stellar ×1.249 (both
weakest-first re-runs). Joint − sequential = 0. Without weakest-first, or with the pairwise
fixes only, the plan falls to the three recorded builds (floor ×0.500): every searched
Sandrone and Lunar build collides with another team.

**12:16** (the 11:35 setup with Sucrose added as Mizuki Faruzan's third-slot flex; 78 runs, 81
candidates). Same result shape: both chains and the joint plan give one lineup, Mizuki with
Sucrose ×0.776 (searched; her best Faruzan build is still ×0.749), Sandrone ×1.054 and
Lunar-Stellar ×1.266 (weakest-first re-runs). Joint − sequential = 0, and without weakest-first
or with the pairwise fixes only, the floor falls to the recorded builds' ×0.500 again.

**18:52** (five teams with six calibrations: Sandrone No Odette on bosses 10121 and 10123,
Lunar-Stellar on 10121, Mizuki best and Stellar Swirl Faruzan on 10013, Lunar flex on 10123;
148 runs, 154 candidates). So the plan also chooses which team fights which boss.

| Setup | 10121 | 10013 | 10123 | Floor |
|---|---|---|---|---|
| Sequential, weakest first | — | Mizuki best ×1.195 | Sandrone ×1.222 | incomplete |
| Sequential, strongest first | Sandrone ×1.409 | Mizuki best ×1.195 | Lunar flex ×0.513 | ×0.513 |
| Joint leximin (the exported plan) | Sandrone ×1.222 | Faruzan ×0.610 | Lunar flex ×0.584 (Sucrose, Xiangling) | ×0.584 |
| Joint, without the pairwise fixes | | | | ×0.513 |
| Joint, no diversify | Lunar-Stellar ×0.923 | Faruzan ×0.480 | Sandrone ×0.828 | ×0.480 |
| Least shortfall (second plan) | Sandrone ×1.222 | Mizuki best ×1.128 | Lunar flex ×0.542 (Linnea, Xiangling) | ×0.542 |

- **Weakest first fails again, on its order.** It ranks bosses by their best candidate, so
  10123 (best ×1.222, Sandrone) goes first and takes Sandrone, the strongest team of 10121.
  10121's other team, Lunar-Stellar, needs Sucrose or Cryo Traveler, whom Mizuki best has
  taken. Reserving only characters in every candidate of a later boss reserves nothing when two
  templates share no character.
- **The joint plan beats the best sequential lineup by 13.8%**, and here the MILP does work no
  chain does: it moves Mizuki to the Faruzan team so Lunar flex can take Sucrose, and it sends
  Sandrone to 10121. That also needs the pairwise-fix Sandrone re-run (without the fixes, the
  plan is strongest first).
- **Leximin again trades a clear for the floor**: Mizuki ×1.128 → ×0.610 (two bosses short
  instead of one) for +7.7% on Lunar, which needs 1.7× its damage either way. Same pattern as
  the 18:20 export.

**Gate reading over the five exports** (12:01, 18:20, 11:35, 12:16, 18:52): joint = sequential on three;
joint wins by 5.6% and 13.8% on two, each time where the weakest-first chain did not finish.
With alternative teams per boss (18:52), the choice of which team goes where is a packing
problem a single chain order does not solve, so the multi-team work does not stop at the gate.
Open: whether the lead plan should stay leximin when the floor is far below ×1, given that
twice the least-shortfall plan clears one more boss.

## Run viewer (design, 2026-10-22)

The question from testing: a finished run disappears as soon as an input changes, so comparing
runs meant screenshots. The debug export already holds everything the results show (the request
with its account, teams and clears, the candidates with margins, and the plan).

- **Open debug file**, next to Export debug file in each section, reads an export back and shows
  it in place of the section's results until **Close** or Find lineups. Nothing is saved: the
  file is the record, so there is no store, schema version or migration.
- The shown run comes entirely from the file: encounters, recorded clears, team names, the
  account's pieces (for members that take any pieces), Level to max, candidates and margins.
  The plan and levelling advice are worked out again from it, as for a live run. The encounter
  and template editors above keep showing the current setup.
- While a file is shown, the run settings and Export are hidden and a line says which run it is.
  Find lineups runs the current setup and closes the file.
- `readLineupDebugExport` in `domain/combat/lineup/debugExport.ts` is the one reader, for the page
  and `tests/benchmark/lineupReplay.ts`. It returns the run, or why the file cannot be read
  (not an export, or an unsupported version), and fills what older versions lack (v2: no RES
  phases; before v3: no diversify trace).
- A file from the other mode is refused with a pointer to its section.
- Not done: keeping runs across reloads (results are about 1.5 MB, too large for localStorage
  beside the other stores), and comparing two runs side by side.

### As built (2026-10-22)

- `readLineupDebugExport` returns `LineupDebugRead` (`run`, `not-export`, `unsupported-version`);
  the replay script reads through it.
- `useLineupSolver.ts` keeps the viewed run per mode beside the jobs (`viewLineupRun`,
  `closeLineupRun`, `useViewedLineupRun`); starting a job closes it.
- `useLineupJob` returns the file's encounters, clears, request, candidates, pieces, Level to
  max and team names while one is open (`viewedAt`), and the live request for Find lineups. Team
  names moved into the job (`job.names`), since a file's teams may no longer exist.
- `LineupRunControls`: Open debug file beside Export; while a file is open, a line with its
  export time and Close replaces the settings, and Export is hidden. A file that cannot be read
  says why in a toast.
- Tests: `tests/domain/combat/lineup/debugExport.test.ts` (round trip, not an export, version,
  v2 fill-ins); `StygianLineup.test.tsx` opens an exported run after the teams are deleted and
  shows the file's team names, closes it, and refuses a GOOD file. Not checked in a browser.

## Chain ranking, weakest first, least shortfall first (2026-10-22/23)

Decided with the user after the five P4 exports.

- **Ranking bug.** Diversify ranked candidates by margins computed once, before the chains. A
  re-run found on the way had none and fell back to its damage ratio, which runs on a higher
  scale (×1.477 against margins near ×1.35 on the 12:16 export). Strongest first therefore
  picked weakest first's Lunar re-run over a stronger searched build and copied weakest first's
  lineup, so "joint without weakest-first" on 11:35 and 12:16 measured nothing.
  `candidateStrength` (`domain/combat/lineup/candidates.ts`) now gives every candidate its margin
  when first ranked.
- **Dropping weakest first was tried and reverted.** With the ranking fixed and weakest first
  removed, the user's 20:31 export (inputs identical to 12:16) fell from ×0.776 to ×0.665:
  strongest first builds Lunar-Stellar (×1.351) and Sandrone first, and the floor team, Mizuki,
  is re-run last without both teams' pieces. Weakest first is what gives the floor its best
  build.
- **Weakest first's failures were its character picks**, on 18:20 and 18:52 (see the P4
  sections). A pick used to reserve only characters in *every* candidate of a later boss. Now
  both chains pick the strongest candidate that leaves the later bosses a candidate each with no
  character twice (a search over each boss's distinct rosters), and fall back to the strongest
  free one. Gear is still cleared by the re-runs. On the exported candidates, before re-runs,
  weakest first now completes on all three exports: 18:20 Lunar flex ×0.607 (Linnea, Cryo
  Traveler), Mizuki ×0.731, Sandrone ×1.402; 18:52 Sandrone on 10123 ×1.222, Faruzan ×0.747,
  Lunar-Stellar on 10121 ×1.047, a team-to-boss assignment no pass tried before.
- **Least shortfall leads when a boss falls short.** A clear needs every gap closed, and on 18:20
  and 18:52 the least-shortfall plan left one team short where leximin left two. Leximin stays
  the only plan when it clears every boss, and is listed second otherwise; Hardest to lose still
  belongs to it. The leximin plan is labelled "Strongest weakest boss" (保底最高), since it is no
  longer always the lineup shown first. The user's 05:09 export (the 18:52 setup) shows it:
  least shortfall ×0.542 first, leximin ×0.584 second.

### Measured (2026-10-23)

Node replays with each export's own time budget (`lineupReplay.ts --diversify`), and the user's
browser run 06:05 (inputs identical to 12:16):

| Export | Weakest first | Strongest first | Joint leximin | Leads |
|---|---|---|---|---|
| 12:16 (and browser 06:05) | ×0.776 | ×0.665 | ×0.776 | leximin (no shortfall plan) |
| 18:20 | ×0.607 (was incomplete) | ×0.513 | ×0.607 (was ×0.542) | least shortfall ×0.513 |
| 18:52 | ×0.707 (was incomplete), Sandrone on 10123, Lunar-Stellar on 10121 | ×0.513 | ×0.584 | least shortfall ×0.542 |

- 12:16: the replay matches the browser run exactly. Without weakest first the floor is ×0.665.
- 18:20: +12% on the floor, all from the weakest-first chain (without it, ×0.542).
- 18:52: the weakest-first lineup reaches ×0.707, but the joint plan stays at ×0.584, which
  leximin could not do if that lineup fit within the MILP's limits. The chain and the MILP
  disagree on some piece, set slot or weapon copy; being traced (replay with `--dump`).
