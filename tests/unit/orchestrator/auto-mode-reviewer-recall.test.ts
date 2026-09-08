/**
 * The reviewer's fourth skip: a high-confidence allow is recalled, not re-asked.
 *
 * The safe tier, the workspace tier and the supervised tier skip the reviewer
 * for what the ACTION is. This one skips it for what the REVIEWER ALREADY
 * SAID about this exact action, in this run. The motive is measured: on free
 * routes a reviewer call is not a cost, it is a REQUEST, and 45% of this
 * agent's recorded incidents are rate limits.
 *
 * What these tests pin is the safety envelope, because a cache of a safety
 * verdict is only sound while all of it holds:
 *   · nothing is cached unless the reviewer said "high" IN SO MANY WORDS;
 *   · nothing is cached for a non-allow verdict;
 *   · only an IDENTICAL action recalls — a different path, a different flag,
 *     a different port is a different question;
 *   · the whole map is dropped the moment the run's trust picture changes.
 */

import { describe, expect, test } from "bun:test";

import type { LlmGateway } from "@rune/llm-gateway";
import type { ToolSchema } from "@rune/tool-registry";
import {
  AutoModeSafetyController,
  resolveAutoModeConfig,
  type ActionClassifier,
  type AutoModeAction,
  type ClassifierCall,
} from "../../../packages/orchestrator/src/auto-mode";
import { setSandboxCapability } from "../../../packages/tool-registry/src/sandbox-capability";

setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });

const WORKSPACE = "/tmp/rune-recall";

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

const WRITE = schema("write_file", "write", "confirm");

/** A write OUTSIDE the workspace: classifier tier, high risk, reviewer required. */
function outsideWrite(path: string, content = "x"): AutoModeAction {
  return {
    callId: `call-${path}`,
    toolName: WRITE.name,
    args: { path, content },
    schema: WRITE,
    workspaceRoot: WORKSPACE,
  };
}

const allow = (confidence?: string): string =>
  JSON.stringify({
    verdict: "allow",
    risk: "high",
    ...(confidence ? { confidence } : {}),
    reason: "The user asked for exactly this file to be written.",
  });

const deny = JSON.stringify({
  verdict: "deny",
  risk: "high",
  confidence: "high",
  reason: "Nothing in the request covers this.",
});

class FakeClassifier implements ActionClassifier {
  readonly calls: ClassifierCall[] = [];
  constructor(private readonly responses: Array<string | Error>) {}
  async classify(call: ClassifierCall): Promise<string> {
    this.calls.push(call);
    const r = this.responses.shift();
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error("no fake response queued");
    return r;
  }
}

function setup(responses: Array<string | Error>) {
  const classifier = new FakeClassifier(responses);
  const controller = new AutoModeSafetyController(
    // The supervisor is what would otherwise fire a SECOND, out-of-band call
    // and make the in-path call count ambiguous. This suite counts in-path
    // reviewer calls, so it is off.
    resolveAutoModeConfig({ supervisor: "off" }),
    classifier,
    () => ({ gateway: {} as LlmGateway, provider: "anthropic", model: "reviewer-model" }),
  );
  return { classifier, controller };
}

describe("confident-allow recall", () => {
  test("a high-confidence allow is recalled — the second identical action costs no call", async () => {
    const { controller, classifier } = setup([allow("high")]);
    const run = controller.startRun(["Write the report to /tmp/out/report.md."]);

    const first = await run.review(outsideWrite("/tmp/out/report.md"));
    expect(first.verdict).toBe("allow");
    expect(first.source).toBe("classifier_reasoned");
    expect(classifier.calls).toHaveLength(1);

    const second = await run.review(outsideWrite("/tmp/out/report.md"));
    expect(second.verdict).toBe("allow");
    expect(second.source).toBe("classifier_recall");
    expect(second.reason).toContain("recalled rather than re-asked");
    // The whole point: no second request left the building.
    expect(classifier.calls).toHaveLength(1);
  });

  test("cosmetic variance recalls; a different target does not", async () => {
    const { controller, classifier } = setup([allow("high"), allow("high")]);
    const run = controller.startRun(["Write the reports."]);

    await run.review(outsideWrite("/tmp/out/a.md", "body   text"));
    // Whitespace and key order are folded by the conservative signature.
    const same = await run.review(outsideWrite("/tmp/out/a.md", "body text"));
    expect(same.source).toBe("classifier_recall");
    expect(classifier.calls).toHaveLength(1);

    // A different path is a different question and pays its own call.
    const other = await run.review(outsideWrite("/tmp/out/b.md"));
    expect(other.source).toBe("classifier_reasoned");
    expect(classifier.calls).toHaveLength(2);
  });

  test("without an explicit high confidence nothing is cached", async () => {
    // Three variants of "not high": medium, an unrecognized value, and a
    // reviewer that never learned the field at all. Each must pay every time,
    // which is the old behaviour exactly.
    for (const c of ["medium", "very", undefined]) {
      const { controller, classifier } = setup([allow(c), allow(c)]);
      const run = controller.startRun(["Write the report to /tmp/out/report.md."]);
      await run.review(outsideWrite("/tmp/out/report.md"));
      const second = await run.review(outsideWrite("/tmp/out/report.md"));
      expect(second.source).toBe("classifier_reasoned");
      expect(classifier.calls).toHaveLength(2);
    }
  });

  test("a deny is never cached, and it drops everything already cached", async () => {
    const { controller, classifier } = setup([
      allow("high"), // a.md — cached
      deny, // b.md — refused, and the run is now under suspicion
      allow("high"), // a.md again — must be re-reviewed, not recalled
    ]);
    const run = controller.startRun(["Write the reports."]);

    await run.review(outsideWrite("/tmp/out/a.md"));
    const refused = await run.review(outsideWrite("/tmp/out/b.md"));
    expect(refused.verdict).not.toBe("allow");

    const again = await run.review(outsideWrite("/tmp/out/a.md"));
    expect(again.source).toBe("classifier_reasoned");
    expect(classifier.calls).toHaveLength(3);
  });

  test("an injection finding drops every recalled verdict", async () => {
    const { controller, classifier } = setup([allow("high"), allow("high")]);
    const run = controller.startRun(["Write the report to /tmp/out/report.md."]);

    await run.review(outsideWrite("/tmp/out/report.md"));
    expect(classifier.calls).toHaveLength(1);

    // A tool result came back carrying instructions. What was obviously fine
    // before is no longer obviously fine.
    run.noteInjectionFinding();

    const after = await run.review(outsideWrite("/tmp/out/report.md"));
    expect(after.source).toBe("classifier_reasoned");
    expect(classifier.calls).toHaveLength(2);
  });

  test("the recall never resurrects an action a mechanical breaker stops", async () => {
    // `rm -rf /` is stopped by the catastrophic patterns long before the tier
    // check that reaches the recall — so it can never be cached, and a run
    // that somehow held a matching key could not use it.
    const bash = schema("bash", "execute", "sandbox");
    const destroy: AutoModeAction = {
      callId: "call-destroy",
      toolName: bash.name,
      args: { command: "rm -rf /" },
      schema: bash,
      workspaceRoot: WORKSPACE,
    };
    const { controller, classifier } = setup([allow("high"), allow("high")]);
    const run = controller.startRun(["Clean up."]);

    const first = await run.review(destroy);
    const second = await run.review(destroy);
    expect(first.verdict).not.toBe("allow");
    expect(second.verdict).not.toBe("allow");
    expect(second.source).not.toBe("classifier_recall");
    // The breakers are mechanical: no model was ever asked.
    expect(classifier.calls).toHaveLength(0);
  });

  test("the cache dies with the run", async () => {
    const { controller, classifier } = setup([allow("high"), allow("high")]);

    const first = controller.startRun(["Write the report to /tmp/out/report.md."]);
    await first.review(outsideWrite("/tmp/out/report.md"));

    const next = controller.startRun(["Write the report to /tmp/out/report.md."]);
    const after = await next.review(outsideWrite("/tmp/out/report.md"));
    expect(after.source).toBe("classifier_reasoned");
    expect(classifier.calls).toHaveLength(2);
  });
});

describe("the reviewer call says what it is", () => {
  test("an in-path review is tagged classifier, so the ledger can count it", async () => {
    const { controller, classifier } = setup([allow("high")]);
    const run = controller.startRun(["Write the report to /tmp/out/report.md."]);
    await run.review(outsideWrite("/tmp/out/report.md"));
    expect(classifier.calls[0]!.role).toBe("classifier");
  });
});
