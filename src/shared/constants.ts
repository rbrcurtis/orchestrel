/** Fraction of the model's context window used as the SDK autoCompactWindow.
 *  Also used by the UI gauge so 100% ≈ auto-compact threshold. */
export const AUTO_COMPACT_RATIO = 0.95;

/** Rolling window total budget in tokens (system + messages). */
export const ROLLING_WINDOW_TOKENS = 64_000;

/** Fraction of message budget to evict when window is full (sawtooth). Easy to tweak. */
export const EVICTION_RATIO = 0.25;

/** Minimum turns to keep after eviction (never evict below this). */
export const MIN_TURNS_KEPT = 2;
