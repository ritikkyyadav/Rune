/**
 * Black-box tap tests: the agent loop reports its named reliability events
 * through onIncident, the engine classifies tool failures at its chokepoint,
 * and an Engine with blackbox enabled records salvage incidents end-to-end.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import { Engine, classifyToolFailure } from "../../../packages/orchestrator/src/engine";
import { parseToolArguments } from "../../../packages/shared/src/json";
import type { IncidentInput } from "../../../packages/shared/src/incident";
import { BlackboxStore } from "../../../packages/telemetry/src/store";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Gateway that re-issues the SAME doomed call each turn, then finishes. */
function repeatingFailureGateway(turns: number) {
  let turn = 0;
  return {
    inferStream: mock(async function* () {
      turn++;
      if (turn <= turns) {
        yield ev("tool_use_start", { toolCallId: `doomed-${turn}`, toolName: "web_fetch" });
        yield ev("tool_use_stop", {
          toolCallId: `doomed-${turn}`,
          toolInput: { url: "https://blocked.example/lib.js" },
        });
        yield ev("tool_use_start", { toolCallId: `read-${turn}`, toolName: "read_file" });
        yield ev("tool_use_stop", {
          toolCallId: `read-${turn}`,
          toolInput: { path: `f${turn}.ts` },
        });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

function failingRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: input.toolName !== "web_fetch",
      result: input.toolName === "web_fetch" ? "" : "ok",
      error: input.toolName === "web_fetch" ? "connect ETIMEDOUT blocked.example" : undefined,
      durationMs: 1,
    })),
  } as any;
}

describe("agent-loop incident tap", () => {
  test("repeated-failure breaker reports loop.repeated_call_refused", async () => {
    const incidents: IncidentInput[] = [];
    const loop = new AgentLoop(
      {
        model: "test",
        provider: "google" as any,
        maxTokens: 1000,
        maxTurns: 8,
        maxConsecutiveErrors: 99,
        systemPrompt: "t",
        onIncident: (i) => incidents.push(i),
      },
      repeatingFailureGateway(5),
      failingRegistry(),
    );
    await drain(loop.run("go", "s1", "/tmp"));

    const refused = incidents.filter((i) => i.class === "loop.repeated_call_refused");
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused[0].component).toBe("agent-loop");
    expect(refused[0].message).toContain("web_fetch");
    expect(refused[0].context?.model).toBe("test");
  });

  test("a throwing onIncident never breaks the run", async () => {
    const loop = new AgentLoop(
      {
        model: "test",
        provider: "google" as any,
        maxTokens: 1000,
        maxTurns: 8,
        maxConsecutiveErrors: 99,
        systemPrompt: "t",
        onIncident: () => {
          throw new Error("observer bug");
        },
      },
      repeatingFailureGateway(5),
      failingRegistry(),
    );
    const events = await drain(loop.run("go", "s1", "/tmp"));
    const complete = events.find((e: any) => e.type === "turn_complete");
    expect(complete).toBeDefined();
  });
});

describe("classifyToolFailure", () => {
  test("maps failure text to classes", () => {
    expect(classifyToolFailure("bash", "thread 'main' panicked at src/bash.rs:55").cls).toBe(
      "crash.rust_tool_panic",
    );
    expect(classifyToolFailure("bash", "sh: Operation not permitted (sandbox)").cls).toBe(
      "tool.sandbox_denial",
    );
    expect(classifyToolFailure("write_file", "path is outside the workspace root").cls).toBe(
      "tool.path_violation",
    );
    expect(classifyToolFailure("bash", "command timed out after 120000ms").cls).toBe(
      "tool.timeout",
    );
    expect(classifyToolFailure("edit_file", "Invalid arguments: missing required 'old'").cls).toBe(
      "tool.invalid_input",
    );
    expect(classifyToolFailure("bash", "exit status 1: tests failed").cls).toBe(
      "tool.exec_failure",
    );
    expect(classifyToolFailure("bash", "Permission denied by user").cls).toBe(
      "tool.permission_denied",
    );
  });

  test("severities: panics critical, schema errors debug, exec errors error", () => {
    expect(classifyToolFailure("bash", "panicked at x").severity).toBe("critical");
    expect(classifyToolFailure("edit_file", "invalid input: bad schema").severity).toBe("debug");
    expect(classifyToolFailure("bash", "boom").severity).toBe("error");
  });
});

describe("engine blackbox integration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alan-bb-engine-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("engine with blackbox enabled records salvage incidents to its own db", () => {
    const bbPath = join(dir, "blackbox.db");
    const engine = new Engine({
      model: "gemini-2.5-flash",
      provider: "google",
      workspaceRoot: dir,
      dbPath: join(dir, "alan.db"),
      toolsBinaryPath: "alan-tools",
      yoloMode: false,
      plannerMode: false,
      enableCheckpoints: false,
      enableSecurity: false,
      enableRateLimiting: false,
      enableHooks: false,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
      blackbox: { enabled: true, dbPath: bbPath, version: "0.0.0-test" },
    });

    expect(engine.getRecorder()).not.toBeNull();

    // The constructor registered the module-global salvage listener — a
    // gave-up parse must land in the blackbox db as a warn incident.
    parseToolArguments("complete junk, no json here");
    engine.close();

    const store = new BlackboxStore(bbPath);
    const rows = store.list({ class: "provider." });
    expect(rows.length).toBe(1);
    expect(rows[0].class).toBe("provider.malformed_tool_json_fatal");
    expect(rows[0].version).toBe("0.0.0-test");
    store.close();
  });

  test("engine without blackbox config has no recorder (hermetic default)", () => {
    const engine = new Engine({
      model: "gemini-2.5-flash",
      provider: "google",
      workspaceRoot: dir,
      dbPath: join(dir, "alan.db"),
      toolsBinaryPath: "alan-tools",
      yoloMode: false,
      plannerMode: false,
      enableCheckpoints: false,
      enableSecurity: false,
      enableRateLimiting: false,
      enableHooks: false,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });
    expect(engine.getRecorder()).toBeNull();
    engine.close();
  });
});
