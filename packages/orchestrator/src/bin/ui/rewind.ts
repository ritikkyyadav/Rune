// ─── `/rewind`'s two decisions, kept apart from the screen (R5.1) ───

/** What a rewind puts back: the conversation, the files, or both. */
export type RewindMode = "chat" | "code" | "both";

/**
 * `/rewind <n> [chat|code|both]`. The mode defaults to the conversation, which
 * is what `/rewind <n>` did before files could be put back. Null when the turn
 * or the mode is not one there is — the command then lists the turns.
 */
export function parseRewindArg(
  arg: string,
  turnCount: number,
): { n: number; mode: RewindMode } | null {
  const [nArg = "", modeArg = ""] = arg.split(/\s+/).filter(Boolean);
  if (!/^\d+$/.test(nArg)) return null;
  const n = Number(nArg);
  if (n < 1 || n > turnCount) return null;
  const mode: RewindMode | null = /^(code|files?)$/i.test(modeArg)
    ? "code"
    : /^(both|all)$/i.test(modeArg)
      ? "both"
      : modeArg === "" || /^(chat|conversation)$/i.test(modeArg)
        ? "chat"
        : null;
  return mode ? { n, mode } : null;
}

/**
 * The files the listed turns `i`..`through` (0-based) wrote. A listed turn
 * owns the harness-led turns (loop iterations) that ran after it and before
 * the next listed one: they are not in the list, and their writes are its.
 */
export function filesFromTurns(
  turns: ReadonlyArray<{ seq: number }>,
  written: ReadonlyMap<number, readonly string[]>,
  i: number,
  through = i,
): string[] {
  const from = turns[i]?.seq ?? Number.POSITIVE_INFINITY;
  const until = turns[through + 1]?.seq ?? Number.POSITIVE_INFINITY;
  const paths = new Set<string>();
  for (const [seq, list] of written) {
    if (seq >= from && seq < until) for (const p of list) paths.add(p);
  }
  return [...paths];
}
