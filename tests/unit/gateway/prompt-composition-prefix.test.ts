/**
 * §3.3 — does the ephemeral tail move the cacheable prefix?
 *
 * `docs/program/phase-3-auto-efficiency.md` §3.3 leaves one question open and
 * names the offline test for it. Pilot J attributed two full cache misses to
 * a just-in-time doctrine that does not exist at HEAD; read from the pilot's
 * own database, both misses instead follow a completion that changed the
 * TASK-STATE TAIL. On a folding host the tail rides inside the last tool
 * output, and it is rebuilt fresh every request and never stored in
 * `this.messages` — so the hypothesis is that a message which went out as
 * `tool_output + ledger` on request N is replayed BARE on request N+1, which
 * is a mid-prefix content change.
 *
 * §5.2 says this is decidable with no provider: "Diff consecutive
 * `RecordedRequest.raw` prefixes. A mid-prefix message whose content changed is
 * a byte diff, observable with no provider." That is what this file does, on
 * the two wire shapes the loop actually builds — `withTailFolded` for the one
 * host `foldsEphemeralTail` names, trailing user messages for every other. It
 * needs no mock server because neither shaping function talks to anything.
 *
 * **The answer is yes, on the folding host only, by exactly one message — and
 * on EVERY request that carries a tail, not only the ones whose ledger moved.**
 * That last part is wider than the design's hypothesis and is the finding: the
 * divergence is caused by the fold itself, not by the tail's content changing.
 * The tests below are the measurement; `.codex/audit-20260910/handoff/phase3/laneC-report.md`
 * carries what it means. The fix is inside `agent-loop.ts`, which Lane C does
 * not own, so it is recorded for the backlog rather than made here.
 */

import { describe, expect, test } from "bun:test";

import { withTailFolded } from "../../../packages/orchestrator/src/agent-loop";
import { foldsEphemeralTail } from "../../../packages/llm-gateway/src/providers/cache-policy";
import { measureComposition } from "../../../packages/llm-gateway/src/prompt-composition";
import type { Message } from "../../../packages/llm-gateway/src/types";

/** One read: the call and the output the model is about to read. */
function exchange(n: number): Message[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          toolCallId: `t${n}`,
          toolName: "read_file",
          toolInput: { path: `src/file-${n}.ts` },
        },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool_result", toolCallId: `t${n}`, toolResultContent: `contents of file ${n}` },
      ],
    },
  ];
}

/** The ledger block, as it reads before and after a criterion moves. */
const LEDGER_BEFORE = "[Task state — maintained by the harness, not a user message]\n0 of 2 met";
const LEDGER_AFTER = "[Task state — maintained by the harness, not a user message]\n1 of 2 met";

/** What the loop puts on the wire, for a host that does not fold. */
function appended(stable: Message[], blocks: string[]): Message[] {
  return [
    ...stable,
    ...blocks.map((text): Message => ({ role: "user", content: [{ type: "text", text }] })),
  ];
}

/** The first index at which two wire message arrays differ. */
function firstDivergence(a: Message[], b: Message[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
  }
  return n;
}

const START: Message[] = [{ role: "user", content: [{ type: "text", text: "wire version()" }] }];

describe("§3.3 — the ephemeral tail and the cacheable prefix", () => {
  const stableN = [...START, ...exchange(1)];
  const stableNext = [...stableN, ...exchange(2)];

  test("appended to the end (every host but one), the whole stable prefix recurs verbatim", () => {
    const requestN = appended(stableN, [LEDGER_BEFORE]);
    const requestNext = appended(stableNext, [LEDGER_AFTER]);
    // Divergence lands exactly AT the fold point — the first message of request
    // N's tail — so everything a cache could match on is byte-identical.
    expect(firstDivergence(requestN, requestNext)).toBe(stableN.length);
  });

  test("folded into the last tool output, the prefix diverges ONE MESSAGE EARLY", () => {
    const requestN = withTailFolded(stableN, [LEDGER_BEFORE]);
    const requestNext = withTailFolded(stableNext, [LEDGER_AFTER]);
    // The last stable message of request N carried the ledger inside its tool
    // output; on request N+1 that same message goes out bare, because nothing
    // stored ever held the tail. That is a mid-prefix content change on every
    // request that carries a tail — not a suffix change.
    expect(firstDivergence(requestN, requestNext)).toBe(stableN.length - 1);
    // And it is the fold that did it: the tail is INSIDE the tool result.
    const foldedResult = requestN[stableN.length - 1]!.content[0];
    expect(foldedResult.type).toBe("tool_result");
    if (foldedResult.type === "tool_result") {
      expect(foldedResult.toolResultContent).toContain("contents of file 1");
      expect(foldedResult.toolResultContent).toContain(LEDGER_BEFORE);
    }
    // Nothing stored was mutated — the defect is the replay, not a write.
    expect(stableN[stableN.length - 1]!.content[0]).toMatchObject({
      toolResultContent: "contents of file 1",
    });
  });

  test("an UNCHANGED tail diverges too — it is the fold, not the ledger moving", () => {
    // The design's hypothesis was narrower than the defect: it predicted a miss
    // on the requests whose ledger CHANGED ("request 4 follows read_back,
    // request 6 follows the first passing check"). Measured here, a tail that
    // did not change one byte still moves the prefix, because the divergence is
    // not the tail's content — it is that request N's last stable message went
    // out WITH a tail attached and request N+1 replays that same message bare.
    // Every request carrying any tail is affected, which fits Pilot H's flat
    // 12,160 cached tokens across nine consecutive completions far better than
    // a ledger-change-only theory does.
    const requestN = withTailFolded(stableN, [LEDGER_BEFORE]);
    const requestNext = withTailFolded(stableNext, [LEDGER_BEFORE]);
    expect(firstDivergence(requestN, requestNext)).toBe(stableN.length - 1);
    // The one shape that is safe: no tail at all on either request.
    expect(firstDivergence(stableN, stableNext)).toBe(stableN.length);
  });

  test("only one host folds, so only one host can have the defect", () => {
    expect(foldsEphemeralTail("codex")).toBe(true);
    for (const host of ["anthropic", "openai", "openrouter", "google", "custom", "ollama"]) {
      expect(foldsEphemeralTail(host)).toBe(false);
    }
  });

  test("the prefix hash cannot see it — I5 measures the intent, not the wire", () => {
    // `measureComposition` folds the STABLE messages, deliberately not the
    // ephemeral tail, so a ledger that changes every turn does not report a
    // cache miss every turn. The consequence, stated as a test: on a folding
    // host the recorded hash says "same prefix" for two requests whose wire
    // prefixes differ. An instrumentation gap, recorded rather than papered
    // over — changing the hash's meaning would break what I5 was built for.
    const of = (messages: Message[], ledger: string) =>
      measureComposition({ system: "doctrine", messages, planLedger: ledger }).prefixHash;
    expect(of(stableN, LEDGER_BEFORE)).toBe(of(stableN, LEDGER_AFTER));
    // …while the wire arrays those two describe are not the same bytes.
    expect(
      JSON.stringify(withTailFolded(stableN, [LEDGER_BEFORE])) ===
        JSON.stringify(withTailFolded(stableN, [LEDGER_AFTER])),
    ).toBe(false);
  });
});
