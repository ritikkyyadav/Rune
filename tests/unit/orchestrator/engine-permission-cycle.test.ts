import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../../../packages/orchestrator/src/engine";
import { rmTemp } from "../../helpers/tmp";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmTemp(root);
});

describe("Engine five-rune Shift+Tab cycle", () => {
  test("four shifts from 1st gear reach auto via 2nd, 3rd, and 4th — the sandbox never moves", () => {
    const root = mkdtempSync(join(tmpdir(), "rune-cycle-"));
    roots.push(root);
    const engine = new Engine({
      workspaceRoot: root,
      dbPath: join(root, "rune.db"),
      sandboxEnabled: true,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });

    try {
      expect(engine.getPermissionMode()).toBe("gear-1");
      expect(engine.isSandboxEnabled()).toBe(true);

      expect(engine.cyclePermissionMode()).toBe("gear-2");
      expect(engine.cyclePermissionMode()).toBe("gear-3");
      expect(engine.cyclePermissionMode()).toBe("gear-4");
      // 4th gear removes the prompts, not the containment: the OS sandbox is
      // an independent switch and must stay exactly as the user left it.
      expect(engine.isSandboxEnabled()).toBe(true);

      expect(engine.cyclePermissionMode()).toBe("auto");
      expect(engine.isSandboxEnabled()).toBe(true);

      expect(engine.cyclePermissionMode()).toBe("gear-1");
    } finally {
      engine.close();
    }
  });

  test("a session started with the sandbox off keeps it off through 4th gear and back", () => {
    const root = mkdtempSync(join(tmpdir(), "rune-cycle-nosandbox-"));
    roots.push(root);
    const engine = new Engine({
      workspaceRoot: root,
      dbPath: join(root, "rune.db"),
      sandboxEnabled: false,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });
    try {
      expect(engine.isSandboxEnabled()).toBe(false);
      expect(engine.setPermissionMode("4").ok).toBe(true);
      expect(engine.isSandboxEnabled()).toBe(false);
      expect(engine.setPermissionMode("1st gear").ok).toBe(true);
      expect(engine.isSandboxEnabled()).toBe(false);
    } finally {
      engine.close();
    }
  });

  test("Auto gets its sandbox at every way in — the shift AND startup", () => {
    // The founder's sidecar said `mode: off` from 2026-09-07 to 09-18, and a
    // session that OPENED in Auto (a remembered gear) kept it: 421 of 421
    // shell calls ran on the host, every writable one paid an in-path reviewer
    // call, and every reviewer timeout became a prompt. Only the shift used to
    // turn the sandbox on.
    const root = mkdtempSync(join(tmpdir(), "rune-auto-boundary-"));
    roots.push(root);
    const started = new Engine({
      workspaceRoot: root,
      dbPath: join(root, "rune.db"),
      permissionMode: "auto",
      sandboxEnabled: false,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });
    try {
      expect(started.getPermissionMode()).toBe("auto");
      expect(started.isSandboxEnabled()).toBe(true);
    } finally {
      started.close();
    }

    const root2 = mkdtempSync(join(tmpdir(), "rune-auto-boundary-shift-"));
    roots.push(root2);
    const shifted = new Engine({
      workspaceRoot: root2,
      dbPath: join(root2, "rune.db"),
      sandboxEnabled: false,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });
    try {
      expect(shifted.isSandboxEnabled()).toBe(false);
      expect(shifted.setPermissionMode("auto").ok).toBe(true);
      expect(shifted.isSandboxEnabled()).toBe(true);
      // Leaving Auto does not take the boundary away mid-session, and a
      // manual gear still never turns it on by itself (the test above).
      expect(shifted.setPermissionMode("4").ok).toBe(true);
      expect(shifted.isSandboxEnabled()).toBe(true);
    } finally {
      shifted.close();
    }
  });

  test("an explicit off for THIS run (--no-sandbox, RUNE_SANDBOX_MODE) stands at startup", () => {
    // A saved `off` is a preference from another session; a flag or an
    // environment variable is this run's instruction. Auto overrides the first
    // and honours the second — the reviewer then stands in for the sandbox.
    const root = mkdtempSync(join(tmpdir(), "rune-auto-explicit-off-"));
    roots.push(root);
    const engine = new Engine({
      workspaceRoot: root,
      dbPath: join(root, "rune.db"),
      permissionMode: "auto",
      sandboxMode: "off",
      sandboxModeExplicit: true,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });
    try {
      expect(engine.getPermissionMode()).toBe("auto");
      expect(engine.isSandboxEnabled()).toBe(false);
      // Shifting into Auto later is a new instruction, and it turns it on as
      // it always has.
      expect(engine.setPermissionMode("4").ok).toBe(true);
      expect(engine.setPermissionMode("auto").ok).toBe(true);
      expect(engine.isSandboxEnabled()).toBe(true);
    } finally {
      engine.close();
    }
  });

  test("legacy spellings canonicalize: turing/hands-free/yolo/autonomy-iii → 4th gear, confirm → 1st", () => {
    const root = mkdtempSync(join(tmpdir(), "rune-alias-"));
    roots.push(root);
    const engine = new Engine({
      workspaceRoot: root,
      dbPath: join(root, "rune.db"),
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });

    try {
      for (const legacy of ["turing", "hands-free", "yolo", "autonomy-iii", "4th", "gear 4"]) {
        expect(engine.setPermissionMode(legacy).ok).toBe(true);
        expect(engine.getPermissionMode()).toBe("gear-4");
        expect(engine.setPermissionMode("confirm").ok).toBe(true);
        expect(engine.getPermissionMode()).toBe("gear-1");
      }
      expect(engine.setPermissionMode("autonomy-i").ok).toBe(true);
      expect(engine.getPermissionMode()).toBe("gear-2");
      expect(engine.setPermissionMode("autonomy-ii").ok).toBe(true);
      expect(engine.getPermissionMode()).toBe("gear-3");
      expect(engine.setPermissionMode("nonsense").ok).toBe(false);
    } finally {
      engine.close();
    }
  });
});
