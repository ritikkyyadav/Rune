/**
 * Phase 5 F4 — the architecture plan, through the real AgentLoop with a
 * scripted provider. Zero model calls.
 *
 * Three behaviours, each in the loop rather than in a unit:
 *   - a step closed over an open dependency comes back as a REFUSED tool call
 *     the model reads, and the plan on record never takes the lie;
 *   - a step whose check fails while it rests on an earlier step's declared
 *     interface goes through the existing replan path, naming the interface;
 *   - a plan with no dependencies is untouched by either.
 *
 * Then F5's `dependent-interface` fixture: green against the hand-written
 * solution, red against the deliberately inconsistent step 3 — and red in
 * exactly the two places that exercise step 1's interface through step 3's
 * caller, which is the whole point of the fixture.
 */

import { describe, expect, test, mock } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { materialise, runAcceptance } from "./fixtures/phase5/harness";
import { AgentLoop, type AgentTurnEvent } from "../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../packages/orchestrator/src/task-state";
import type { TodoItem } from "@rune/protocol";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tools?: Array<{ name: string; args?: Record<string, unknown> }>; text?: string };

function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      if (t.tools && t.tools.length > 0) {
        for (let k = 0; k < t.tools.length; k++) {
          yield ev("tool_use_start", { toolCallId: `c${i}-${k}`, toolName: t.tools[k]!.name });
          yield ev("tool_use_stop", {
            toolCallId: `c${i}-${k}`,
            toolInput: t.tools[k]!.args ?? {},
          });
        }
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({
      content: [],
      model: "m",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as never;
}

/** `todo_write` echoes its input, exactly as the real tool does. */
function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    list: mock(() => [{ name: "write_file" }, { name: "bash" }, { name: "todo_write" }]),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "write_file" ? "write" : name === "bash" ? "execute" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args?: unknown }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result:
        input.toolName === "todo_write"
          ? JSON.stringify({ items: (input.args as { items?: unknown }).items ?? [] })
          : "ok",
      durationMs: 1,
    })),
  } as never;
}

const PLAN: TodoItem[] = [
  {
    content: "expose priceFor(sku, qty) from pricing/index.ts",
    status: "pending",
    kind: "change",
    interface: "export function priceFor(sku: string, qty: number): Money",
    invariant: "every existing caller of computeTotal keeps its result",
  },
  { content: "move the rules into pricing/rules.ts", status: "in_progress", kind: "change" },
  {
    content: "point the checkout at priceFor and delete computeTotal",
    status: "pending",
    kind: "change",
    dependsOn: [1],
  },
];

function makeLoop(
  gateway: unknown,
  taskState: TaskStateStore,
  stepCheck?: (signal: unknown, files: unknown) => Promise<unknown>,
) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 8,
      systemPrompt: "s",
      taskState,
      ...(stepCheck ? { stepCheck } : {}),
    } as never,
    gateway as never,
    makeRegistry() as never,
  );
}

describe("F4 — a step cannot close over an open dependency", () => {
  test("the model's todo_write comes back refused, and the ledger keeps the truth", async () => {
    const ts = new TaskStateStore();
    ts.setEvidenceGate("refuse");
    const closingEarly = [
      PLAN[0]!,
      PLAN[1]!,
      { ...PLAN[2]!, status: "completed" as const },
    ] as TodoItem[];
    const gw = makeGateway([
      { tools: [{ name: "todo_write", args: { items: PLAN } }] },
      { tools: [{ name: "todo_write", args: { items: closingEarly } }] },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    const events = await collect(
      loop.run("migrate the pricing rules into a module", "arch", "/tmp"),
    );

    const ends = events.filter(
      (e) =>
        e.type === "tool_call_end" &&
        (e as { output?: { toolName?: string } }).output?.toolName === "todo_write",
    ) as Array<{ output?: { success?: boolean; error?: string } }>;
    expect(ends).toHaveLength(2);
    expect(ends[0]!.output?.success).toBe(true);
    expect(ends[1]!.output?.success).toBe(false);
    expect(ends[1]!.output?.error).toContain("depends on step 1");
    expect(ends[1]!.output?.error).toContain("still open");
    // The plan on record never took the lie.
    expect(ts.todos[2]!.status).not.toBe("completed");
    // And the architecture fields the model supplied are on the record.
    expect(ts.todos[0]!.interface).toContain("priceFor");
    expect(ts.todos[2]!.dependsOn).toEqual([1]);
  });

  test("the architecture doctrine rode the first request of this run", async () => {
    const gw = makeGateway([{ text: "done" }]) as { inferStream: unknown };
    let first = "";
    const stream = gw.inferStream as (r: unknown) => AsyncGenerator<unknown>;
    gw.inferStream = async function* (request: unknown) {
      first ||= JSON.stringify(request);
      yield* stream(request);
    };
    await collect(
      makeLoop(gw, new TaskStateStore()).run("migrate the storage layer", "arch2", "/tmp"),
    );
    expect(first).toContain("# The architecture plan");
    expect(first).toContain("interface");
  });
});

describe("F4 — a check failing on an earlier step's interface asks for a replan", () => {
  /**
   * The late architectural inconsistency the handoff names: step 3's check
   * fails, and step 3 rests on step 1's declared interface. The repair is not
   * to patch step 3.
   */
  test("the replan path fires once, naming the upstream interface", async () => {
    const ts = new TaskStateStore();
    const opened = [
      PLAN[0]!,
      PLAN[1]!,
      { ...PLAN[2]!, status: "in_progress" as const },
    ] as TodoItem[];
    const closing = [
      { ...PLAN[0]!, status: "completed" as const },
      { ...PLAN[1]!, status: "completed" as const },
      { ...PLAN[2]!, status: "completed" as const },
    ] as TodoItem[];
    const gw = makeGateway([
      { tools: [{ name: "todo_write", args: { items: opened } }] },
      { tools: [{ name: "write_file", args: { path: "checkout.ts" } }] },
      { tools: [{ name: "todo_write", args: { items: closing } }] },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts, async () => ({
      ran: true,
      passed: false,
      report: "$ bun test (exit 1)\npriceFor is not a function",
      runs: [{ command: "bun test", passed: false, exitCode: 1, durationMs: 3 }],
    }));
    const events = await collect(loop.run("migrate the pricing rules", "arch3", "/tmp"));

    const replans = events.filter((e) => e.type === "replanning") as Array<{ reason: string }>;
    expect(replans.some((r) => r.reason.includes("declared interface"))).toBe(true);
    // Fires once, not on every failing check.
    expect(replans.filter((r) => r.reason.includes("declared interface"))).toHaveLength(1);
    const transcript = JSON.stringify(loop.getMessages());
    expect(transcript).toContain("priceFor(sku: string, qty: number): Money");
    expect(transcript).toContain("fix it AT ITS OWN STEP");
  });

  test("a failing check with no upstream interface does not fire it", async () => {
    const plain: TodoItem[] = [
      { content: "fix the quote handling", status: "in_progress", kind: "change" },
    ];
    const gw = makeGateway([
      { tools: [{ name: "todo_write", args: { items: plain } }] },
      { tools: [{ name: "write_file", args: { path: "csv.ts" } }] },
      {
        tools: [{ name: "todo_write", args: { items: [{ ...plain[0]!, status: "completed" }] } }],
      },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, new TaskStateStore(), async () => ({
      ran: true,
      passed: false,
      report: "$ bun test (exit 1)",
      runs: [{ command: "bun test", passed: false, exitCode: 1, durationMs: 3 }],
    }));
    const events = await collect(loop.run("fix the CSV quote handling", "plain", "/tmp"));
    expect(
      (events.filter((e) => e.type === "replanning") as Array<{ reason: string }>).some((r) =>
        r.reason.includes("declared interface"),
      ),
    ).toBe(false);
  });
});

// ─── F5 — the dependent-interface fixture ───

describe("F5 — the dependent-interface fixture", () => {
  const dir = join(import.meta.dir, "fixtures", "phase5", "dependent-interface");

  test("is shaped the way the corpus lane expects, and names its own defect", () => {
    for (const file of [
      "task.json",
      "acceptance.json",
      "files",
      "solution",
      "solution-inconsistent",
    ]) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
    const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf-8")) as {
      id: string;
      family: string;
      prompt: string;
      inconsistency: string;
    };
    expect(task.id).toBe("dependent-interface");
    expect(task.family).toBe("migration");
    expect(task.inconsistency).toContain("bare number");
    expect(task.prompt).not.toContain("acceptance");
    // The prompt says what money must CARRY, never the signature: a prompt
    // that dictates the interface cannot test whether the plan declared one.
    expect(task.prompt).not.toContain("priceFor");
    expect(task.prompt).not.toContain("Money");
  });

  test("green against the hand-written solution", () => {
    const work = materialise(dir, "solution");
    try {
      const result = runAcceptance(work, join(dir, "acceptance.json"));
      expect(result.failed).toEqual([]);
      expect(result.passed).toHaveLength(7);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  /**
   * The late architectural inconsistency, measured. Step 3 is written against
   * the interface step 1 was assumed to expose. Nothing throws and every
   * criterion that checks step 1 or step 2 IN ISOLATION passes — which is
   * exactly why a plan judged on its prose, or a run judged on its own green
   * tests, would call this done.
   */
  test("red against the deliberately inconsistent step 3, at the seam and nowhere else", () => {
    const work = materialise(dir, "solution-inconsistent");
    try {
      const result = runAcceptance(work, join(dir, "acceptance.json"));
      expect(result.failed.sort()).toEqual(["checkout-currency", "checkout-total"]);
      expect(result.passed.sort()).toEqual([
        "catalog-untouched",
        "discount-applied",
        "money-interface",
        "old-export-gone",
        "rules-extracted",
      ]);
      // It renders; it does not crash. That is what makes it worth catching.
      const proc = Bun.spawnSync(
        [
          "bun",
          "-e",
          'const c=await import("./checkout.js");console.log(c.summarise({items:[{sku:"desk-01",qty:1}]}))',
        ],
        { cwd: work, stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(0);
      expect(new TextDecoder().decode(proc.stdout)).toContain("NaN");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
