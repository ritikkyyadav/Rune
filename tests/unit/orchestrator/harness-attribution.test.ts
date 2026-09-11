/**
 * Phase 3B Lane 0, harness half: every harness-generated message says why it
 * exists, every child says when it ran, and every write says whether it
 * changed anything.
 *
 * The measurement this answers (docs/program/phase-3-auto-efficiency.md §4):
 *
 *  - I2 — of the twenty-one `role: "user"` messages the loop creates, two are
 *    the user's own and nineteen are synthetic. Nine carried an origin; the
 *    rest passed none and were therefore never persisted at all. The corpus
 *    shows the consequence exactly: 1 of 1,210 `user_msg` rows carried one, so
 *    a detached run's database could not say what re-prompted the model.
 *  - I4 — zero `delegation_checkpoint` rows exist in the corpus, so worker
 *    startup and integration time could not be measured: the `workers` row is
 *    dispatch-to-result and includes the child's own work.
 *  - I6 — "time after the last useful edit" was inferred from the last
 *    assistant message that CALLED an edit tool, which counts an edit that
 *    changed nothing.
 */

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { buildLifecycle } from "../../../packages/orchestrator/src/lifecycle";
import { buildChildSummary } from "../../../packages/orchestrator/src/subagent-result";

const ROOT = join(import.meta.dir, "..", "..", "..");
const AGENT_LOOP = join(ROOT, "packages/orchestrator/src/agent-loop.ts");

// ─── I2: an origin on every harness-generated message ───

/**
 * Every `this.appendMessage(...)` call in the loop, with the first argument's
 * message role and whether a second (origin) argument was passed.
 *
 * A source scan rather than a run, because the claim is about ALL of them — a
 * test that drives one gate proves one gate. This is the same technique the
 * drift law uses on the event reducers, and for the same reason: the property
 * is "nothing was missed", which no single execution can show.
 */
function appendMessageCalls(): Array<{ line: number; msgRole: string; origin: string | null }> {
  const src = readFileSync(AGENT_LOOP, "utf8");
  const needle = "this.appendMessage(";
  const out: Array<{ line: number; msgRole: string; origin: string | null }> = [];
  let idx = 0;
  while ((idx = src.indexOf(needle, idx)) !== -1) {
    const start = idx + needle.length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const c = src[i]!;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === "\\") i++;
          i++;
        }
      }
      i++;
    }
    const body = src.slice(start, i - 1);
    // Split on top-level commas only.
    const args: string[] = [];
    let cur = "";
    let d = 0;
    for (let j = 0; j < body.length; j++) {
      const c = body[j]!;
      if (c === "(" || c === "{" || c === "[") d++;
      else if (c === ")" || c === "}" || c === "]") d--;
      else if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        cur += c;
        j++;
        while (j < body.length && body[j] !== quote) {
          if (body[j] === "\\") {
            cur += body[j];
            j++;
          }
          cur += body[j];
          j++;
        }
      }
      if (c === "," && d === 0) {
        args.push(cur.trim());
        cur = "";
        continue;
      }
      cur += c;
    }
    if (cur.trim()) args.push(cur.trim());
    const first = args[0] ?? "";
    out.push({
      line: src.slice(0, idx).split("\n").length,
      msgRole: /role:\s*"(\w+)"/.exec(first)?.[1] ?? "?",
      // The user's OWN words are the two calls that build their content with
      // `buildUserContent` — the initial message and a mid-turn interjection.
      // Nothing synthetic goes through it, so it is the discriminator.
      origin:
        args.length > 1 ? args[1]!.trim() : first.includes("buildUserContent(") ? "USER" : null,
    });
    idx = i;
  }
  return out;
}

describe("I2 — a reason on every harness-generated message", () => {
  test("every synthetic user message the loop appends carries an origin", () => {
    const untagged = appendMessageCalls()
      .filter((c) => c.msgRole === "user" && c.origin === null)
      .map((c) => `agent-loop.ts:${c.line}`);
    expect(untagged).toEqual([]);
  });

  test("the user's own two messages are NOT tagged as harness output", () => {
    // The inverse half of the same law. A marker on these would persist the
    // user's words as a harness re-prompt, which is the opposite lie.
    const own = appendMessageCalls().filter((c) => c.origin === "USER");
    expect(own).toHaveLength(2);
    expect(own.every((c) => c.msgRole === "user")).toBe(true);
  });

  test("every origin uses the <kind>:<name> grammar the persisted row reads", () => {
    const KINDS = new Set(["gate", "nudge", "wind", "wrapup", "halt", "image"]);
    const origins = appendMessageCalls()
      .map((c) => c.origin)
      .filter((o): o is string => o !== null && o !== "USER")
      .map((o) => o.replace(/^"|"$/g, ""));
    expect(origins.length).toBeGreaterThanOrEqual(19);
    for (const origin of origins) {
      // `wind` is the one pre-existing bare kind; everything else is
      // "<kind>:<name>" and every kind is one the vocabulary knows.
      const kind = origin.includes(":") ? origin.slice(0, origin.indexOf(":")) : origin;
      expect(KINDS.has(kind)).toBe(true);
    }
  });

  test("the tagged origins are distinct, so two mechanisms never read as one", () => {
    const origins = appendMessageCalls()
      .map((c) => c.origin)
      .filter((o): o is string => o !== null && o !== "USER");
    expect(new Set(origins).size).toBe(origins.length);
  });
});

// ─── I4: worker / sub-agent start and integrate timestamps ───

describe("I4 — a child reports when it started and when it was integrated", () => {
  test("both stamps ride onto the lifecycle child row as ISO strings", () => {
    const startedAt = new Date("2026-09-11T10:00:00.000Z");
    const integratedAt = new Date("2026-09-11T10:04:30.000Z");
    const child = buildChildSummary({
      stopReason: "end_turn",
      integration: "merged",
      conflicts: [],
      startedAt,
      integratedAt,
    });
    expect(child.startedAt).toBe("2026-09-11T10:00:00.000Z");
    expect(child.integratedAt).toBe("2026-09-11T10:04:30.000Z");
    // The interval the lead could never see: its own clock measures
    // dispatch-to-result, which includes startup and the merge.
    expect(new Date(child.integratedAt!).getTime() - new Date(child.startedAt!).getTime()).toBe(
      270_000,
    );
  });

  test("a child that reports neither leaves both absent, not zeroed", () => {
    const child = buildChildSummary({ stopReason: "end_turn" });
    expect(child.startedAt).toBeUndefined();
    expect(child.integratedAt).toBeUndefined();
  });

  test("the stamps survive the lifecycle projection onto the persisted row", () => {
    // `buildChildSummary` putting them on the live child is only half the
    // journey. `buildLifecycle` rebuilds each child from a named field list
    // before it is emitted and persisted, and the first version of I4 did not
    // extend it — so `recordChild` set both stamps and the projection deleted
    // them one call later. Measured on a scripted `task` run at the time:
    // 5 lifecycle rows, 3 child rows, zero occurrences of "integratedAt"
    // anywhere in the session log (V-L0 #17).
    const lc = buildLifecycle({
      id: "s1",
      kind: "lead",
      objective: "o",
      constraints: [],
      workspace: { root: "/tmp/x", head: null, dirty: false },
      status: "running",
      budget: {
        turnsUsed: 1,
        turnsMax: 10,
        secondWindsUsed: 0,
        tokensIn: 0,
        tokensOut: 0,
        spentUsd: 0,
        capUsd: null,
        reservedUsd: 0,
      },
      checkpoint: null,
      todos: [],
      checks: [],
      verifiedCriteria: 0,
      children: [
        {
          id: "task_1",
          kind: "task",
          status: "end_turn",
          startedAt: "2026-09-11T10:00:00.000Z",
          integratedAt: "2026-09-11T10:04:30.000Z",
        },
        // A child from an older build that reports neither.
        { id: "task_2", kind: "task", status: "end_turn" },
      ],
    });
    expect(lc.children[0]!.startedAt).toBe("2026-09-11T10:00:00.000Z");
    expect(lc.children[0]!.integratedAt).toBe("2026-09-11T10:04:30.000Z");
    // Absent, not zeroed — an unmeasured stamp must not read as an instant run.
    expect(lc.children[1]!.startedAt).toBeUndefined();
    expect(lc.children[1]!.integratedAt).toBeUndefined();
    expect("startedAt" in lc.children[1]!).toBe(false);
  });

  test("both dispatch paths in the source pass the stamps they observed", () => {
    // buildChildSummary can only report what its callers hand it, and there
    // are four of them: two in subagent.ts (partial and full result) and two
    // in worker.ts (retained and merged).
    for (const file of ["subagent.ts", "worker.ts"]) {
      const src = readFileSync(join(ROOT, "packages/orchestrator/src", file), "utf8");
      const calls = src.match(/buildChildSummary\(/g) ?? [];
      const stamped = src.match(/startedAt: childStartedAt/g) ?? [];
      expect(stamped.length).toBe(calls.length);
      expect((src.match(/integratedAt: new Date\(\)/g) ?? []).length).toBe(calls.length);
    }
  });
});

// ─── I6: a useful_edit marker ───

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

type Step = { tool?: string; args?: Record<string, unknown>; text?: string; fail?: boolean };

function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      if (t.tool) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: t.tool });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: t.args ?? {} });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({
      content: [{ type: "text", text: "s" }],
      model: "t",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

function makeRegistry(turns: Step[]) {
  let call = 0;
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: ["write_file", "edit_file", "multi_edit", "apply_patch"].includes(name)
          ? "write"
          : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => {
      const step = turns[call++];
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: !step?.fail,
        result: step?.fail ? "" : "ok",
        error: step?.fail ? "permission denied" : undefined,
        durationMs: 1,
      };
    }),
  } as any;
}

async function runLoop(turns: Step[]): Promise<AgentLoop> {
  const loop = new AgentLoop(
    { model: "m", provider: "anthropic" as const, maxTokens: 100, maxTurns: turns.length + 1 },
    makeGateway(turns),
    makeRegistry(turns.filter((t) => t.tool)),
    mock(async () => ({ allowed: true })) as any,
  );
  const out: AgentTurnEvent[] = [];
  for await (const e of loop.run("go", "s1", ROOT)) out.push(e);
  return loop;
}

describe("I6 — a useful_edit marker on the call that wrote something", () => {
  test("a write that named a changed file is a useful edit", async () => {
    const loop = await runLoop([
      { tool: "write_file", args: { path: "src/a.ts", content: "x" } },
      { text: "done" },
    ]);
    expect(loop.usefulEditOf("c1")).toBe(true);
  });

  test("a write that changed nothing is recorded as not useful, not as absent", async () => {
    // `apply_patch` with no patch text and no result files names nothing it
    // changed. Before I6 this was indistinguishable from a real edit, because
    // the inference read "the model CALLED an edit tool".
    const loop = await runLoop([{ tool: "apply_patch", args: {} }, { text: "done" }]);
    expect(loop.usefulEditOf("c1")).toBe(false);
  });

  test("a write that was refused is not a useful edit", async () => {
    const loop = await runLoop([
      { tool: "write_file", args: { path: "src/a.ts", content: "x" }, fail: true },
      { text: "done" },
    ]);
    expect(loop.usefulEditOf("c1")).toBe(false);
  });

  test("a read carries no verdict at all — absent means 'not a write'", async () => {
    const loop = await runLoop([{ tool: "read_file", args: { path: "src/a.ts" } }, { text: "d" }]);
    expect(loop.usefulEditOf("c1")).toBeUndefined();
  });

  test("the last useful edit is readable from the calls, not inferred", async () => {
    const loop = await runLoop([
      { tool: "write_file", args: { path: "src/a.ts", content: "x" } },
      { tool: "apply_patch", args: {} },
      { tool: "read_file", args: { path: "src/a.ts" } },
      { text: "done" },
    ]);
    const verdicts = ["c1", "c2", "c3"].map((id) => loop.usefulEditOf(id));
    expect(verdicts).toEqual([true, false, undefined]);
  });
});
