// The trust fixes of 2026-10-26 (docs/program/ui-decision-20261026-trust-fixes.md),
// each pinned on the real renderer, panel and composer code. The audit that
// found them: 285 captured frames of v1.4.15 in a real pseudo-terminal.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  TurnRenderer,
  responseBlock,
  type TurnSink,
} from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../../packages/orchestrator/src/bin/ui/render";
import {
  agentBlocks,
  fleetLedger,
  type AgentCard,
} from "../../../packages/orchestrator/src/bin/ui/agents-panel";
import { renderToolActivity } from "../../../packages/orchestrator/src/bin/ui/activity";
import { REST_DONE, restRow } from "../../../packages/orchestrator/src/bin/ui/working";
import { INPUT_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-input";
import { glyph } from "../../../packages/orchestrator/src/bin/ui/glyphs";

beforeEach(() => {
  fleetLedger.reset();
  setTermWidthOverride(100);
});
afterEach(() => {
  fleetLedger.reset();
  setTermWidthOverride(null);
});

/** A sink that owns its buffer, as the fixed viewport does. */
function live() {
  const blocks = new Map<number, string>();
  const order: number[] = [];
  let seq = 0;
  const sink: TurnSink = {
    commit: (block) => {
      const handle = ++seq;
      blocks.set(handle, block);
      order.push(handle);
      return handle;
    },
    amend: (handle, block) => {
      if (block === "") blocks.delete(handle);
      else blocks.set(handle, block);
    },
    preview: () => {},
  };
  const turn = new TurnRenderer(sink, { getCost: () => 0 });
  return {
    turn,
    feed: (...events: object[]) => {
      for (const e of events) turn.onEvent(e as never);
    },
    output: () =>
      stripAnsi(
        order
          .filter((h) => blocks.has(h))
          .map((h) => blocks.get(h)!)
          .join("\n"),
      ),
  };
}

const failedCheck = (preexisting = false) => [
  { type: "verification_started", attempt: 1 },
  {
    type: "verification_completed",
    attempt: 1,
    status: "failed",
    ...(preexisting ? { preexisting: true } : {}),
    ran: true,
    passed: false,
    report: "$ npm test (exit 1)\nError: Cannot find module 'test/'",
  },
];

// ─── Fix 4: the rest row says how the turn ended ───

describe("the rest row says how the turn ended, not only that it did", () => {
  function ending(events: object[], aborted = false) {
    const h = live();
    h.feed(...events);
    h.turn.finish({ aborted });
    return h.turn.restOutcome(aborted);
  }

  it("a clean turn is done", () => {
    expect(ending([{ type: "text_delta", text: "All good." }])).toEqual(REST_DONE);
  });

  it("a failing end-of-turn check is `checks failing`, in red", () => {
    expect(ending(failedCheck())).toEqual({ word: "checks failing", tone: "danger" });
  });

  it("a red check that was red before the run began says so, in amber", () => {
    const outcome = ending(failedCheck(true));
    expect(outcome.tone).toBe("warn");
    expect(outcome.word).toContain("already failing");
  });

  it("a provider error that ended the turn is an error; a rate limit is named", () => {
    expect(
      ending([{ type: "error", error: "ollama API error (500)", recoverable: false }]),
    ).toEqual({ word: "stopped on an error", tone: "danger" });
    expect(
      ending([
        { type: "error", error: "Rate limited on ollama. Wait a moment.", recoverable: false },
      ]),
    ).toEqual({ word: "rate-limited", tone: "warn" });
    // A retried, recovered error is not this turn's ending.
    expect(
      ending([
        { type: "error", error: "ollama API error (500)", recoverable: true },
        { type: "text_delta", text: "Recovered." },
      ]),
    ).toEqual(REST_DONE);
  });

  it("a run the person stopped says so", () => {
    expect(ending([{ type: "text_delta", text: "Reading" }], true)).toEqual({
      word: "stopped by you",
      tone: "warn",
    });
  });

  it("a passed check cannot erase a terminal provider error", () => {
    const passed = {
      type: "verification_completed",
      attempt: 1,
      status: "passed",
      ran: true,
      passed: true,
      report: "$ bun test (ok)",
    };
    const error = { type: "error", error: "provider API error (500)", recoverable: false };
    for (const events of [
      [passed, error],
      [error, passed],
    ]) {
      const h = live();
      h.feed(...events);
      h.turn.finish();
      expect(h.turn.restOutcome(false)).toEqual({ word: "stopped on an error", tone: "danger" });
      expect(h.output()).toContain("stopped on an error");
    }
  });

  it("an earlier recovered rate limit does not label a different terminal error", () => {
    const h = live();
    h.feed({ type: "error", error: "Rate limited; retrying", recoverable: true });
    h.turn.onError(new Error("provider API error (500)"));
    h.turn.finish();
    expect(h.turn.restOutcome(false)).toEqual({ word: "stopped on an error", tone: "danger" });
  });

  it("the last terminal error names the ending, whichever came first", () => {
    const limited = { type: "error", error: "Rate limited on the provider", recoverable: false };
    const crashed = new Error("provider API error (500)");
    const first = live();
    first.feed(limited);
    first.turn.onError(crashed);
    first.turn.finish();
    expect(first.turn.restOutcome(false)).toEqual({ word: "stopped on an error", tone: "danger" });

    const second = live();
    second.turn.onError(crashed);
    second.feed(limited);
    second.turn.finish();
    expect(second.turn.restOutcome(false)).toEqual({ word: "rate-limited", tone: "warn" });
  });

  it("a ceiling is named", () => {
    expect(ending([{ type: "turn_complete", stopReason: "max_turns", totalTurns: 80 }]).word).toBe(
      "ran out of turns",
    );
    expect(
      ending([{ type: "turn_complete", stopReason: "quota_wall", totalTurns: 3 }]).word,
    ).toContain("usage limit");
  });

  it("restRow sets the ending down beside the clock", () => {
    const row = stripAnsi(restRow("|", { word: "checks failing", tone: "danger" }, 23_000));
    expect(row).toMatch(/^\| checks failing \S 23s$/);
    expect(stripAnsi(restRow("|", REST_DONE))).toBe("| done");
  });
});

// ─── Fix 5: every reply is its own block, and the headline is rendered ───

describe("answers are not glued together, and their headline is rendered", () => {
  it("a reply after a re-plan does not continue the sentence before it", () => {
    const h = live();
    h.feed(
      { type: "text_delta", text: "The flag is added; say if you want the README updated too." },
      { type: "usage", inputTokens: 10, outputTokens: 12 },
      { type: "replanning", reason: "checks still failing", trigger: "verification" },
      { type: "text_delta", text: "--version and -v now print the version." },
      { type: "usage", inputTokens: 10, outputTokens: 8 },
    );
    h.turn.finish();
    const out = h.output();
    expect(out).not.toContain("too.--version");
    expect(out).toContain("say if you want the README updated too.");
    expect(out).toContain("--version and -v now print the version.");
  });

  it("two messages with nothing but a model call between them stay two", () => {
    const h = live();
    h.feed(
      { type: "text_delta", text: "First message." },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "text_delta", text: "Second message." },
    );
    h.turn.finish();
    expect(h.output()).not.toContain("message.Second");
  });

  it("one message streamed in pieces is still one message", () => {
    const h = live();
    h.feed(
      { type: "text_delta", text: "One " },
      { type: "text_delta", text: "sentence." },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
    );
    h.turn.finish();
    expect(h.output()).toContain("One sentence.");
  });

  it("the headline's markdown is rendered, not printed", () => {
    const out = stripAnsi(responseBlock("`--version` and `-v` now print the **version**."));
    expect(out).not.toContain("`");
    expect(out).not.toContain("**");
    expect(out).toContain("--version and -v now print the version.");
    expect(out).toContain(glyph("live"));
  });

  it("an answer that opens with a heading keeps the speaker's mark", () => {
    expect(stripAnsi(responseBlock("## What changed\n\nThe flag."))).toContain(glyph("live"));
  });
});

// ─── Fix 6: ctrl+l repaints ───

describe("ctrl+l draws the screen again and erases nothing", () => {
  it("repaints the fixed frame without touching the transcript", () => {
    let invalidated = 0;
    let drawn = 0;
    let reset = 0;
    const t: any = {
      inline: false,
      viewport: { invalidate: () => invalidated++ },
      scheduleDraw: () => drawn++,
      resetTranscript: () => reset++,
      transcript: ["row one", "row two"],
    };
    INPUT_METHODS.ctrlKey.call(t, "l");
    expect(reset).toBe(0);
    expect(invalidated).toBe(1);
    expect(drawn).toBe(1);
    expect(t.transcript).toEqual(["row one", "row two"]);
  });
});

// ─── Fix 7: marks say what happened ───

function card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    id: "c1",
    name: "scout",
    brief: "find the callers",
    kind: "task",
    state: "running",
    note: "",
    tokens: 0,
    costUsd: 0,
    tools: 0,
    checks: 0,
    checksPassed: 0,
    reroutes: 0,
    pulseStep: 0,
    quietMs: 0,
    retired: true,
    startedAt: 1_000,
    ...over,
  };
}

function startMember(h: ReturnType<typeof live>, id: string, name: string) {
  h.feed(
    { type: "tool_call_start", callId: id, toolName: "task" },
    {
      type: "tool_call_args_delta",
      callId: id,
      partialJson: JSON.stringify({ name, label: `${name} work`, prompt: `Brief for ${name}.` }),
    },
    { type: "tool_progress", callId: id, note: "", state: "started" },
  );
}

describe("marks say what happened", () => {
  it("a sub-agent that came back INCOMPLETE is stopped, never ticked", () => {
    const h = live();
    startMember(h, "c1", "mapper");
    h.feed(
      { type: "tool_progress", callId: "c1", note: "", state: "settled", ok: true },
      {
        type: "tool_call_end",
        callId: "c1",
        args: { name: "mapper", label: "mapper work", prompt: "Brief for mapper." },
        output: {
          callId: "c1",
          toolName: "task",
          success: true,
          result:
            "INCOMPLETE — The sub-agent was aborted before writing its summary. No findings were written.",
          durationMs: 14_000,
        },
      },
    );
    expect(fleetLedger.order().map((c) => c.state)).toEqual(["stopped"]);
    // The block on the working row and the card wore the ticks; now the tilde.
    expect(stripAnsi(agentBlocks(fleetLedger.order(), 80))).toContain(
      `[mapper ${glyph("suspected")}]`,
    );
    // The transcript row says why, and claims nothing.
    const out = h.output();
    expect(out).toContain("INCOMPLETE");
    expect(out).not.toContain(glyph("verified"));
  });

  it("members still out when the person stops the run are stopped, not done", () => {
    const h = live();
    startMember(h, "c1", "mapper");
    startMember(h, "c2", "scout");
    h.turn.finish({ aborted: true });
    expect(fleetLedger.order().map((c) => c.state)).toEqual(["stopped", "stopped"]);
  });

  it("a stopped agent's block wears the tilde, not a tick", () => {
    const blocks = stripAnsi(agentBlocks([card({ state: "stopped" })], 80));
    expect(blocks).toContain(`[scout ${glyph("suspected")}]`);
    expect(blocks).not.toContain(glyph("verified"));
  });

  it("a command the person declined is a choice, not a red failure", () => {
    const row = stripAnsi(
      renderToolActivity({
        toolName: "bash",
        args: { command: "rm -rf dist" },
        result: "",
        success: false,
        error: "User denied",
        durationMs: 0,
      }),
    );
    expect(row).toContain("skipped, you said no");
    expect(row).not.toContain("User denied");
    expect(row).not.toContain(glyph("failure"));
  });

  it("an interrupt before any edit does not claim partial work was kept", () => {
    const h = live();
    h.feed({ type: "tool_call_start", callId: "r1", toolName: "read_file" });
    h.turn.finish({ aborted: true });
    const out = h.output();
    expect(out).not.toContain("partial work kept");
    // ...and its last notice sits on the same left edge as every other row.
    expect(out.split("\n")).toContain("  ! stopped before a result was ready");
  });
});
