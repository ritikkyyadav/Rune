/**
 * What a new session remembers about the last one.
 *
 * The rule the tests exist to hold: last used wins, except for the one gear
 * that stops asking permission — which is remembered only on a recorded yes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadPrefs,
  savePrefs,
  mayPersistGear,
  shouldAskAboutFourthGear,
} from "../../../packages/shared/src/prefs-store";

let dir: string;
const original = process.env.GEAR_PREFS_PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gear-prefs-"));
  process.env.GEAR_PREFS_PATH = join(dir, "prefs.json");
});
afterEach(() => {
  if (original === undefined) delete process.env.GEAR_PREFS_PATH;
  else process.env.GEAR_PREFS_PATH = original;
  rmSync(dir, { recursive: true, force: true });
});

describe("session preferences", () => {
  test("unset reads as empty rather than failing", () => {
    expect(loadPrefs()).toEqual({});
  });

  test("a chosen gear survives to the next session", () => {
    savePrefs({ gear: "gear-3" });
    expect(loadPrefs().gear).toBe("gear-3");
  });

  test("writes merge, so two callers cannot erase each other", () => {
    // The gear is written on a keystroke and the 4th-gear consent from a
    // prompt. A whole-file write from either would drop the other.
    savePrefs({ gear: "gear-2" });
    savePrefs({ stickyFourthGear: true });
    expect(loadPrefs()).toEqual({ gear: "gear-2", stickyFourthGear: true });
  });

  test("a malformed file is 'unset', never a crash at startup", () => {
    writeFileSync(process.env.GEAR_PREFS_PATH!, "{ not json");
    expect(loadPrefs()).toEqual({});
    writeFileSync(process.env.GEAR_PREFS_PATH!, JSON.stringify({ gear: 42 }));
    expect(loadPrefs()).toEqual({});
  });
});

describe("4th gear is the exception", () => {
  test("every other gear is remembered without being asked about", () => {
    for (const gear of ["gear-1", "gear-2", "gear-3", "auto"]) {
      expect(mayPersistGear(gear, {}), gear).toBe(true);
      expect(shouldAskAboutFourthGear(gear, {}), gear).toBe(false);
    }
  });

  test("4th gear is asked about exactly once", () => {
    expect(shouldAskAboutFourthGear("gear-4", {})).toBe(true); // never asked
    expect(shouldAskAboutFourthGear("gear-4", { stickyFourthGear: true })).toBe(false);
    expect(shouldAskAboutFourthGear("gear-4", { stickyFourthGear: false })).toBe(false);
  });

  test("declining keeps it session-only, and is not re-asked", () => {
    // The distinction that matters: `false` is not the same as unset. Treating
    // a decline as "never asked" would raise the prompt on every launch.
    savePrefs({ stickyFourthGear: false });
    expect(mayPersistGear("gear-4")).toBe(false);
    expect(shouldAskAboutFourthGear("gear-4")).toBe(false);
  });

  test("agreeing makes it persist like any other gear", () => {
    savePrefs({ stickyFourthGear: true, gear: "gear-4" });
    expect(mayPersistGear("gear-4")).toBe(true);
    expect(loadPrefs().gear).toBe("gear-4");
  });

  test("full autonomy can never be reached by a silent default", () => {
    // The whole point: nothing that has not recorded an explicit yes may put
    // a new session into the gear that stops asking.
    expect(mayPersistGear("gear-4", {})).toBe(false);
    expect(mayPersistGear("gear-4", { gear: "gear-4" })).toBe(false);
  });
});
