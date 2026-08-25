import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSavedBrowserState,
  resolveInitialBrowser,
  saveBrowserState,
} from "../../../packages/shared/src/browser-store";

describe("browser-store", () => {
  test("save/load round-trips through the sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-browser-store-"));
    try {
      expect(loadSavedBrowserState(dir)).toBeNull();
      saveBrowserState(true, dir);
      expect(loadSavedBrowserState(dir)).toBe(true);
      saveBrowserState(false, dir);
      expect(loadSavedBrowserState(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt or wrong-shaped sidecar reads as null", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-browser-store-"));
    try {
      writeFileSync(join(dir, "browser.json"), "{not json");
      expect(loadSavedBrowserState(dir)).toBeNull();
      writeFileSync(join(dir, "browser.json"), JSON.stringify({ enabled: "yes" }));
      expect(loadSavedBrowserState(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveInitialBrowser precedence: flag > env > saved > configured > off", () => {
    expect(resolveInitialBrowser({})).toBe(false);
    expect(resolveInitialBrowser({ configured: true })).toBe(true);
    expect(resolveInitialBrowser({ saved: false, configured: true })).toBe(false);
    expect(resolveInitialBrowser({ env: "true", saved: false, configured: false })).toBe(true);
    expect(resolveInitialBrowser({ env: "false", saved: true })).toBe(false);
    // An unparseable env value falls through to the next tier.
    expect(resolveInitialBrowser({ env: "garbage", saved: true })).toBe(true);
    expect(resolveInitialBrowser({ flag: false, env: "true", saved: true, configured: true })).toBe(
      false,
    );
    expect(resolveInitialBrowser({ flag: true })).toBe(true);
  });
});
