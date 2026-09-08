// ─── Session preferences ───
//
// What a new session should remember about how the last one was set up.
//
// The model sidecar next door already did this for provider/model, and only for
// an explicit "make this the default" gesture. That separation reads well in a
// changelog and badly in use: switching model mid-session is the moment you
// have decided which model you want, and being asked to confirm that decision a
// second time — with a different keystroke, in a different place — means the
// next session opens on something you already rejected. A preference the user
// has to re-state every morning is not a preference, it is a chore.
//
// So: last used wins. Both files are written on the switch itself.
//
// The one exception is 4th gear, which is full autonomy — every interactive
// permission prompt bypassed. Making that sticky silently would mean a machine
// that quietly stopped asking, forever, because of one afternoon's choice. It
// is asked for once, explicitly, and the answer is what is remembered; every
// other gear persists without ceremony because every other gear still asks.
//
// Loading is lenient by design: a missing or malformed file is "unset" and
// never throws. A preference that can crash startup is worse than no
// preference.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { getRuneHome } from "./paths.js";

export interface SessionPrefs {
  /** The gear a new session opens in. */
  gear?: string;
  /**
   * Whether the user has agreed that 4th gear may be remembered.
   *
   * Three states, and the difference matters: `undefined` means never asked, so
   * ask; `false` means asked and declined, so 4th gear stays session-only and
   * we do not nag again; `true` means agreed, so it persists like any other.
   */
  stickyFourthGear?: boolean;
  /**
   * The web-search engine to ask first, by preset id. Set when `/login` →
   * Web search connects one: the engine you just connected is the one you
   * meant to use, the same way a fresh model sign-in becomes the session
   * model. `[search] provider` in config.toml still wins over it.
   */
  search?: string;
}

/** `~/.rune/prefs.json`, or RUNE_PREFS_PATH. Computed per call so the env
 *  override always takes effect (tests, sandboxes, throwaway profiles). */
export function getPrefsPath(): string {
  return process.env.RUNE_PREFS_PATH || join(getRuneHome(), "prefs.json");
}

/** Read stored preferences. Never throws; unset and unreadable are the same. */
export function loadPrefs(): SessionPrefs {
  try {
    const path = getPrefsPath();
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const prefs: SessionPrefs = {};
    if (typeof raw?.gear === "string" && raw.gear) prefs.gear = raw.gear;
    if (typeof raw?.stickyFourthGear === "boolean") prefs.stickyFourthGear = raw.stickyFourthGear;
    if (typeof raw?.search === "string" && raw.search) prefs.search = raw.search;
    return prefs;
  } catch {
    return {};
  }
}

/**
 * Merge and persist. Merging rather than replacing matters: the gear is written
 * from the TUI on a keystroke and the 4th-gear consent from a prompt, and a
 * whole-file write from either would silently drop the other.
 */
export function savePrefs(update: SessionPrefs): void {
  try {
    const path = getPrefsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const merged: SessionPrefs = { ...loadPrefs(), ...update };
    writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
  } catch {
    // Ignore — the in-memory change still applied; only the memory of it is lost.
  }
}

/**
 * Whether this gear may be written down, given what the user has agreed to.
 *
 * Pure so the rule is one readable line and can be tested without a filesystem:
 * everything except 4th gear persists freely, and 4th gear persists only on a
 * recorded yes.
 */
export function mayPersistGear(gear: string, prefs: SessionPrefs = loadPrefs()): boolean {
  if (gear !== "gear-4") return true;
  return prefs.stickyFourthGear === true;
}

/** Whether to ask about remembering 4th gear — only ever on the first time. */
export function shouldAskAboutFourthGear(gear: string, prefs: SessionPrefs = loadPrefs()): boolean {
  return gear === "gear-4" && prefs.stickyFourthGear === undefined;
}
