// ─── Gear · the small formatters ───
// Elapsed time is a fact. Remaining time is a guess, and a wrong guess about how long
// an agent will take is the fastest way to lose a user's trust in everything else on
// the screen. There is no `eta()` in this file and there is no `percent()`.

/** `6.2s` · `38s` · `1m41s` · `18m 42s`. Never `~2m left`. */
export function dur(ms: number): string {
  if (ms < 10_000) {
    const s = ms / 1000;
    // `0s`, not `0.0s`: a tenth of a second is below the resolution anyone cares about.
    return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  }
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (rest === 0) return `${m}m`;
  return m >= 10
    ? `${m}m ${String(rest).padStart(2, "0")}s`
    : `${m}m${String(rest).padStart(2, "0")}s`;
}

/** `2 agents` · `1 agent` · `0 agents`. Counts of things that happened. */
export const count = (n: number, one: string, many = one + "s"): string =>
  `${n} ${n === 1 ? one : many}`;

export const bytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} kB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** `+35 −14`, in the columns the terminus lines up on. */
export const delta = (added: number, removed: number): string =>
  `+${String(added).padEnd(3)}−${removed}`;
