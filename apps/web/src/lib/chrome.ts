// ─── The chrome the reader chose, remembered ───
//
// The trace rail is OFF by default (docs/program/09-web-product.md: "Trace
// rail, ⌘T. Off by default; slides in on the right"). It shipped open, so the
// first thing anyone saw was a 760px reading column squeezed by a 380px panel
// of spans they had not asked for — the surface no rival has, presented as
// something you must close before you can read.
//
// Off by default is not the same as off every time. Someone who opens the rail
// is usually going to want it on the next page too, and re-opening a panel on
// every reload is the kind of small tax that makes a tool feel like it is not
// listening. So the DEFAULT is closed and the CHOICE is kept — per browser,
// because that is where the choice was made and the only place it means
// anything.

const RAIL_KEY = "gear.rail";

/**
 * Read a remembered chrome flag.
 *
 * Storage can refuse (a private window, cleared site data, a browser set to
 * block it) and it throws on access in some of those cases rather than
 * returning null — so every read is guarded and falls back to the default. A
 * page that cannot remember a panel must still draw one.
 */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* first run, or storage refused */
  }
  return fallback;
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* remembering is a convenience; losing it must not break the page */
  }
}

/** Was the trace rail open last time? Closed unless this browser says otherwise. */
export function loadRailOpen(): boolean {
  return readFlag(RAIL_KEY, false);
}

export function saveRailOpen(open: boolean): void {
  writeFlag(RAIL_KEY, open);
}
