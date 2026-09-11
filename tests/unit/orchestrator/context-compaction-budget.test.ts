/**
 * Compaction is bounded.
 *
 * `compactWorkingSet` used to await the summarizer with no clock and no abort:
 * a candidate walk plus live-model recovery could stall a turn for minutes
 * with nothing the user could do. Now it carries the run's abort signal and a
 * wall-clock budget, and past either it takes the deterministic tier instead.
 */

import { describe, expect, mock, test } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "../../../packages/llm-gateway/src/types";

/** A summarizer that answers only when its request is aborted. */
function hangingGateway() {
  const infer = mock(
    (req: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        const fail = () => reject(new Error("aborted by caller"));
        if (req.signal?.aborted) fail();
        else req.signal?.addEventListener("abort", fail, { once: true });
      }),
  );
  return {
    infer,
    inferStream: mock(async function* () {}),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getRegisteredProviderNames: () => [],
    getTotalCost: mock(() => 0),
  } as any;
}

function conversation(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({
      role: "user",
      content: [{ type: "text", text: `question ${i} ${"x".repeat(200)}` }],
    });
    out.push({
      role: "assistant",
      content: [{ type: "text", text: `answer ${i} ${"y".repeat(200)}` }],
    });
  }
  return out;
}

const engine = (gw: any) =>
  new ContextEngine(
    { summarizeTurnsThreshold: 4, summarizerModel: "m", summarizerProvider: "anthropic" },
    gw,
  );

describe("compaction budget", () => {
  test("a hanging summarizer is cut off at the wall-clock budget, not left to stall the turn", async () => {
    const gw = hangingGateway();
    const started = Date.now();
    const r = await engine(gw).compactWorkingSet(conversation(8), 2, { budgetMs: 1_000 });
    const elapsed = Date.now() - started;
    expect(r.compacted).toBe(false);
    expect(r.failed).toBe(true);
    expect(r.failureReason).toContain("budget");
    expect(elapsed).toBeLessThan(4_000);
    // The request itself carried an abort signal, and it fired.
    const req = gw.infer.mock.calls[0]?.[0];
    expect(req?.signal?.aborted).toBe(true);
  });

  test("the run's own abort ends compaction immediately", async () => {
    const gw = hangingGateway();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const started = Date.now();
    const r = await engine(gw).compactWorkingSet(conversation(8), 2, {
      signal: ac.signal,
      budgetMs: 30_000,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.compacted).toBe(false);
    expect(r.failureReason).toContain("aborted");
  });

  test("past the budget, old tool-result bodies are evicted instead of giving up", async () => {
    const gw = hangingGateway();
    const messages: Message[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: "user", content: [{ type: "text", text: `read file ${i}` }] });
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            toolCallId: `t${i}`,
            toolName: "read_file",
            toolInput: { path: `f${i}` },
          },
        ] as any,
      });
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: `t${i}`,
            toolResultContent: "z".repeat(4_000),
          },
        ] as any,
      });
    }
    messages.push({ role: "user", content: [{ type: "text", text: "and now?" }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: "working" }] });
    const r = await engine(gw).compactWorkingSet(messages, 2, { budgetMs: 1_000 });
    expect(r.compacted).toBe(true);
    expect(r.tier).toBe("tool_results");
    expect(r.afterTokens!).toBeLessThan(r.beforeTokens!);
  });
});

// ─── C1 — a compaction that is a MERGE costs less than one that is a READ ───
//
// `docs/program/phase-3-auto-efficiency.md` §2.4: a compaction completion is
// the single most expensive call in the system, 62,179 fresh tokens each. The
// second and every later compaction of a run already merge into the previous
// summary rather than re-summarising it (`priorSummaryText`), but they were
// still rendering the new segment at FIRST-READ fidelity — 2,400 characters per
// tool result, which on the Lane C rig was 89% of the request.
//
// These tests pin the two halves of that: the merge request is materially
// smaller, and it is smaller WITHOUT dropping anything — every message in the
// segment is still rendered, and the accumulated state still travels.

/** A summarizer that answers, and keeps every request it was sent. */
function recordingGateway(summary: string) {
  const seen: string[] = [];
  const infer = mock(async (req: any) => {
    seen.push(
      (req.messages ?? [])
        .flatMap((m: any) => m.content.map((b: any) => (b.type === "text" ? b.text : "")))
        .join("\n"),
    );
    return {
      content: [{ type: "text", text: summary }],
      model: "m",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  });
  return {
    seen,
    gateway: {
      infer,
      inferStream: mock(async function* () {}),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getRegisteredProviderNames: () => [],
      getTotalCost: mock(() => 0),
    } as any,
  };
}

/** `n` read_file exchanges, each with a body far past any clip. */
function reads(from: number, n: number): Message[] {
  const out: Message[] = [];
  for (let i = from; i < from + n; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `read file ${i}` }] });
    out.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          toolCallId: `t${i}`,
          toolName: "read_file",
          toolInput: { path: `docs/note-${i}.md` },
        },
      ] as any,
    });
    out.push({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: `t${i}`,
          toolResultContent: `note ${i} ${"z".repeat(9_000)}`,
        },
      ] as any,
    });
  }
  return out;
}

const MERGED_STATE = [
  "## Goals & requirements",
  "Wire version() through the api and the client; the acceptance check must pass.",
  "## Key facts & codebase knowledge",
  "src/api.ts and src/client.ts are separate modules.",
  "## Actions taken & outcomes (files touched, commands run)",
  "Read the notes under docs/.",
  "## Decisions & open questions",
  "None open.",
  "## Current state & next step",
  "Run node check.mjs.",
].join("\n");

/**
 * How much each tool-result body had cut out of it, read off `clipText`'s own
 * marker (`…[N chars clipped]…`).
 *
 * The marker is the honest measure: the bodies here contain `]` themselves, so
 * a regex over `[result: …]` would stop at the first one and report a length
 * that is neither the body's nor the clip's.
 */
function clippedCounts(request: string): number[] {
  return [...request.matchAll(/\[(\d+) chars clipped\]/g)].map((m) => Number(m[1]));
}

/** How many tool results the request carried. */
function resultCount(request: string): number {
  return [...request.matchAll(/\[result: /g)].length;
}

describe("C1 — an incremental compaction is a merge, and costs like one", () => {
  async function twoCompactions() {
    const rig = recordingGateway(MERGED_STATE);
    const eng = engine(rig.gateway);
    const first = await eng.compactWorkingSet(reads(1, 8), 3, { budgetMs: 30_000 });
    expect(first.compacted).toBe(true);
    expect(first.tier).toBe("summarized");
    const second = await eng.compactWorkingSet([...first.messages, ...reads(9, 8)], 3, {
      budgetMs: 30_000,
    });
    expect(second.compacted).toBe(true);
    expect(second.tier).toBe("summarized");
    return { rig, first, second };
  }

  test("the first compaction reads; the second merges into what the first wrote", async () => {
    const { rig, second } = await twoCompactions();
    expect(rig.seen.length).toBe(2);
    expect(rig.seen[0]).not.toContain("PRIOR STATE:");
    expect(rig.seen[1]).toContain("PRIOR STATE:");
    // The accumulated state is what travels, not the prose of the old summary
    // re-compressed: the marker never reaches the transcript half.
    expect(rig.seen[1]).toContain("## Goals & requirements");
    expect(second.messages[0]!.content[0]).toMatchObject({ type: "text" });
    expect((second.messages[0]!.content[0] as any).text).toStartWith(
      "[Earlier conversation summary]",
    );
  });

  test("the merge request carries every message of the segment, at a tighter fidelity", async () => {
    const { rig, second } = await twoCompactions();
    const body = `note 1 ${"z".repeat(9_000)}`.length;
    const read = clippedCounts(rig.seen[0]!);
    const merge = clippedCounts(rig.seen[1]!);
    expect(read.length).toBeGreaterThan(0);
    expect(merge.length).toBeGreaterThan(0);
    // A first read keeps 2,400 characters of each body; a merge keeps 900. The
    // SHAPE is the same on both — head+tail with the clip marker — so a
    // command's first lines and a failure's last lines survive either way.
    for (const cut of read) expect(body - cut).toBeGreaterThan(2_300);
    for (const cut of merge) expect(body - cut).toBeLessThan(1_000);
    // Nothing was dropped to get there: every read the segment contained is
    // still named, with its path, and the count of bodies matches the count of
    // calls. `summarizedCount` is the segment length the engine folded.
    const calls = [...rig.seen[1]!.matchAll(/\[tool: read_file\(/g)].length;
    expect(resultCount(rig.seen[1]!)).toBe(calls);
    expect(rig.seen[1]).toContain("docs/note-9.md");
    expect(rig.seen[1]).not.toContain("older messages omitted");
    expect(second.summarizedCount).toBeGreaterThanOrEqual(calls);
  });

  test("the merge request is materially smaller than the read it follows", async () => {
    const { rig } = await twoCompactions();
    const enc = new TextEncoder();
    const read = enc.encode(rig.seen[0]!).length;
    const merge = enc.encode(rig.seen[1]!).length;
    // The second compaction folds MORE messages than the first (the first
    // one's verbatim tail plus everything since), so this is a conservative
    // comparison: more work, fewer bytes.
    expect(merge).toBeLessThan(read * 0.7);
  });

  test("a resumed run still has the spec: goals, constraints and the next step survive the merge", async () => {
    const { second } = await twoCompactions();
    const state = (second.messages[0]!.content[0] as any).text as string;
    for (const section of [
      "## Goals & requirements",
      "## Key facts & codebase knowledge",
      "## Actions taken & outcomes",
      "## Decisions & open questions",
      "## Current state & next step",
    ]) {
      expect(state).toContain(section);
    }
    expect(state).toContain("acceptance check must pass");
    expect(state).toContain("Run node check.mjs.");
  });
});
