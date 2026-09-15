// ─── What Rune calls the reader: the vocabulary ───
//
// `[ui] callsign` is the one word Rune's working-row voice addresses the
// reader by -- `on it, boss`. It lives here, not in `bin/ui`, for the same
// reason `ui-layout.ts` does: `Engine.applyConfigSetting` has to be able to
// change it live for `/config callsign chief`, and the engine may not import
// the terminal layer (tests/unit/orchestrator/engine-graph-purity.test.ts).
// The voice itself -- the lines, the walk -- stays in bin/ui/voice.ts.

let current = "";

/** A name, not a sentence: one line, trimmed, at most sixteen cells. */
export const CALLSIGN_MAX = 16;

export function cleanCallsign(value: string | undefined | null): string {
  return (
    String(value ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, CALLSIGN_MAX)
  );
}

/** Set what Rune calls the reader for this process. Empty means no address. */
export function setCallsign(value: string | undefined | null): void {
  current = cleanCallsign(value);
}

export function getCallsign(): string {
  return current;
}
