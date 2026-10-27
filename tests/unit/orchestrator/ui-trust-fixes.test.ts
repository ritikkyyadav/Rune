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
    // The transcript row is named by the member, says what happened in words
    // and claims nothing: the tilde, not the banner's clipped sentence.
    const out = h.output();
    expect(out).toContain(`${glyph("suspected")} mapper`);
    expect(out).toContain("stopped early");
    expect(out).toContain("no findings");
    expect(out).not.toContain("INCOMPLETE");
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
    // One closing row, on the same left edge as every other row: who stopped
    // it, and that no answer came -- it was three notices.
    const closing = out.split("\n").filter((line) => line.startsWith("  ! "));
    expect(closing).toHaveLength(1);
    expect(closing[0]).toContain("stopped by you");
    expect(closing[0]).toContain("before a result was ready");
  });
});

// ─── Error messages keep the part you need ───

describe("error messages keep their start and their end", () => {
  const { keepEnds, note } = require("../../../packages/orchestrator/src/bin/ui/flow");
  const {
    setActivityWorkspaceRoot,
  } = require("../../../packages/orchestrator/src/bin/ui/activity");

  it("a long message keeps its head and its tail, not just its head", () => {
    const message =
      "ollama rejected the request — ollama API error (401). Check the model or key, or switch providers with /model.";
    const rows = keepEnds(message, 40, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toStartWith("ollama rejected");
    expect(rows[1]).toEndWith("with /model.");
  });

  it("a message that fits is wrapped, not cut", () => {
    expect(keepEnds("short enough", 40, 2)).toEqual(["short enough"]);
  });

  it("a failed read names the file, relative to the workspace", () => {
    const root =
      "/private/tmp/claude-501/scratch/1160f36b-ffbe-40c5-b910-4936de611be5/code/lantern";
    setActivityWorkspaceRoot(root);
    try {
      const row = stripAnsi(
        renderToolActivity({
          toolName: "read_file",
          args: { path: "src/flags.js" },
          result: "",
          success: false,
          error: `IO error at ${root}/src/flags.js: No such file or directory (os error 2)`,
          durationMs: 12,
        }),
      );
      expect(row).toContain("IO error at src/flags.js: No such file or directory");
      expect(row).not.toContain("/private/tmp");
    } finally {
      setActivityWorkspaceRoot(null);
    }
  });

  it("a provider error's headline wraps instead of losing its way out", () => {
    setTermWidthOverride(80);
    const out = stripAnsi(
      note(
        "ollama rejected the request — ollama API error (401). Check the model/key or switch with /model.",
        undefined,
        undefined,
        "fail",
      ).join("\n"),
    );
    expect(out).toContain("/model.");
    expect(out).not.toContain("/mo…");
  });
});

// ─── Diff previews show the change ───

describe("an edit's preview shows what changed", () => {
  const { previewDiff } = require("../../../packages/orchestrator/src/bin/ui/flow");
  // The audit's own edit: three lines of context, then the change.
  const diff = [
    "@@ -2,7 +2,8 @@",
    " // lantern -- a very small task runner.",
    " ",
    " function parseArgs(argv) {",
    "-  const args = { command: null, json: false };",
    "+  const args = { command: null, json: false, version: false };",
    "   for (const arg of argv.slice(2)) {",
    '-    if (arg === "--json") args.json = true;',
    '+    if (arg === "--version" || arg === "-v") args.version = true;',
    '+    else if (arg === "--json") args.json = true;',
    "@@ -12,6 +13,10 @@",
    "   const args = parseArgs(process.argv);",
    "+  if (args.version) {",
    '+    console.log(require("../package.json").version);',
    "+    return;",
    "+  }",
  ].join("\n");

  it("spends the rows on changed lines, with one line of context before a group", () => {
    const { rows } = previewDiff(diff, 5);
    const kinds = rows.map((r: { kind: string }) => r.kind);
    expect(kinds.slice(0, 3)).toEqual(["context", "remove", "add"]);
    expect(rows[0].text).toContain("function parseArgs");
    // The two blank and comment lines above it are not spent.
    expect(rows.some((r: { text: string }) => r.text.includes("very small task runner"))).toBe(
      false,
    );
  });

  it("counts what it could not show as changed lines, for ctrl+o", () => {
    const { rows, added, removed } = previewDiff(diff, 5);
    // Nine changed lines (7 added, 2 removed); three fit beside the context.
    expect(rows.at(-1)).toEqual({ kind: "elide", text: "6 more changed lines" });
    expect(added).toBe(7);
    expect(removed).toBe(2);
  });
});

describe("ctrl+o brings the fold it opened into view", () => {
  it("scrolls to a newest fold that was above the screen", () => {
    const { Tui } = require("../../../packages/orchestrator/src/bin/ui/tui");
    const { FoldLedger } = require("../../../packages/orchestrator/src/bin/ui/folds");
    const t: any = Object.create(Tui.prototype);
    const transcript = Array.from({ length: 200 }, (_, i) => `row ${i}`);
    Object.assign(t, {
      transcript,
      scroll: 0,
      folds: new FoldLedger(),
      blocks: { noteSplice: () => {}, noteTrim: () => {} },
      frameZones: () => ({ bodyRows: 20 }),
      scheduleDraw: () => {},
    });
    t.folds.register(10, ["closed row"], ["opened 1", "opened 2", "opened 3"]);
    const fold = t.folds.newest();
    t.toggleFold(fold, true);
    const first = t.transcript.length - t.scroll - 20;
    expect(first).toBeLessThanOrEqual(10);
    expect(first + 20).toBeGreaterThan(10);
    expect(t.transcript.slice(first, first + 20)).toContain("opened 1");
  });
});

// ─── A fan-out is visible in the flow ───
//
// The audit's T8: while two agents worked, the fixed frame showed two
// unchanging transcript rows both called `scout` (the tool's verb), and the
// rows that named each member and its current action were built but never
// drawn -- the frame draws one live row above the composer.

describe("a fan-out is visible in the flow", () => {
  const rowOf = (out: string, brief: string) =>
    out.split("\n").find((row) => row.includes(brief)) ?? "";

  it("each member's row is named by the member, with what it is doing now", () => {
    const h = live();
    startMember(h, "c1", "mapper");
    startMember(h, "c2", "scout");
    h.feed(
      { type: "tool_progress", callId: "c1", note: 'grep "sessions" in src' },
      { type: "tool_progress", callId: "c2", note: "read src/cli.js" },
    );
    h.turn.tick();
    const out = h.output();
    const mapper = rowOf(out, "mapper work");
    const scout = rowOf(out, "scout work");
    expect(mapper).toContain(`${glyph("selection")} mapper`);
    expect(mapper).toContain('grep "sessions" in src');
    expect(scout).toContain(`${glyph("selection")} scout`);
    expect(scout).toContain("read src/cli.js");
    // Not the tool's verb on someone else's row.
    expect(mapper).not.toMatch(/scout\s+mapper work/);
    // Two rows, one per member: the live row IS the transcript row.
    expect(out.split("\n").filter((row) => row.includes(" work"))).toHaveLength(2);
  });

  it("the member's own id is not repeated on its row", () => {
    const h = live();
    startMember(h, "ollama_tool_17_0", "mapper");
    h.feed({
      type: "tool_progress",
      callId: "ollama_tool_17_0",
      note: "ollama_tool_17_0 read_file src/store.js",
      child: {
        agentId: "ollama_tool_17_0",
        event: {
          type: "tool_call_end",
          callId: "t1",
          args: { path: "src/store.js" },
          output: { callId: "t1", toolName: "read_file", success: true, result: "" },
        },
      },
    });
    h.turn.tick();
    const row = rowOf(h.output(), "mapper work");
    expect(row).toContain("read_file src/store.js");
    expect(row).not.toContain("ollama_tool_17_0");
  });

  it("the names line up when they are close, and never open a gutter", () => {
    const h = live();
    startMember(h, "c1", "mapper");
    startMember(h, "c2", "scout");
    h.turn.tick();
    const out = h.output();
    const col = (brief: string) => rowOf(out, brief).indexOf(brief);
    expect(col("mapper work")).toBe(col("scout work"));

    fleetLedger.reset();
    const w = live();
    startMember(w, "d1", "deploy");
    startMember(w, "d2", "auth-store");
    w.turn.tick();
    for (const row of w.output().split("\n")) expect(row.slice(8)).not.toMatch(/\S {4,}\S/);
  });

  it("a member that comes back lands under its own name, with its takeaway", () => {
    const h = live();
    startMember(h, "c1", "mapper");
    h.turn.tick();
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
          result: "The store is an in-memory Map keyed by session id.\n\nFindings:\n  · a",
          durationMs: 14_000,
        },
      },
    );
    const out = h.output();
    const row = rowOf(out, "mapper work");
    expect(row).toMatch(/^\s+│\s+mapper\s+mapper work/);
    expect(row).toContain("14.0s");
    expect(out).toContain("The store is an in-memory Map keyed by session id.");
    expect(out).not.toContain(`${glyph("selection")} mapper`);
  });

  it("stopping the run sets the members still out down by name, as stopped", () => {
    const h = live();
    startMember(h, "c1", "mapper");
    startMember(h, "c2", "scout");
    h.turn.tick();
    h.turn.finish({ aborted: true });
    const out = h.output();
    for (const [name, brief] of [
      ["mapper", "mapper work"],
      ["scout", "scout work"],
    ] as const) {
      const row = rowOf(out, brief);
      expect(row).toContain(`${glyph("suspected")} ${name}`);
      expect(row).toContain("stopped early");
      expect(row).toContain("no findings");
      expect(row).not.toContain("interrupted");
    }
  });

  it("an INCOMPLETE report says its cause in words", () => {
    const row = (result: string, toolName = "task") =>
      stripAnsi(
        renderToolActivity({
          toolName,
          args: { label: "map the store" },
          result,
          success: true,
          durationMs: 3_000,
          agent: { name: "mapper" },
        }),
      );
    expect(
      row("INCOMPLETE — The sub-agent ran out of turns before writing its summary. No findings"),
    ).toContain("ran out of turns · no findings");
    const errored = row(
      "INCOMPLETE — The sub-agent hit an error and stopped (429 rate limited (try later)). No findings were written",
    );
    expect(errored).toContain("stopped on an error · no findings");
    expect(errored).toContain("429 rate limited (try later)");
    expect(
      row(
        "INCOMPLETE — The sub-agent was aborted before writing its summary. What follows",
        "worker",
      ),
    ).toContain("stopped early · no report");
    for (const text of [errored]) expect(text).not.toContain("INCOMPLETE");
  });
});

describe("a sub-agent's own transcript reads like the lead's", () => {
  const {
    ChildLog,
    ChildTranscript,
  } = require("../../../packages/orchestrator/src/bin/ui/child-transcript");
  const call = (id: string, toolName: string, args: object, result: object | string, ok = true) => [
    { type: "tool_call_start", callId: id, toolName },
    {
      type: "tool_call_end",
      callId: id,
      args,
      output: {
        callId: id,
        toolName,
        success: ok,
        result: typeof result === "string" ? result : JSON.stringify(result),
        durationMs: 12,
      },
    },
  ];

  it("a read is one quiet row; a command keeps its output", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    const lines = Array.from({ length: 30 }, (_, i) => `${i + 1}\tconst line${i} = ${i};`);
    for (const e of [
      ...call(
        "r1",
        "read_file",
        { path: "src/cli.js" },
        { path: "src/cli.js", total_lines: 30, content: lines.join("\n") },
      ),
      ...call(
        "b1",
        "bash",
        { command: "ls src" },
        { stdout: Array.from({ length: 20 }, (_, i) => `file${i}.js`).join("\n"), exit_code: 0 },
      ),
    ]) {
      t.absorb(e);
    }
    const rows = (log.lines as string[]).map((l) => stripAnsi(l));
    const text = rows.join("\n");
    expect(text).toContain("read  src/cli.js");
    expect(text).not.toContain("const line0");
    // The command's output is the evidence, and it is still shown.
    expect(text).toContain("file0.js");
  });
});
