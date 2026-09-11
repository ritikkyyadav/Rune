/**
 * Compaction is bounded.
 *
 * `compactWorkingSet` used to await the summarizer with no clock and no abort:
 * a candidate walk plus live-model recovery could stall a turn for minutes
 * with nothing the user could do. Now it carries the run's abort signal and a
 * wall-clock budget, and past either it takes the deterministic tier instead.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  COMPACTION_SUMMARY_ORIGIN,
  ContextEngine,
  harnessOriginOf,
  SESSION_CONTEXT_ORIGIN,
} from "../../../packages/orchestrator/src/context-engine";
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

// ─── C1 — a MERGE is a merge of STATE, never of fidelity ───
//
// `docs/program/phase-3-auto-efficiency.md` §2.4: a compaction completion is
// the single most expensive call in the system, 62,179 fresh tokens each. C1
// went after that by rendering every compaction that carries a prior state at
// 900 characters per tool result instead of 2,400, on the reasoning that the
// accumulated state was already carrying the run's history.
//
// V-C proved the reasoning wrong about WHICH messages those are.
// `transcriptMessages` is `toSummarize.slice(1)` — the previous compaction's
// verbatim tail plus everything since — material the prior state has never
// seen. The merge is that segment's one and only read: a criterion in the
// middle of a 2,400-char result was being dropped for good, in exactly the long
// runs where resume fidelity matters most.
//
// So these cases pin the corrected contract:
//  - every segment is read at FULL fidelity, prior state or not;
//  - the tighter budget applies per RESULT and only where it is lossless — a
//    body this engine already showed a summarizer whole, in a compaction whose
//    summary was adopted;
//  - a diff is never clipped below the full budget, however often it is seen;
//  - nothing is dropped, and the accumulated state still travels.

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

  test("the merge reads its new segment at the SAME fidelity the first read got", async () => {
    const { rig, second } = await twoCompactions();
    const body = `note 1 ${"z".repeat(9_000)}`.length;
    const read = clippedCounts(rig.seen[0]!);
    const merge = clippedCounts(rig.seen[1]!);
    expect(read.length).toBeGreaterThan(0);
    expect(merge.length).toBeGreaterThan(0);
    // 2,400 characters of every body, on both requests. The segment the merge
    // is handed is NEW — the prior state cannot carry what it never saw — so
    // this is its one and only read and it gets the full budget.
    for (const cut of read) expect(body - cut).toBeGreaterThan(2_300);
    for (const cut of merge) expect(body - cut).toBeGreaterThan(2_300);
    // Nothing was dropped either: every read the segment contained is
    // still named, with its path, and the count of bodies matches the count of
    // calls. `summarizedCount` is the segment length the engine folded.
    const calls = [...rig.seen[1]!.matchAll(/\[tool: read_file\(/g)].length;
    expect(resultCount(rig.seen[1]!)).toBe(calls);
    expect(rig.seen[1]).toContain("docs/note-9.md");
    expect(rig.seen[1]).not.toContain("older messages omitted");
    expect(second.summarizedCount).toBeGreaterThanOrEqual(calls);
  });

  /**
   * The one place the merge budget is lossless, and the proof that it is not
   * applied anywhere else.
   *
   * `compactWorkingSet`'s input is the CALLER'S (it is a documented public
   * contract), so a result can be handed to it again after an adopted
   * compaction already showed the summarizer that exact body in full. Only
   * then may it be re-rendered head+tail at 900: the state being updated is
   * that summarizer's own answer about it.
   */
  test("only a body the summarizer already read whole is re-rendered at the merge budget", async () => {
    const rig = recordingGateway(MERGED_STATE);
    const eng = engine(rig.gateway);
    // 2,000 characters: rendered whole by the first read (the budget is 2,400),
    // and long enough that a 900-char clip is visible in the marker.
    const spec = `SPEC ${"s".repeat(1_995)}`;
    const seen: Message[] = [
      { role: "user", content: [{ type: "text", text: "check the spec" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", toolCallId: "spec", toolName: "read_file", toolInput: { path: "S" } },
        ] as any,
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "spec", toolResultContent: spec }] as any,
      },
    ];
    const first = await eng.compactWorkingSet([...seen, ...reads(1, 8)], 3, { budgetMs: 30_000 });
    expect(first.compacted).toBe(true);
    expect(rig.seen[0]).toContain(spec); // read whole, and the summary was adopted

    // Hand the SAME result back, beside one the summarizer has never seen.
    const fresh = `FRESH ${"f".repeat(1_994)}`;
    const unseen: Message[] = [
      { role: "user", content: [{ type: "text", text: "and the notes" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", toolCallId: "new", toolName: "read_file", toolInput: { path: "N" } },
        ] as any,
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "new", toolResultContent: fresh }] as any,
      },
    ];
    const second = await eng.compactWorkingSet(
      [...first.messages, ...seen, ...unseen, ...reads(9, 8)],
      3,
      { budgetMs: 30_000 },
    );
    expect(second.compacted).toBe(true);
    expect(rig.seen[1]).toContain("PRIOR STATE:");
    // The re-read is clipped — head+tail, its middle already digested.
    expect(rig.seen[1]).not.toContain(spec);
    expect(rig.seen[1]).toContain(`[${spec.length - 900} chars clipped]`);
    // The one the summarizer has never seen is whole, prior state or not.
    expect(rig.seen[1]).toContain(fresh);
  });

  test("a diff is never clipped below the full budget, however often it is seen", async () => {
    const rig = recordingGateway(MERGED_STATE);
    const eng = engine(rig.gateway);
    const diff = [
      "*** Begin Patch",
      "--- a/src/api.ts",
      "+++ b/src/api.ts",
      "@@ -1,4 +1,4 @@",
      `-export const VERSION = "0.9.0";${" ".repeat(900)}`,
      `+export const VERSION = "1.0.0";${" ".repeat(900)}`,
      "*** End Patch",
    ].join("\n");
    const patch: Message[] = [
      { role: "user", content: [{ type: "text", text: "bump it" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            toolCallId: "p1",
            toolName: "apply_patch",
            toolInput: { path: "src/api.ts" },
          },
        ] as any,
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "p1", toolResultContent: diff }] as any,
      },
    ];
    const first = await eng.compactWorkingSet([...patch, ...reads(1, 8)], 3, { budgetMs: 30_000 });
    expect(first.compacted).toBe(true);
    expect(rig.seen[0]).toContain(diff);
    // Handed back after an adopted compaction — the one case the merge budget
    // would otherwise apply. The change a patch carries lives in the middle of
    // its own body, so the exemption is absolute.
    const second = await eng.compactWorkingSet([...first.messages, ...patch, ...reads(9, 8)], 3, {
      budgetMs: 30_000,
    });
    expect(second.compacted).toBe(true);
    expect(rig.seen[1]).toContain("PRIOR STATE:");
    expect(rig.seen[1]).toContain(diff);
  });

  test("a summary that was NOT adopted teaches the engine nothing", async () => {
    // A summarizer whose answer is BIGGER than the head it would replace, which
    // is the `noop` branch: the compaction is abandoned and the transcript
    // stays. The bodies were shown to a summarizer, but nothing kept what it
    // said about them, so they are still the only record of themselves.
    const rig = recordingGateway(`${MERGED_STATE}\n${"prose. ".repeat(600)}`);
    const eng = engine(rig.gateway);
    const spec = `SPEC ${"s".repeat(1_995)}`;
    const short: Message[] = [
      { role: "user", content: [{ type: "text", text: "check the spec" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", toolCallId: "spec", toolName: "read_file", toolInput: { path: "S" } },
        ] as any,
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "spec", toolResultContent: spec }] as any,
      },
      { role: "user", content: [{ type: "text", text: "and?" }] },
      { role: "assistant", content: [{ type: "text", text: "working" }] },
      { role: "user", content: [{ type: "text", text: "carry on" }] },
      { role: "assistant", content: [{ type: "text", text: "on it" }] },
    ];
    const noop = await eng.compactWorkingSet(short, 2, { budgetMs: 30_000 });
    expect(noop.compacted).toBe(false);
    expect(noop.noop).toBe(true);
    expect(rig.seen[0]).toContain(spec);

    const second = await eng.compactWorkingSet([...short, ...reads(1, 8)], 3, {
      budgetMs: 30_000,
    });
    expect(second.compacted).toBe(true);
    // Read whole again: a discarded summary is not a record of anything.
    expect(rig.seen[1]).toContain(spec);
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

// ─── V-L0 #15 — the two user messages the engine AUTHORS say so ───
//
// `role: "user"` is a wire convention here, not a claim about who spoke. Two
// messages in this file are written by the harness: the summary that replaces a
// folded segment, and the `[Session context]` block `buildPrompt` prepends to a
// request. Neither goes through `AgentLoop.appendMessage`, so neither could
// carry the origin the persisted `user_msg.harness` mechanism reads — and an
// untagged synthetic message that reaches persistence is filed as the USER'S
// OWN WORDS. That is an audit lie (a detached run cannot say what re-prompted
// the model) and a trust one: `engine.ts` hands persisted user text to the
// permission check as trusted input, and the summary is the summarizer's prose
// about tool output, which is exactly what a prompt injection would target.

describe("V-L0 #15 — a harness-authored user message carries its origin", () => {
  test("the compaction summary is stamped where it is created", async () => {
    const rig = recordingGateway(MERGED_STATE);
    const eng = engine(rig.gateway);
    const r = await eng.compactWorkingSet(reads(1, 8), 3, { budgetMs: 30_000 });
    expect(r.compacted).toBe(true);
    const summary = r.messages[0]!;
    expect((summary.content[0] as any).text).toStartWith("[Earlier conversation summary]");
    expect(summary.role).toBe("user");
    expect(harnessOriginOf(summary)).toBe(COMPACTION_SUMMARY_ORIGIN);
  });

  test("the `[Session context]` block is stamped too", () => {
    const eng = engine(recordingGateway(MERGED_STATE).gateway);
    const built = eng.buildPrompt(
      "S",
      [],
      [{ role: "user", content: [{ type: "text", text: "where is the retry?" }] }],
      [{ content: "the retry ladder lives in gateway.ts", relevance: 1 }] as any,
    );
    const aux = built.messages[0]!;
    expect((aux.content[0] as any).text).toStartWith("[Session context]");
    expect(harnessOriginOf(aux)).toBe(SESSION_CONTEXT_ORIGIN);
  });

  test("the user's own messages are not stamped — the inverse half of the law", async () => {
    const rig = recordingGateway(MERGED_STATE);
    const eng = engine(rig.gateway);
    const mine: Message[] = reads(1, 8);
    const r = await eng.compactWorkingSet(mine, 3, { budgetMs: 30_000 });
    expect(r.compacted).toBe(true);
    for (const m of r.messages.slice(1)) expect(harnessOriginOf(m)).toBeUndefined();
    for (const m of mine) expect(harnessOriginOf(m)).toBeUndefined();
  });
});
