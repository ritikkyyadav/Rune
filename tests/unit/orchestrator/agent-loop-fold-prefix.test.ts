/**
 * The folded tail is HISTORY: what a request sent, the next request sends
 * again (P3B §3.3).
 *
 * On the one host where a request that ends on a user message ends the prompt
 * cache (`foldsEphemeralTail` — codex, measured on gpt-5.6-sol), the plan
 * ledger rides inside the last stable message instead of after it. That
 * message is STORED bare, so the next request replayed it bare and the two
 * requests diverged one message before the end — at the conversation's largest
 * item, the tool output the model had just read. The fold was bought to stop
 * Pilot H's flat 12,160 cached tokens and it gave back a prefix that could
 * never extend by more than one turn.
 *
 * Two properties, and they are the whole fix:
 *
 *   1. a tail folded into a message is folded into that message on every later
 *      request, byte for byte — the stale block is a true record of the ledger
 *      when that message went out, and only the newest message carries the
 *      current one;
 *   2. the composition meter measures the messages that GO OUT, so `prefixHash`
 *      fingerprints what the provider's cache will match on. It used to be
 *      handed the pre-fold messages, which is why I5 reported two requests as
 *      sharing a prefix where the wire had them diverging.
 *
 * Driven through the real `AgentLoop` on a codex-shaped route against a mock
 * gateway (no network, no model), with a non-folding host as the control.
 */

import { describe, test, expect } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import {
  measureComposition,
  messageBytes,
  utf8Bytes,
} from "../../../packages/llm-gateway/src/prompt-composition";
import type { Message, PromptComposition } from "../../../packages/llm-gateway/src/types";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

const registry = {
  toLlmTools: () => [],
  get: (name: string) => ({
    schema: {
      name,
      version: "0.1.0",
      description: "",
      inputSchema: { type: "object", properties: {} },
      category: "read",
      permissionLevel: "auto",
    },
  }),
  execute: async (i: { toolName: string; callId: string }) => ({
    callId: i.callId,
    toolName: i.toolName,
    success: true,
    result: `contents of ${i.callId}`,
    durationMs: 1,
  }),
} as any;

interface Sent {
  messages: Message[];
  system: string;
  composition?: PromptComposition;
}

/** Run three read turns on `provider`, returning every request the loop sent. */
async function runOn(
  provider: string,
  doctrine: { opening: string; working: string } = { opening: "doctrine", working: "doctrine" },
): Promise<Sent[]> {
  const sent: Sent[] = [];
  let i = 0;
  const gateway = {
    inferStream: async function* (request: any) {
      sent.push({
        messages: JSON.parse(JSON.stringify(request?.messages ?? [])),
        system: String(request?.system ?? ""),
        composition: request?.composition,
      });
      i++;
      if (i <= 3) {
        yield ev("tool_use_start", { toolCallId: `t${i}`, toolName: "read_file" });
        yield ev("tool_use_stop", { toolCallId: `t${i}`, toolInput: { path: `src/f${i}.ts` } });
        yield ev("message_stop", { stopReason: "tool_use" });
        return;
      }
      yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
      yield ev("message_stop", { stopReason: "end_turn" });
    },
    infer: async () => ({
      content: [],
      model: "m",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    registerProvider: () => {},
    getProvider: () => null,
    getTotalCost: () => 0,
  } as any;
  const taskState = new TaskStateStore();
  const loop = new AgentLoop(
    {
      model: "m",
      provider,
      maxTokens: 100,
      maxTurns: 8,
      systemPrompt: doctrine.opening,
      workingSystemPrompt: doctrine.working,
      taskState,
    } as any,
    gateway,
    registry,
  );
  // `run` calls beginTurn, which resets the plan; the todos go in after.
  let first = true;
  for await (const _ of loop.run("wire version() through the api", "s1", "/tmp")) {
    void _;
    if (first) {
      taskState.setTodos([
        { content: "read the api", status: "in_progress" },
        { content: "wire the client", status: "pending" },
      ] as any);
      first = false;
    }
  }
  return sent;
}

/** Messages of `a` that recur, byte-identical, as the head of `b`. */
function sharedMessages(a: Message[], b: Message[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
  return n;
}
/** Shared prefix of the serialised bodies, in bytes. */
function sharedBytes(a: Message[], b: Message[]): number {
  const x = JSON.stringify(a),
    y = JSON.stringify(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return new TextEncoder().encode(x.slice(0, i)).length;
}

const lastResultOf = (m: Message): string => {
  const results = m.content.filter((b) => b.type === "tool_result") as Array<{
    toolResultContent?: string;
  }>;
  return results[results.length - 1]?.toolResultContent ?? "";
};

describe("§3.3 — the folded tail and the prefix the cache matches on", () => {
  test("consecutive requests share the whole stable prefix, folding host or not", async () => {
    const codex = await runOn("codex");
    const chat = await runOn("openai");

    // Requests 1..n-1 are the ones carrying a tail (request 0 has no plan yet).
    // On codex the fold adds no message, so the wire length IS the stable count;
    // on a non-folding host the tail is one extra trailing user message.
    const report: Record<string, unknown[]> = { codex: [], openai: [] };
    for (const [host, rs, tailMsgs] of [
      ["codex", codex, 0],
      ["openai", chat, 1],
    ] as const) {
      for (let k = 1; k + 1 < rs.length - 1; k++) {
        const n = rs[k]!.messages;
        const next = rs[k + 1]!.messages;
        report[host]!.push({
          pair: `${k}->${k + 1}`,
          stableOfN: n.length - tailMsgs,
          sharedMessages: sharedMessages(n, next),
          sharedPrefixBytes: sharedBytes(n, next),
          bytesOfN: new TextEncoder().encode(JSON.stringify(n)).length,
        });
      }
    }
    console.log("[§3.3]", JSON.stringify(report, null, 1));

    expect((report.codex as any[]).length).toBeGreaterThan(0);
    for (const row of report.codex as any[]) {
      expect(Number.isFinite(row.stableOfN)).toBe(true);
      expect(row.sharedMessages).toBe(row.stableOfN);
    }
    for (const row of report.openai as any[]) expect(row.sharedMessages).toBe(row.stableOfN);
  });

  test("a message that went out carrying a tail is replayed carrying that tail", async () => {
    const codex = await runOn("codex");
    // The tail rode inside request 1's last message; request 2 replays it there
    // byte-identical, and its own newest output carries the current block.
    const carried = lastResultOf(codex[1]!.messages[codex[1]!.messages.length - 1]!);
    expect(carried).toContain("contents of t1");
    expect(carried).toContain("Task state");
    const replayed = lastResultOf(codex[2]!.messages[codex[1]!.messages.length - 1]!);
    expect(replayed).toBe(carried);
    const newest = lastResultOf(codex[2]!.messages[codex[2]!.messages.length - 1]!);
    expect(newest).toContain("contents of t2");
    expect(newest).toContain("Task state");
    // Nothing stored moved: the fold is a wire shape, not a transcript edit.
    // (The stored transcript is asserted bare in agent-loop-ephemeral-fold.)
  });

  test("the prefix fingerprint is the fingerprint of the bytes that went out", async () => {
    const codex = await runOn("codex");
    const hashOf = (s: Sent) =>
      measureComposition({ system: s.system, messages: s.messages }).prefixHash;
    for (const s of codex.slice(1)) {
      // I5's instrument, read off the request the loop built: the loop's own
      // row and an independent measurement of the same wire agree.
      expect(s.composition?.prefixHash).toBe(hashOf(s));
    }
    // …and because the prefix recurs, the fingerprint of request N is the
    // fingerprint of the head of request N+1 — which is exactly the question
    // "would the provider's cache entry from N match N+1".
    for (let k = 1; k + 1 < codex.length - 1; k++) {
      const head = codex[k + 1]!.messages.slice(0, codex[k]!.messages.length);
      expect(measureComposition({ system: codex[k + 1]!.system, messages: head }).prefixHash).toBe(
        hashOf(codex[k]!),
      );
    }
  });

  test("the parts still add up to the request, on either wire shape", async () => {
    for (const host of ["codex", "openai"]) {
      const sent = await runOn(host);
      for (const s of sent) {
        const wire = utf8Bytes(s.system) + s.messages.reduce((n, m) => n + messageBytes(m), 0);
        expect(s.composition?.total).toBe(wire);
      }
    }
  });
});

// ─── The doctrine phase, and the cache it would cost ───
//
// Turn 1 carries the opening doctrine and turn 2 onward a shorter working
// one. That is a pure saving where nothing is cached. Where a stable prefix
// IS cached, the one change means the second request matches nothing the first
// wrote: measured 2026-10-07 on Codex, three live runs out of three, the second
// request read 0 cached tokens and re-paid 12k to 18k.
describe("the doctrine phase does not change the prefix where the prefix is cached", () => {
  const DOCTRINE = {
    opening: "opening doctrine: read back, then plan",
    working: "working doctrine",
  };

  test.each(["codex", "anthropic", "openai", "google", "openrouter"])(
    "%s caches a stable prefix: one system prompt for the whole request",
    async (provider) => {
      const sent = await runOn(provider, DOCTRINE);
      expect(sent.length).toBeGreaterThanOrEqual(4);
      expect(sent.map((r) => r.system)).toEqual(sent.map(() => DOCTRINE.opening));
    },
  );

  test.each(["ollama", "ollama-turbo", "custom"])(
    "%s caches nothing: the shorter rendering from the second request on",
    async (provider) => {
      const sent = await runOn(provider, DOCTRINE);
      expect(sent.length).toBeGreaterThanOrEqual(4);
      expect(sent.map((r) => r.system)).toEqual([
        DOCTRINE.opening,
        ...sent.slice(1).map(() => DOCTRINE.working),
      ]);
    },
  );
});
