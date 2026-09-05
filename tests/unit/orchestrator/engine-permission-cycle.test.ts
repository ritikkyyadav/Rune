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
