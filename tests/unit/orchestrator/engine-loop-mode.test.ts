import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistry } from "@gear/tool-registry";
import { Engine } from "../../../packages/orchestrator/src/engine";
import { rmTemp } from "../../helpers/tmp";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmTemp(root);
});

function makeEngine(root: string): Engine {
  return new Engine({
    model: "llama3",
    provider: "ollama",
    workspaceRoot: root,
    dbPath: join(root, "gear.db"),
    toolsBinaryPath: "gear-tools",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    memory: { enabled: false },
  });
}

describe("Engine session-loop wiring", () => {
  test("restores an unexpired loop with its conversation", () => {
    const root = mkdtempSync(join(tmpdir(), "gear-engine-loop-"));
    roots.push(root);
    const first = makeEngine(root);
    const sessionId = first.createSession();
    const created = first.scheduleLoop(sessionId, "5m check the deploy").task;
    first.close();

    const resumed = makeEngine(root);
    try {
      const tasks = resumed.listLoopTasks(sessionId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe(created.id);
      expect(tasks[0]?.prompt).toBe("check the deploy");
      expect(tasks[0]?.cadence).toBe("fixed");
    } finally {
      resumed.close();
    }
  });

  test("rewinding past a loop definition removes it from live state", () => {
    const root = mkdtempSync(join(tmpdir(), "gear-engine-loop-rewind-"));
    roots.push(root);
    const engine = makeEngine(root);
    try {
      const sessionId = engine.createSession();
      engine.scheduleLoop(sessionId, "5m check the deploy");
      expect(engine.listLoopTasks(sessionId)).toHaveLength(1);

      engine.rewindTo(sessionId, 0);
      expect(engine.listLoopTasks(sessionId)).toEqual([]);
    } finally {
      engine.close();
    }
  });

  test("registers loop_control for adaptive iterations", () => {
    const root = mkdtempSync(join(tmpdir(), "gear-engine-loop-tool-"));
    roots.push(root);
    const engine = makeEngine(root);
    try {
      const registry = (engine as unknown as { registry: ToolRegistry }).registry;
      const schema = registry.list().find((tool) => tool.name === "loop_control");
      expect(schema?.permissionLevel).toBe("auto");
      expect(schema?.category).toBe("execute");
    } finally {
      engine.close();
    }
  });
});
