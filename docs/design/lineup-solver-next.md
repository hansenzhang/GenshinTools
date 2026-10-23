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

## 1. Chain lineups that do not fit (do first)

On the 18:52 export the weakest-first chain reports a lineup with floor ×0.707 (Sandrone on
10123, Stellar Swirl Faruzan on 10013, Lunar-Stellar on 10121), yet the joint plan's best floor
is ×0.584. Leximin cannot score below a lineup that fits, so the chain's lineup breaks a limit
the MILP enforces.

- **Hypothesis**: a re-run (`rerunWithout`) excludes only the other teams' exact pieces
  (`candidateArtifactIds` leaves out members that take any pieces of their set), and `keepClear`
  re-checks only weapon copies afterwards. So a cleared re-run can still overuse a set's slots
  (`setSlotCounts`), for example several Instructor "any pieces" wearers on a few circlets.
- **Evidence**: replay of 18:52 with `--dump` (running at the time of writing); check the chain's
  three candidates with `canFieldTogether` and `findContestedGear` including set slots.
- **Acceptance**:
  - A chain records a lineup only if its candidates fit together under the same limits as the
    MILP (pieces, weapon copies, set slots); otherwise it reports the chain incomplete.
  - Where possible the re-run leaves the other teams' set-slot needs free instead of failing.
  - A test where two members take any pieces of one set with too few slots for both.
  - Replay of 18:52: the joint floor is at least the weakest-first floor, both recorded here.
- **Payoff**: if the swapped assignment fits once cleared, 18:52's floor could rise from ×0.584
  towards ×0.7 (+21%), the largest gain left.

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
