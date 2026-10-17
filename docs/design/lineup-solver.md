# Lineup solver

Status: decisions and design, 2026-10-16. P1 is implemented as Build comparison › Team sets;
P0 and P2–P6 are not.
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
  That's minutes in a background job. Measure in P2 before tuning screening widths.
- **Calibration burden.** Assignments the user doesn't play need extra clears, or the model has
  to be trusted across bosses.

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
