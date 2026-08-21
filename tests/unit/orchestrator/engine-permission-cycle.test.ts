import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../../../packages/orchestrator/src/engine";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Engine five-state Shift+Tab permission cycle", () => {
  test("four presses from Confirm reach classifier Auto after Autonomy I, II, and III", () => {
    const root = mkdtempSync(join(tmpdir(), "elio-autonomy-cycle-"));
    roots.push(root);
    const engine = new Engine({
      workspaceRoot: root,
      dbPath: join(root, "elio.db"),
      sandboxEnabled: true,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });

    try {
      expect(engine.getPermissionMode()).toBe("confirm");
      expect(engine.isSandboxEnabled()).toBe(true);

      expect(engine.cyclePermissionMode()).toBe("autonomy-i");
      expect(engine.cyclePermissionMode()).toBe("autonomy-ii");
      expect(engine.cyclePermissionMode()).toBe("autonomy-iii");
      expect(engine.isSandboxEnabled()).toBe(false);

      // The fourth Shift+Tab enters Auto and restores containment.
      expect(engine.cyclePermissionMode()).toBe("auto");
      expect(engine.isSandboxEnabled()).toBe(true);

      expect(engine.cyclePermissionMode()).toBe("confirm");
    } finally {
      engine.close();
    }
  });

  test("legacy Hands-Free/turing input is canonicalized to Autonomy III", () => {
    const root = mkdtempSync(join(tmpdir(), "elio-autonomy-alias-"));
    roots.push(root);
    const engine = new Engine({
      workspaceRoot: root,
      dbPath: join(root, "elio.db"),
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });

    try {
      expect(engine.setPermissionMode("turing").ok).toBe(true);
      expect(engine.getPermissionMode()).toBe("autonomy-iii");
      expect(engine.setPermissionMode("confirm").ok).toBe(true);
    } finally {
      engine.close();
    }
  });
});
