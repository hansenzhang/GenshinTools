// Screening widths and thresholds for the team set explorer.
// Measured costs are in docs/design/lineup-solver.md ("P1 measurements").

/** Best four-piece options kept per member after the personal screen. */
export const SET_SCREEN_TOP_FOUR_PIECE = 3;

/** Best two-plus-two options kept per member after the personal screen. */
export const SET_SCREEN_TOP_TWO_PLUS_TWO = 3;

/** Upper bound on joint assignments scored with fixed sheets (~1 ms each). */
export const SET_JOINT_ASSIGNMENT_CAP = 2401;

/** Top joint assignments re-scored with generated artifacts (~60 ms each). */
export const SET_GENERATED_REFINE_COUNT = 48;

/** Best choices per member on the account's own pieces, kept and re-scored. */
export const SET_SCREEN_TOP_ACCOUNT = 3;

/** Piece picks per account estimate: at the generated build, then again at
 *  the real pieces the first pick found. */
export const SET_ACCOUNT_ESTIMATE_PASSES = 2;

/** Re-picks that value a short stat more, for members short of ER or CR. */
export const SET_ACCOUNT_REQUIREMENT_RETRIES = 3;

/** Choices per member whose best assignment is always re-scored and listed. */
export const SET_WITNESS_CHOICES_PER_MEMBER = 4;

/** Assignments optimized on the real inventory, besides the current sets. */
export const SET_MAX_FINALISTS = 5;

export const SET_TIME_BUDGET_OPTIONS_SEC = [30, 60, 120, 240] as const;

export const SET_DEFAULT_TIME_BUDGET_SEC = 60;

/** Lower bound for one real-inventory run; finalists are cut before this. */
export const SET_MIN_RUN_MS = 4000;

/** Generated results are deterministic; differences below this are rounding. */
export const SET_GENERATED_TIE_PERCENT = 0.1;

/** Real-inventory results move by up to ~1% with the time budget. */
export const SET_ACCOUNT_TIE_PERCENT = 1;

/** Relative damage change below which a set choice has no effect. */
export const SET_NO_EFFECT_RELATIVE = 1e-4;

/** Two-piece groups never screened: no modelled damage effect. */
export const SET_SCREEN_EXCLUDED_HALF_SET_IDS: ReadonlySet<string> = new Set([
  "heal%-15",
  "shield-35",
  "pyro-res-40",
  "electro-res-40",
  "nightsoul-energy-6",
]);

// Lineup solver (docs/design/lineup-solver.md, P2).

/** Margins within this percent of each other count as tied. */
export const LINEUP_MARGIN_TIE_PERCENT = 3;

/** Pairings listed per Abyss chamber. */
export const LINEUP_PAIRINGS_SHOWN = 4;

/** Compositions ranked with generated artifacts at their current sets. */
export const LINEUP_RANKED_COMPOSITIONS = 64;

/** Compositions per template and encounter whose sets are screened. */
export const LINEUP_SCREENED_COMPOSITIONS = 4;

/** Real-inventory runs per template and encounter, at most. Longer time
 *  budgets buy more runs, each at least `SET_MIN_RUN_MS`. */
export const LINEUP_MAX_RUNS = 24;

/** Re-runs per chamber that keep clear of the other half's gear. */
export const LINEUP_MAX_DIVERSIFY_RUNS = 4;

/** A member whose artifact stats are worth less than this share of team
 *  damage takes any pieces that form its set. */
export const LINEUP_ANY_PIECES_PERCENT = 2;

/** Contested pieces, characters and weapons re-solved without, per lineup. */
export const LINEUP_BINDING_CHECKS = 16;

export const LINEUP_TIME_BUDGET_OPTIONS_SEC = [
  30, 120, 300, 600, 1200,
] as const;

export const LINEUP_DEFAULT_TIME_BUDGET_SEC = 120;

/** Format tag and version of a lineup run's debug export. */
export const LINEUP_DEBUG_FORMAT = "genshintools-lineup-debug";
export const LINEUP_DEBUG_VERSION = 3;
