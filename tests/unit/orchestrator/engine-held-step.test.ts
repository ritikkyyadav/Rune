/**
 * The engine half of the held-step surface.
 *
 * `runHeldStep` executes the EXACT call Auto declined, at the user's explicit
 * request. What these tests pin: the execution is byte-exact, the approval
 * becomes an exact session grant (both shapes for bash — the original call and
 * the network-widened one that actually runs), the human decision lands in the
 * audit trail, the next turn is told what happened — and the things that stand
 * ABOVE the human still refuse: configured deny rules, and a run in flight.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmGateway } from "@gear/llm-gateway";
import type { SessionManager } from "@gear/shared";
import type { ToolCallInput, ToolHandler } from "@gear/tool-registry";
import {
  AutoModeSafetyController,
  resolveAutoModeConfig,
  type ActionClassifier,
  type AutoModeDeferral,
} from "../../../packages/orchestrator/src/auto-mode";
import type { PermissionBroker } from "../../../packages/orchestrator/src/permissions";
import { Engine } from "../../../packages/orchestrator/src/engine";

class SilentClassifier implements ActionClassifier {
  async classify(): Promise<string> {
    throw new Error("no reviewer in this test");
  }
}

interface EngineInternals {
  autoModeSafety: AutoModeSafetyController;
  sessions: SessionManager;
  permissions: PermissionBroker;
  registry: { register(handler: ToolHandler): void; get(name: string): ToolHandler | undefined };
  pendingTurnNotes: string[];
  currentAbort: AbortController | null;
}

function fakeTool(name: string, onExecute?: (input: ToolCallInput) => void): ToolHandler {
  return {
    schema: {
      name,
      version: "1.0.0",
      description: `test tool ${name}`,
      inputSchema: { type: "object" },
      permissionLevel: "confirm",
      category: "execute",
    },
    validate: () => ({ valid: true }),
    execute: async (input) => {
      onExecute?.(input);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: `ran ${name} with ${JSON.stringify(input.args)}`,
        durationMs: 1,
      };
    },
  };
}

function heldStep(overrides: Partial<AutoModeDeferral> = {}): AutoModeDeferral {
  return {
    toolName: "publish_probe",
    summary: "publish_probe {target:npm}",
    route: "publication",
    reason: "This publishes workspace content to people outside this session.",
    at: new Date(),
    args: { target: "npm" },
    kind: "defer",
    ...overrides,
  };
}

describe("Engine.runHeldStep", () => {
  let root: string;
  let engine: Engine;
  let internals: EngineInternals;
  let sessionId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gear-held-step-"));
    engine = new Engine({
      model: "llama3",
      provider: "ollama",
      workspaceRoot: root,
      dbPath: join(root, "gear.db"),
      toolsBinaryPath: "gear-tools",
      permissionMode: "auto",
      enableCheckpoints: false,
      enableSecurity: false,
      enableRateLimiting: false,
      enableHooks: false,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
      memory: { enabled: false },
    });
    internals = engine as unknown as EngineInternals;
    sessionId = engine.createSession();
  });

  afterEach(() => {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("runs the exact call, grants exactly it, records the human decision, tells the next turn", async () => {
    let executed: ToolCallInput | null = null;
    internals.registry.register(fakeTool("publish_probe", (input) => (executed = input)));

    const result = await engine.runHeldStep(sessionId, heldStep());

    expect(result.ran).toBe(true);
    expect(result.output?.success).toBe(true);
    // Byte-exact: the args the agent issued are the args that ran.
    expect(executed!.args).toEqual({ target: "npm" });

    // The approval is an EXACT grant — this payload, nothing broader.
    const schema = internals.registry.get("publish_probe")!.schema;
    expect(internals.permissions.check(schema, { target: "npm" })).toEqual({
      type: "allowed",
      basis: "exact_grant",
    });
    expect(internals.permissions.check(schema, { target: "cargo" }).type).toBe(
      "needs_confirmation",
    );

    // The decision is in the audit trail as the human's, not the reviewer's.
    const safety = internals.sessions
      .getEvents(sessionId, 1)
      .map(({ event }) => event)
      .find((event) => event.type === "safety_decision");
    expect(safety?.payload.verdict).toBe("allow");
    expect(safety?.payload.source).toBe("human_escalation");
    expect(internals.sessions.verifyAuditChain()).toEqual({ ok: true });

    // The next run opens knowing what the user ran and what it produced.
    expect(internals.pendingTurnNotes).toHaveLength(1);
    expect(internals.pendingTurnNotes[0]).toContain("approved the held step");
    expect(internals.pendingTurnNotes[0]).toContain("succeeded");
  });

  test("a bash step is granted in both shapes and runs with the network reachable", async () => {
    let executed: ToolCallInput | null = null;
    internals.registry.register(fakeTool("bash", (input) => (executed = input)));
    const step = heldStep({
      toolName: "bash",
      summary: "npm publish",
      args: { command: "npm publish" },
    });

    const result = await engine.runHeldStep(sessionId, step);

    expect(result.ran).toBe(true);
    // Outward by definition: the held publish must not fail inside the
    // sandbox it was never going to fit.
    expect(executed!.args).toEqual({ command: "npm publish", network: true });

    // Both shapes are exact grants: the agent's original call (an identical
    // retry next turn passes) and the widened one that ran.
    const schema = internals.registry.get("bash")!.schema;
    expect(internals.permissions.check(schema, { command: "npm publish" })).toEqual({
      type: "allowed",
      basis: "exact_grant",
    });
    expect(internals.permissions.check(schema, { command: "npm publish", network: true })).toEqual({
      type: "allowed",
      basis: "exact_grant",
    });
  });

  test("a configured deny rule still refuses — an end-of-turn keystroke does not unwrite config", async () => {
    internals.registry.register(fakeTool("publish_probe"));
    internals.autoModeSafety = new AutoModeSafetyController(
      resolveAutoModeConfig({ denyRules: ["publish_probe"] }),
      new SilentClassifier(),
      () => ({ gateway: {} as LlmGateway, provider: "anthropic", model: "unused" }),
    );

    const result = await engine.runHeldStep(sessionId, heldStep());

    expect(result.ran).toBe(false);
    expect(result.refusal).toContain("publish_probe");
    expect(internals.pendingTurnNotes).toHaveLength(0);
  });

  test("refuses while a run is in flight — held steps run between turns", async () => {
    internals.registry.register(fakeTool("publish_probe"));
    internals.currentAbort = new AbortController();
    try {
      const result = await engine.runHeldStep(sessionId, heldStep());
      expect(result.ran).toBe(false);
      expect(result.refusal).toContain("run is in flight");
    } finally {
      internals.currentAbort = null;
    }
  });

  test("an unknown tool refuses instead of throwing", async () => {
    const result = await engine.runHeldStep(sessionId, heldStep({ toolName: "no_such_tool" }));
    expect(result.ran).toBe(false);
    expect(result.refusal).toContain("no_such_tool");
  });

  test("dismissHeldSteps queues one honest note about what stayed unrun", () => {
    engine.dismissHeldSteps([
      heldStep(),
      heldStep({ toolName: "bash", summary: "gh release create v1", args: { command: "x" } }),
    ]);
    expect(internals.pendingTurnNotes).toHaveLength(1);
    expect(internals.pendingTurnNotes[0]).toContain("chose NOT to run");
    expect(internals.pendingTurnNotes[0]).toContain("publish_probe {target:npm}");
    expect(internals.pendingTurnNotes[0]).toContain("gh release create v1");
    // Nothing queued for an empty review.
    engine.dismissHeldSteps([]);
    expect(internals.pendingTurnNotes).toHaveLength(1);
  });
});
