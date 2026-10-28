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

### As built (2026-10-23)

Commits 9ecb7e73 (80% continuous, `castTrigger`) and 781a2e39 (off-field Burst and everyone else
at one window). Tests in `tests/domain/combat/damage/setUptime.test.ts`.

Replay of the 06:05 export with the hand shares stripped (`lineupReplay.ts`, 600 s per team,
1,454 s, 82 candidates):

| Boss | Exported (old default, hand shares) | Replay (new default, no shares) |
|---|---|---|
| 10121 Lunar-Stellar | ×1.266, Ineffa in Instructor | ×1.266, same build |
| 10013 Mizuki | ×0.776, Sucrose in Instructor, Layla in Noblesse | ×0.798, Sucrose in VV, Layla in Instructor |
| 10123 Sandrone | ×1.054, Diona in Instructor | ×1.026, Diona in Instructor |
| Floor | ×0.776 | ×0.798 |

- Instructor still sits on every team, but now on wearers who keep it up: Ineffa, Layla and
  Diona all hit off-field with their Skill and get 80%. Sucrose, at 47% for Instructor, moved to
  VV. Among all candidates, Sucrose wears VV in 22 and Instructor in 2.
- The floor change (+3%) is within replay noise (item 2), and two things changed at once (the
  rule and the dropped shares). So it shows the picks are plausible, not that the floor improved.
- Margins are ratios to the recorded build, which is now priced by the same rule (Diona's
  Tenacity at 80% instead of the 0.5 share). That is why Sandrone's margin moved on a similar
  build.
- Not checked: Analysis' damage card against the new defaults in the browser.

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

### As built (2026-10-23)

- `reservedSetSlotPieces` (`domain/combat/lineup/candidates.ts`): a re-run cleared of another
  team also leaves every piece of a set slot whose remaining count would not cover that team's
  members that take any pieces.
- `keepClear` re-checks pieces and set slots, not only weapon copies, after a re-run or swap, and
  returns no candidate if one still collides (the chain then stops short).
- Tests: `tests/domain/combat/lineup/candidates.test.ts` (a slot with a spare piece stays usable;
  the last pieces go to the other team; exact builds reserve nothing).
- Replays with each export's budget (`--diversify --dump`; margins are priced with 9ecb7e73's
  set uptimes, so they differ from earlier tables by a few percent). Every chain lineup now fits
  under the MILP's limits, and the joint floor equals the best chain's:

  | Export | Weakest first | Strongest first | Joint leximin | Before the fix |
  |---|---|---|---|---|
  | 18:52 | ×0.711 | ×0.531 | ×0.711 | ×0.584 (chain ×0.707 did not fit) |
  | 18:20 | ×0.610 | ×0.531 | ×0.610 (least shortfall ×0.531 leads) | ×0.607 |
  | 12:16 | ×0.796 | ×0.741 | ×0.796 | ×0.776 |

  On 18:52 the lineup is Sandrone on 10123 ×1.217, Stellar Swirl Faruzan ×0.711, Lunar-Stellar
  on 10121 ×0.974 (re-run without the VV flower). Without weakest first the floor is ×0.584.
  Run time: 3,967 s, 2,455 s and 2,210 s in Node, three in parallel.

## 1b. Say which missing pieces would raise the floor

Asked by the user (2026-10-23): when a lineup is blocked by a set slot, say so, since a piece a
member takes "any pieces" of only needs the right set and slot (a strongbox piece will do).

- **Why the plan cannot tell today**: a "+1 piece per set slot" re-plan over the 18:52 export's
  candidates (78 slots, 56 s) raises the floor for none. The build that needed a second VV
  flower was a re-run that item 1's fix now steers around the scarce slot, so no candidate
  records what one more piece would unlock.
- **Change**:
  - When a re-run collides with the other team only on set slots, keep it as a candidate (the
    plan cannot field it with today's counts), then re-run once more with the slot reserved, as
    item 1 does. One extra re-run, only in that case.
  - After a run, re-plan with one more piece in each set slot that a member taking any pieces
    needs, and list the slots that raise the weakest boss: "1 more Viridescent Venerer flower
    (any stats): weakest boss ×0.584 → ×0.707". Beside Hardest to lose, which removes items.
  - Slots only exact builds need are left out: a new piece would need the same stats.
- **Acceptance**: on the 18:52 setup the list names the VV flower with the floor it unlocks; the
  re-plans' time is measured and stated; a test where one more piece of a slot lets two any-piece
  members fit.

### As built (2026-10-23)

- `keepClear` re-runs clear of the other team's exact pieces first; a result that still collides
  on set slots stays a candidate, then a second re-run leaves those slots
  (`reservedSetSlotPieces`). One extra re-run, only on a set-slot collision.
- `planStygianRun` returns `missingPieces`: for each set slot a member taking any pieces needs
  (`anyPieceSetSlots`), the best weakest margin with one more piece, listed when it beats the
  current one past the tie. Lineups › Stygian lineup shows them as "One more piece" (再多一件)
  under either plan; exports from before list none.
- Tests: `stygianPlan.test.ts` (one more flower lifts ×1.1 to ×1.3 and is listed; four short
  slots list nothing), `StygianLineup.test.tsx` (the row and its owned count),
  `debugExport.test.ts` (older plans read with an empty list).
- 18:52 replay (2,979 s in Node, `--dump`): floor ×0.711, every chain lineup fits, and weakest
  first kept the colliding Lunar-Stellar build. The list is empty, correctly: one more VV flower
  lifts Lunar-Stellar from ×0.974 to ×0.982 and leaves the floor (Faruzan ×0.711) as it is, and
  no other of the 44 slots any-piece members need moves any boss. So on this account the VV
  flower is not worth farming. The whole plan, scan included, takes about 2 s on 157
  candidates.
- **Open**: the list counts the floor only, like Hardest to lose. A piece that lifts the
  second-weakest boss to a clear would not be listed; comparing the full leximin plan per slot
  catches it at about three times the solves (84 s for 44 slots in Node). Worth doing only if
  an export shows such a piece.

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

## Stale recorded builds (2026-10-28)

The 2026-10-27 19:11 Stygian export put the Lunar team at ×0.80 against a ×0.97 recorded clear
(124 s on 120 s). The clear was played with Linnea, but its saved build was captured on
2026-10-22 with Sucrose in the team, and swapping Linnea into the team did not change it. Every
candidate was measured against the Sucrose build: best Fischl r ×0.831, Linnea ×0.801. The
Mizuki team shows the same thing in reverse: its clear (150 s) saved Faruzan, the team now fields
Sucrose, and the plan credits it r ×1.58.

- A recorded clear whose saved members differ from the team's now shows a warning next to its
  "Save current build" button (`referenceMatchesTeam`, `domain/team/lineup.ts`). Gear changes
  are not flagged: the saved build should be the one played, not the current one.
- Fixed-HP boss events (the Sculptor's 1,000,000 per break, a share of HP per Guardian shield)
  cancel in `r` when every team sees the same number of them: `T_c = (H − F) ÷ DPS_c = T_meas ÷ r`.
  They change margins only if their count grows with the clear's length, or if they gate time
  (shield or HP floor), which is downtime. Neither explains this export.

## Stop condition

After items 1 and 1b (and item 2 only if its noise changes picks), stop the multi-team solver work and
leave it to the levelling advisor (P5) and the user's gear. Out of scope unless a measurement
asks for it: joint search beyond selecting found candidates, price-based column generation,
LP-fitted bounds, and keeping run history across reloads (the viewer covers exported runs).
