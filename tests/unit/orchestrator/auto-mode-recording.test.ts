import { describe, expect, test } from "bun:test";

import type { LlmGateway } from "@rune/llm-gateway";
import type { ToolSchema } from "@rune/tool-registry";
import {
  AutoModeSafetyController,
  resolveAutoModeConfig,
  type ActionClassifier,
  type AutoModeAction,
  type AutoModeReview,
  type ClassifierCall,
} from "../../../packages/orchestrator/src/auto-mode";
import { setSandboxCapability } from "../../../packages/tool-registry/src/sandbox-capability";

// Until the engine probes rune-tools the capability is UNKNOWN and "not
// isolated", which makes every bash call an uncontained one. These tests
// describe a healthy machine, so say so — without this the file only passes
// when another file's stub happens to run first.
setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });

/**
 * P6A.1 — what a decision has to carry before it can be labelled.
 *
 * A recorded decision that cannot be joined to the call it gated, and whose
 * latency is one undifferentiated number covering both a regex match and a
 * nine-second model call, is not evidence of anything. These tests pin the
 * three additions: the call id, the timing split, and — the one that actually
 * unblocks the false-positive metric — a row for every supervisor verdict,
 * including the ones that cleared.
 */

const WORKSPACE = "/tmp/gear-auto-recording";

function schema(
  name: string,
  category: ToolSchema["category"],
  permissionLevel: ToolSchema["permissionLevel"],
): ToolSchema {
  return {
    name,
    version: "1",
    description: name,
    inputSchema: { type: "object" },
    category,
    permissionLevel,
  };
}

const BASH = schema("bash", "execute", "sandbox");
const READ = schema("read_file", "read", "auto");

function action(overrides: Partial<AutoModeAction> = {}): AutoModeAction {
  return {
    callId: "call-abc",
    toolName: "bash",
    args: { command: "bun test tests/unit" },
    schema: BASH,
    workspaceRoot: WORKSPACE,
    ...overrides,
  };
}

/** A reviewer that answers on demand, one scripted reply per stage. */
class ScriptedClassifier implements ActionClassifier {
  readonly calls: Array<ClassifierCall["stage"]> = [];
  constructor(
    private readonly replies: Partial<Record<ClassifierCall["stage"], string | (() => string)>>,
    private readonly delayMs = 0,
  ) {}
  async classify(call: ClassifierCall): Promise<string> {
    this.calls.push(call.stage);
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    const reply = this.replies[call.stage];
    if (reply === undefined) throw new Error(`no scripted reply for ${call.stage}`);
    return typeof reply === "function" ? reply() : reply;
  }
}

function controllerWith(
  classifier: ActionClassifier,
  overrides: Parameters<typeof resolveAutoModeConfig>[0] = {},
): AutoModeSafetyController {
  return new AutoModeSafetyController(
    resolveAutoModeConfig({
      classifierProvider: "anthropic",
      classifierModel: "test-model",
      failClosed: true,
      timeoutMs: 5_000,
      // These tests measure what the supervisor writes down, so it has to
      // see the ordinary commands they use; the default scope skips them.
      supervisor: "all",
      ...overrides,
    }),
    classifier,
    () => ({ gateway: {} as LlmGateway, provider: "anthropic", model: "test-model" }),
  );
}

const REASONED_DENY_HIGH = JSON.stringify({
  verdict: "deny",
  risk: "high",
  reason: "The command reaches outside anything the user asked for.",
});

const REASONED_ALLOW = JSON.stringify({
  verdict: "allow",
  risk: "low",
  reason: "Reads a workspace file the user named.",
});

describe("P6A.1 — callId and the timing split", () => {
  test("a mechanical decision carries the call id and reports no reviewer time", async () => {
    const controller = controllerWith(new ScriptedClassifier({}));
    const run = controller.startRun(["Read the config file."]);

    const review = await run.review(
      action({ callId: "call-mech", toolName: "read_file", args: { path: "a.ts" }, schema: READ }),
    );

    expect(review.source).toBe("safe_tier");
    expect(review.callId).toBe("call-mech");
    expect(review.timings).toBeDefined();
    expect(review.timings!.classifierMs).toBe(0);
    expect(review.timings!.retryMs).toBe(0);
    // Everything the decision cost was mechanical, so the split has to sum to
    // the total the audit row already reports.
    expect(review.timings!.mechanicalMs).toBe(review.durationMs);
  });

  test("a reviewed decision charges its wall clock to classifierMs, not to mechanical", async () => {
    const controller = controllerWith(new ScriptedClassifier({ reasoned: REASONED_DENY_HIGH }, 25));
    const run = controller.startRun(["Tidy up my local branches."]);

    const review = await run.review(
      action({
        callId: "call-reviewed",
        args: { command: "git push --force origin main", network: true },
      }),
    );

    expect(review.callId).toBe("call-reviewed");
    expect(review.timings!.classifierMs).toBeGreaterThanOrEqual(20);
    expect(review.timings!.retryMs).toBe(0);
    // The mechanical share must not absorb the reviewer's latency — that
    // conflation is the reason a p50 over `durationMs` said nothing.
    expect(review.timings!.mechanicalMs).toBeLessThan(review.timings!.classifierMs);
  });

  test("a failed first call and its retry are timed separately", async () => {
    let first = true;
    const classifier = new ScriptedClassifier(
      {
        reasoned: () => {
          if (first) {
            first = false;
            throw new Error("reviewer transport failure");
          }
          return REASONED_DENY_HIGH;
        },
      },
      15,
    );
    const controller = controllerWith(classifier);
    const run = controller.startRun(["Tidy up my local branches."]);

    const review = await run.review(
      action({ args: { command: "git push --force origin main", network: true } }),
    );

    expect(classifier.calls.filter((c) => c === "reasoned")).toHaveLength(2);
    // Both attempts are latency the user waited through, and they are reported
    // as two numbers because one of them is avoidable and the other is not.
    expect(review.timings!.classifierMs).toBeGreaterThanOrEqual(10);
    expect(review.timings!.retryMs).toBeGreaterThanOrEqual(10);
  });
});

describe("P6A.1 — the supervisor writes down what it decided", () => {
  test("a screen that clears is recorded, so the false-positive rate has a denominator", async () => {
    const classifier = new ScriptedClassifier({ fast: "allow" });
    const controller = controllerWith(classifier);
    const seen: Array<{ review: AutoModeReview; action: AutoModeAction }> = [];
    controller.setDecisionObserver((review, act) => seen.push({ review, action: act }));

    const run = controller.startRun(["Run the test suite."]);
    const review = await run.review(action({ callId: "call-ok" }));
    expect(review.source).toBe("supervised_tier");
    await run.drainSupervisor();

    const screens = seen.filter((s) => s.review.source === "supervisor_screen");
    expect(screens).toHaveLength(1);
    expect(screens[0]!.review.verdict).toBe("allow");
    expect(screens[0]!.review.callId).toBe("call-ok");
    expect(screens[0]!.action.toolName).toBe("bash");
    // A clearing screen is not a decision the run made; it must not inflate
    // the controller's decision counters.
    expect(controller.getStats().decisions).toBe(1);
  });

  test("a screen the reasoned pass refuses to confirm is recorded as a caught false positive", async () => {
    const classifier = new ScriptedClassifier({ fast: "block", reasoned: REASONED_ALLOW });
    const controller = controllerWith(classifier);
    const seen: AutoModeReview[] = [];
    controller.setDecisionObserver((review) => seen.push(review));

    const run = controller.startRun(["Install the dependencies and run the tests."]);
    await run.review(action({ args: { command: "npm install", network: true } }));
    await run.drainSupervisor();

    const screen = seen.find((r) => r.source === "supervisor_screen");
    const reasoned = seen.find((r) => r.source === "supervisor_reasoned");
    expect(screen?.verdict).toBe("deny");
    // The screen fired and the careful pass disagreed. That pair IS the
    // measurement: the historical npm-install kills were exactly this shape.
    expect(reasoned?.verdict).toBe("allow");
    expect(reasoned?.reason).toContain("NOT confirmed");
    expect(controller.getStats().supervisorUnconfirmed).toBe(1);
    // And nothing latched: the next action proceeds.
    const next = await run.review(action({ args: { command: "npm test" } }));
    expect(next.verdict).toBe("allow");
  });

  test("a confirmed flag records both rows and still halts the next action", async () => {
    const classifier = new ScriptedClassifier({ fast: "block", reasoned: REASONED_DENY_HIGH });
    const controller = controllerWith(classifier);
    const seen: AutoModeReview[] = [];
    controller.setDecisionObserver((review) => seen.push(review));

    const run = controller.startRun(["Summarize this repository."]);
    await run.review(action({ args: { command: "npm run build" } }));
    await run.drainSupervisor();

    expect(seen.map((r) => r.source)).toEqual(["supervisor_screen", "supervisor_reasoned"]);
    expect(seen[1]!.verdict).toBe("deny");
    expect(controller.getStats().supervisorUnconfirmed).toBe(0);

    const next = await run.review(action({ args: { command: "npm test" } }));
    expect(next.source).toBe("supervisor_halt");
    expect(next.haltRun).toBe(true);
  });

  test("an observer that throws cannot disturb the run", async () => {
    const controller = controllerWith(new ScriptedClassifier({ fast: "allow" }));
    controller.setDecisionObserver(() => {
      throw new Error("recorder is down");
    });
    const run = controller.startRun(["Run the test suite."]);
    const review = await run.review(action());
    await run.drainSupervisor();
    expect(review.verdict).toBe("allow");
  });
});
