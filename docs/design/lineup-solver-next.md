# Lineup solver: next steps

Status: brief, 2026-10-23. Follows `docs/design/lineup-solver.md`, which holds the design, the
phases P0–P5 as built and every measurement up to "P4 conclusion". New work and its results go
here, so that document stops growing.

## Where things stand

- **P4 is decided: keep the multi-team work, but stop extending the joint search.** Across six
  Stygian exports (2026-10-21 to 23), the gain comes from the diversify passes' re-runs, which
  make builds that keep clear of other teams' gear. Without them the plan falls to the recorded
  builds or fields no lineup (×0.500, ×0.480, none). The MILP only selects among found
  candidates; it earns its place by choosing the team-to-boss assignment and combining builds
  from different passes, not by searching.
- **Both boss-by-boss chains stay.** Weakest first gives the floor team its best build: without
  it the floor fell from ×0.776 to ×0.665 (user's 20:31 vs 06:05, identical inputs). With picks
  that leave every later boss a candidate (2026-10-23), it also lifted 18:20 from ×0.542 to
  ×0.607.
- **Least shortfall leads when no lineup clears**, since a clear needs every gap closed.
- **The solver is not what stands between these teams and a clear.** The weakest teams sit at
  ×0.54–0.78 (30–85% short); the best lineup moves the floor by 5–20%. Levelling advice for the
  short team and better gear matter more than more solver work.

## Decision: continuous set uptime (2026-10-23)

The question: every team in the 06:05 export wears Instructor. The cause was the default uptime
of `core/setUptime.ts` combined with the hand-entered shares. Rebuilt from that export:
Instructor on Sucrose, Diona and Ineffa took the default, 100%, because each has an off-field
line. Instructor has no hand share in any team, while its rivals had one: Tenacity on Diona and
Noblesse on Alyosha at 0.5, and VV on Sucrose at 0.6. Two flaws in the default made it worse.
Layla, who has no line in the Mizuki rotation, got 18% Tenacity although her stars hit off-field
as Skill DMG. Noblesse on Alyosha got 100% because her Burst's two lines counted as two casts.

The user accepted these rules:

- **Continuous at 80%.** An effect fired by hits or reactions (Instructor, Tenacity, VV, Deepwood,
  Silken Moon, Scroll, Petra) is up 80% when its wearer drives (an on-field Normal, Charged or
  Plunge line) or has an off-field Skill formula in their kit, whether or not the rotation lists
  it. This assumes the holder has an off-field skill to fire it with: Layla, Cryo Traveler,
  Columbina, Diona (with Stellar-Conduct), Ineffa and Linnea count. 80% leaves room for gaps
  between refreshes and swaps.
- **An off-field Burst is one window, not continuous** (amended the same day). Sucrose's vortex
  swirls off-field, but after it only her Skill fires VV or Instructor again, which takes a
  double swap that lengthens the rotation and is not always worth it. Alyosha's field is the
  same case.
- **Cast-fired effects never take the continuous shortcut.** `BuffSource.castTrigger` marks
  effects that start when an ability is used, not when it hits: Noblesse (Burst) and Celestial
  Gift (Skill).
- **One window otherwise:** `duration ÷ rotation`. Casts are not counted from lines. Lines count
  hits (Alyosha's Burst has two, which priced Noblesse at 100%), and a support's second cast
  assumes a second swap.
- **No hand shares.** The user drops their shares and lets the defaults price every set alike;
  the replay below strips them from the export. Overrides stay available in the UI.
- **Cache.** Priced numbers change, so cached results are cleared. The unpushed result-cache v8
  bump already does that, so there is no second bump; a local copy already on v8 needs its results
  recomputed once.

## 1. Chain lineups that do not fit (do first)

On the 18:52 export the weakest-first chain reports a lineup with floor ×0.707 (Sandrone on
10123, Stellar Swirl Faruzan on 10013, Lunar-Stellar on 10121), yet the joint plan's best floor
is ×0.584. Leximin cannot score below a lineup that fits, so the chain's lineup breaks a limit
the MILP enforces.

- **Hypothesis**: a re-run (`rerunWithout`) excludes only the other teams' exact pieces
  (`candidateArtifactIds` leaves out members that take any pieces of their set), and `keepClear`
  re-checks only weapon copies afterwards. So a cleared re-run can still overuse a set's slots
  (`setSlotCounts`), for example several Instructor "any pieces" wearers on a few circlets.
- **Evidence (confirmed 2026-10-23)**: replay of 18:52 with `--dump`. The chain's three
  candidates (104 Sandrone, 150 Faruzan, 151 Lunar-Stellar) share no piece, character or weapon
  copy, and `canFieldTogether` passes without set slots but fails with them: the account has one
  Viridescent Venerer flower, Faruzan takes any VV pieces in candidate 150, and Lunar-Stellar's
  re-run (151, cleared of 104 and 150's exact pieces) gives its VV wearer that flower
  (`viridescent_venerer:flower` 2 > 1). So ×0.707 was not a real lineup.
- **Fix to make**: when a re-run is cleared of another team, also exclude every piece of a set
  slot whose remaining count would not cover that team's any-pieces members; and after any
  re-run or swap, re-check pieces and set slots, not only weapon copies, returning no candidate
  (chain incomplete) if it still collides.
- **Acceptance**:
  - A chain records a lineup only if its candidates fit together under the same limits as the
    MILP (pieces, weapon copies, set slots); otherwise it reports the chain incomplete.
  - Where possible the re-run leaves the other teams' set-slot needs free instead of failing.
  - A test where two members take any pieces of one set with too few slots for both.
  - Replay of 18:52: the joint floor is at least the weakest-first floor, both recorded here.
- **Payoff**: likely. The swapped lineup's floor is Faruzan's ×0.707 unless Lunar-Stellar,
  re-run without that flower, falls below it; it has ×1.031 with the flower. Anything above
  ×0.584 beats today's plan (+21% at ×0.707).

## 2. Re-run more than one assignment (optional)

A re-run optimizes only the screen's top set assignment by account estimate. The same team
re-run in two replays came out ×0.914 and ×0.870 (Sandrone), and ×0.872 and ×0.889 (Mizuki), on
builds whose value had not changed ("P4 comparison", "Buff uptime"). The second- and
third-weakest margins carry that noise.

- **Change**: re-run the top two or three screened assignments in `keepClear` and keep the best.
- **Acceptance**: two replays of one export agree within the 3% tie on every chain pick; the
  extra optimizer time is measured and stated (re-runs are a small share today: 16 s of 920 s on
  the 12:01 export).
- **Skip if** the noise does not change which lineup is chosen on the user's exports.

## 3. P6 validation

Not started. Spot-check a few candidates per team against GO's site (it has Sandrone and
Linnea), and against gcsim where it has the characters. Acceptance: per team, the model's damage
ratio between two builds agrees with GO's within a stated tolerance, or the gap is explained.

## 4. Checks only the user can make

- **Run viewer** (Lineups › Open debug file, commit 43c5356c): open a few exports in the browser;
  the results, team names and levelling advice should match what the run showed.
- **Recorded clears**: the clears give round recorded margins (120, 160 and 240 s against a 120 s
  bar: ×1.00, ×0.75, ×0.50). Every margin scales from them, so they should be measured clears,
  not estimates.
- **Stygian rewards**: whether rewards come per boss or only for clearing all three. Least
  shortfall first is right either way, but per-boss rewards would argue for maximizing bosses
  cleared outright.

## Stop condition

After item 1 (and item 2 only if its noise changes picks), stop the multi-team solver work and
leave it to the levelling advisor (P5) and the user's gear. Out of scope unless a measurement
asks for it: joint search beyond selecting found candidates, price-based column generation,
LP-fitted bounds, and keeping run history across reloads (the viewer covers exported runs).
