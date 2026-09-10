import { describe, expect, it } from "bun:test";
import {
  TurnRenderer,
  isVerificationCommand,
  renderReplay,
  userBlock,
  type TurnSink,
} from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import type { TranscriptLineView } from "../../../packages/orchestrator/src/bin/ui/activity";

function harness() {
  const commits: string[] = [];
  const details: string[] = [];
  const previews: (string[] | null)[] = [];
  const sink: TurnSink = {
    commit: (block, detail) => {
      commits.push(block);
      if (detail) details.push(detail);
    },
    preview: (lines) => previews.push(lines),
  };
  const turn = new TurnRenderer(sink, { getCost: () => 0.01 });
  return {
    commits,
    details,
    previews,
    turn,
    output: () => stripAnsi(commits.join("\n")),
    detail: () => stripAnsi(details.join("\n")),
    preview: () => stripAnsi((previews.at(-1) ?? []).join("\n")),
    /** What the 125ms TUI tick would paint right now. The sink only receives a
     *  rung when an event changes it, so a frame released by the passage of
     *  time — which is most of them — is visible here and nowhere else. */
    rung: () => stripAnsi(turn.liveLines().join("\n")),
  };
}

/** The live rung's dwell floor, mirrored from ./ui/turn so the pacing tests
 *  wait on the real number rather than a guess. */
const DWELL = 700;
const SETTLE = 120;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toolEnd(name: string, args: Record<string, unknown>, result = "{}", success = true) {
  return {
    type: "tool_call_end",
    callId: `call-${name}`,
    args,
    output: { toolName: name, result, success, error: success ? undefined : "failed" },
  };
}

describe("TurnRenderer — customizer activity stream", () => {
  it("renders a pure answer without inventing a work receipt", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "Just an answer." });
    h.turn.finish();
    expect(h.output()).toContain("Just an answer.");
    expect(h.output()).not.toContain("✓ Complete");
    expect(h.output()).not.toContain("◉ Rune");
  });

  it("collapses a long gathering burst into one row, above the finding it led to", () => {
    const h = harness();
    for (let index = 0; index < 30; index++) {
      h.turn.onEvent(
        toolEnd(
          "read_file",
          { path: `src/file-${index}.ts` },
          JSON.stringify({ path: `src/file-${index}.ts`, total_lines: 10 }),
        ),
      );
    }
    // Nothing with news in it has landed, so nothing has been set down yet.
    expect(h.commits).toHaveLength(0);
    expect(h.preview()).toContain("thinking"); // the rung: label + receipt, no ledger
    expect((h.previews.at(-1) ?? []).length).toBeLessThanOrEqual(2);

    h.turn.onEvent({ type: "text_delta", text: "The implementation is mapped." });
    h.turn.finish();
    // One row for the burst, and it says what the burst covered.
    expect(h.output()).toContain("30 files");
    expect(h.output()).toContain("300 lines");
    expect(h.output()).not.toContain("src/file-7.ts");
    // The reads still land ABOVE the sentence they produced.
    expect(h.output().indexOf("30 files")).toBeLessThan(
      h.output().indexOf("The implementation is mapped."),
    );
    // A clean turn ends with the answer and nothing after it: no receipt strip.
    expect(h.output().trimEnd().endsWith("The implementation is mapped.")).toBe(true);
  });

  it("keeps a short gathering burst per call — two paths are worth naming", () => {
    const h = harness();
    h.turn.onEvent(
      toolEnd("read_file", { path: "src/a.ts" }, JSON.stringify({ path: "src/a.ts" })),
    );
    h.turn.onEvent(
      toolEnd("read_file", { path: "src/b.ts" }, JSON.stringify({ path: "src/b.ts" })),
    );
    h.turn.finish();
    expect(h.output()).toContain("src/a.ts");
    expect(h.output()).toContain("src/b.ts");
  });

  it("keeps the full detail of a collapsed burst in the work log", () => {
    const h = harness();
    for (let index = 0; index < 5; index++) {
      h.turn.onEvent(
        toolEnd(
          "read_file",
          { path: `src/file-${index}.ts` },
          JSON.stringify({ path: `src/file-${index}.ts` }),
        ),
      );
    }
    h.turn.finish();
    // Collapsed on screen, complete underneath — the burst is summarised, not lost.
    expect(h.output()).not.toContain("src/file-3.ts");
    expect(stripAnsi(h.turn.fullLog() ?? "")).toContain("src/file-3.ts");
  });

  it("renders model progress prose in the agent's own voice, before the matching action", async () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "Tracing the authentication path." });
    h.turn.onEvent({ type: "tool_call_start", callId: "r1", toolName: "read_file" });
    h.turn.onEvent({
      type: "tool_call_args_delta",
      callId: "r1",
      partialJson: '{"path":"src/auth/session.ts"}',
    });
    await sleep(DWELL + 60);
    expect(h.rung()).toContain("Reading");
    expect(h.rung()).toContain("src/auth/session.ts");
    h.turn.onEvent(toolEnd("read_file", { path: "src/auth/session.ts" }));
    h.turn.onEvent({ type: "text_delta", text: "The stale branch is the cause." });
    h.turn.finish();
    // No "Plan:" label — a sentence that needs a label is not a sentence.
    expect(h.output()).not.toContain("Plan:");
    expect(h.output()).toContain("◇ Tracing the authentication path.");
    expect(h.output()).toContain("The stale branch is the cause.");
  });

  it("renders every progress paragraph the same way — one dot, one voice", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "Trace the request path." });
    h.turn.onEvent({ type: "tool_call_start", callId: "r1", toolName: "read_file" });
    h.turn.onEvent(toolEnd("read_file", { path: "src/a.ts" }));
    h.turn.onEvent({ type: "text_delta", text: "The stale branch is isolated." });
    h.turn.onEvent({ type: "tool_call_start", callId: "r2", toolName: "grep" });
    h.turn.onEvent(toolEnd("grep", { pattern: "stale", path: "src" }));
    h.turn.finish();
    expect(h.output()).not.toContain("Plan:");
    expect(h.output()).toContain("◇ Trace the request path.");
    expect(h.output()).toContain("◇ The stale branch is isolated.");
  });

  it("collapses a mixed exploration burst into one chamber, calls behind the fold", () => {
    const h = harness();
    h.turn.onEvent(toolEnd("read_file", { path: "src/app.ts" }));
    h.turn.onEvent(toolEnd("list_dir", { path: "src" }));
    h.turn.onEvent(
      toolEnd("bash", { command: "git status --short" }, '{"stdout":"M src/app.ts","exit_code":0}'),
    );
    h.turn.onEvent({ type: "text_delta", text: "The implementation is mapped." });
    h.turn.finish();
    // One chamber row states the whole burst; the per-call record is the fold.
    expect(h.output()).toContain("read 1 file, listed 1 directory, ran 1 command");
    expect(h.output()).not.toContain("│   read  src/app.ts");
    expect(h.detail()).toContain("│   read  src/app.ts");
    expect(h.detail()).toContain("│   list  src/");
    expect(h.detail()).toContain("│   run   git status --short");
  });

  it("keeps a short exploration burst as one row per call", () => {
    const h = harness();
    h.turn.onEvent(toolEnd("read_file", { path: "src/app.ts" }));
    h.turn.onEvent(toolEnd("list_dir", { path: "src" }));
    h.turn.onEvent({ type: "text_delta", text: "Two calls, both worth naming." });
    h.turn.finish();
    expect(h.output()).toContain("│   read  src/app.ts");
    expect(h.output()).toContain("│   list  src/");
  });

  it("advances through Plan, Act, and Verify while retaining the completed rows", async () => {
    const h = harness();
    h.turn.onEvent({
      type: "todo_updated",
      items: [
        { content: "Trace the flow", status: "completed" },
        { content: "Fix the branch", status: "in_progress" },
        { content: "Run checks", status: "pending" },
      ],
    });
    expect(h.output()).toContain("│ plan");
    expect(h.output()).toContain("│ ✓ Trace the flow");
    expect(h.output()).toContain("│ › Fix the branch");
    expect(h.output()).toContain("│ o Run checks");
    await sleep(SETTLE + 60);
    expect(h.rung()).toContain("Fix the branch");
    expect(h.rung()).toContain("1/3 steps");

    h.turn.onEvent({ type: "tool_call_start", callId: "e1", toolName: "edit_file" });
    h.turn.onEvent({
      type: "tool_call_args_delta",
      callId: "e1",
      partialJson: '{"path":"src/auth/session.ts"}',
    });
    // The rung is paced: a frame that has only just gone up outlasts whatever
    // wants to replace it, so a tool that starts moments after the plan did does
    // not shove the plan step off screen before it could be read.
    expect(h.rung()).toContain("Fix the branch");
    await sleep(DWELL + 60);
    expect(h.rung()).toContain("Updating src/auth/session.ts");

    h.turn.onEvent({ type: "verification_started", attempt: 1 });
    await sleep(DWELL + 60);
    expect(h.rung()).toContain("checking");
  });

  it("holds a live frame long enough to be read, however fast the work is", async () => {
    const h = harness();
    h.turn.onEvent({ type: "tool_call_start", callId: "r1", toolName: "read_file" });
    h.turn.onEvent({ type: "tool_call_args_delta", callId: "r1", partialJson: '{"path":"a.ts"}' });
    await sleep(DWELL + 60);
    expect(h.rung()).toContain("Reading a.ts");

    // Four more calls, all inside one dwell window. The rail below records every
    // one of them; the rung lets at most a single frame through and absorbs the
    // rest, because four filenames in 300ms is not something anyone can read.
    for (const path of ["b.ts", "c.ts", "d.ts", "e.ts"]) {
      h.turn.onEvent(toolEnd("read_file", { path }, JSON.stringify({ path })));
      h.turn.onEvent({ type: "tool_call_start", callId: path, toolName: "read_file" });
      h.turn.onEvent({
        type: "tool_call_args_delta",
        callId: path,
        partialJson: JSON.stringify({ path }),
      });
    }
    // Nothing is promoted while the burst is still going: none of those states
    // has lasted long enough to be worth a reader's attention.
    expect(h.rung()).toContain("Reading a.ts");

    // `a.ts` is entitled to its whole dwell first. Once that is spent, the rung
    // names the call that is *actually* in flight — one frame for the burst,
    // and it is the true one, not the stalest one.
    await sleep(DWELL + 60);
    const shown = h.rung();
    expect(shown).toContain("Reading e.ts");
    expect(["b.ts", "c.ts", "d.ts"].filter((p) => shown.includes(p))).toHaveLength(0);
  });

  it("does not fall back to thinking in the gaps between calls in a burst", async () => {
    const h = harness();
    // Eight quick calls with a real hole between each — the shape of an agent
    // reading its way through a directory. Taken literally each hole is a moment
    // with nothing in flight, but nobody watching this is watching an agent
    // think; they are watching it work.
    for (const path of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"]) {
      h.turn.onEvent({ type: "tool_call_start", callId: path, toolName: "read_file" });
      h.turn.onEvent({
        type: "tool_call_args_delta",
        callId: path,
        partialJson: JSON.stringify({ path }),
      });
      await sleep(25);
      h.turn.onEvent(toolEnd("read_file", { path }, JSON.stringify({ path })));
      await sleep(25);
      expect(h.rung()).not.toContain("thinking");
    }
    expect(h.rung()).toContain("working");
  });

  it("names a target only once the arguments have finished saying it", async () => {
    const h = harness();
    h.turn.onEvent({ type: "tool_call_start", callId: "b1", toolName: "bash" });
    // Mid-value: the rung must not type the command out letter by letter.
    for (const fragment of ['{"comm', 'and":"npx v', "itest r"]) {
      h.turn.onEvent({ type: "tool_call_args_delta", callId: "b1", partialJson: fragment });
    }
    await sleep(DWELL + 60);
    expect(h.rung()).toContain("Running the necessary command");
    expect(h.rung()).not.toContain("npx v");

    h.turn.onEvent({ type: "tool_call_args_delta", callId: "b1", partialJson: 'un"}' });
    await sleep(DWELL + 60);
    expect(h.rung()).toContain("Checking with npx vitest run");
  });

  it("renders an edit as a rail row and a line-numbered diff", () => {
    const h = harness();
    h.turn.onEvent(
      toolEnd(
        "edit_file",
        { path: "src/app.ts" },
        JSON.stringify({
          path: "src/app.ts",
          diff: "@@ -1 +1,2 @@\n-old\n+new\n+more",
        }),
      ),
    );
    h.turn.onEvent({ type: "text_delta", text: "Updated the handler." });
    h.turn.finish();
    expect(h.output()).toContain("│   edit  src/app.ts");
    expect(h.output()).toContain("+2 -1 | 1 hunk");
    expect(h.output()).toContain("1 - old");
    expect(h.output()).toContain("1 + new");
    expect(h.output()).toContain("│ changed  1 file");
    // A turn that worked says so by showing what changed, not by announcing it.
    expect(h.output()).not.toContain("Complete.");
    expect(h.output().indexOf("Updated the handler.")).toBeLessThan(
      h.output().indexOf("│ changed"),
    );
  });

  it("renders a truthful structured verification receipt", () => {
    const h = harness();
    h.turn.onEvent(toolEnd("write_file", { path: "src/new.ts" }, '{"path":"src/new.ts"}'));
    h.turn.onEvent({ type: "verification_started", attempt: 1 });
    h.turn.onEvent({
      type: "verification_completed",
      attempt: 1,
      ran: true,
      passed: true,
      report: "$ bun run typecheck  (ok)\n\n$ bun test  (ok)",
    });
    h.turn.onEvent({ type: "text_delta", text: "Implemented and verified." });
    h.turn.finish();
    // The check is a row where it ran; a checked turn ends with the answer.
    expect(h.output()).toContain("✓ check  bun run typecheck · bun test");
    expect(h.output()).not.toContain("no check was run on this change");
    expect(h.output()).not.toContain("│ changed");
    expect(h.output().trimEnd().endsWith("Implemented and verified.")).toBe(true);
  });

  it("states when changed code has no observed verification", () => {
    const h = harness();
    h.turn.onEvent(toolEnd("write_file", { path: "src/new.ts" }, '{"path":"src/new.ts"}'));
    h.turn.onEvent({ type: "text_delta", text: "Created the file." });
    h.turn.finish();
    expect(h.output()).toContain("no check was run on this change");
  });

  it("recognizes a failed-then-passing verification cycle as repaired", async () => {
    const h = harness();
    h.turn.onEvent(toolEnd("edit_file", { path: "a.ts" }, '{"path":"a.ts"}'));
    h.turn.onEvent({
      type: "verification_completed",
      attempt: 1,
      ran: true,
      passed: false,
      report: "$ bun test  (exit 1)\n1 failed",
    });
    await sleep(SETTLE + 60);
    // The rung says only what was measured: no invented "Fixing what the
    // checks found" sentence while the model has said nothing.
    expect(h.rung()).not.toContain("Fixing");
    h.turn.onEvent({
      type: "verification_completed",
      attempt: 2,
      ran: true,
      passed: true,
      report: "$ bun test  (ok)",
    });
    h.turn.onEvent({ type: "text_delta", text: "Fixed." });
    h.turn.finish();
    // The verdict is the latest run, not the worst one along the way: the
    // repaired turn ends clean, with no failure row after the answer.
    expect(h.output()).toContain("✓ check  bun test");
    expect(h.output()).not.toContain("stopped on an error");
    expect(h.output().trimEnd().endsWith("Fixed.")).toBe(true);
  });

  it("never exposes raw thinking, including in the detail log", () => {
    const h = harness();
    h.turn.onEvent({ type: "thinking_delta", text: "private hidden reasoning" });
    h.turn.onEvent(toolEnd("read_file", { path: "src/a.ts" }));
    h.turn.onEvent({ type: "text_delta", text: "Answer." });
    h.turn.finish();
    expect(h.output()).not.toContain("private hidden reasoning");
    expect(stripAnsi(h.turn.fullLog() ?? "")).not.toContain("private hidden reasoning");
  });

  it("states a passing check's verdict inline and holds the print-out in the fold", () => {
    const h = harness();
    const result = JSON.stringify({
      stdout: "suite A passed\nsuite B passed\n42 tests passed",
      stderr: "",
      exit_code: 0,
      timed_out: false,
    });
    h.turn.onEvent(toolEnd("bash", { command: "bun test" }, result));
    h.turn.onEvent({ type: "text_delta", text: "All checks pass." });
    h.turn.finish();
    expect(h.output()).toContain("✓ run   bun test");
    expect(h.output()).toContain("│ 42 passed");
    expect(h.output()).not.toContain("suite A passed");
    expect(h.detail()).toContain("suite A passed");
  });

  it("shows a failing check's evidence excerpt, closed by its own verdict", () => {
    const h = harness();
    const noise = Array.from({ length: 40 }, (_, i) => `collecting item ${i}`).join("\n");
    const result = JSON.stringify({
      stdout: `${noise}\nFAILED tests/storage.py::test_round_trip\nAssertionError: boom\n9 failed, 61 passed in 0.29s`,
      stderr: "",
      exit_code: 1,
      timed_out: false,
    });
    h.turn.onEvent(toolEnd("bash", { command: "pytest -q" }, result));
    h.turn.onEvent({ type: "text_delta", text: "Nine failures to fix." });
    h.turn.finish();
    const out = h.output();
    expect(out).toContain("✗ run   pytest -q");
    expect(out).toContain("FAILED tests/storage.py::test_round_trip");
    expect(out).toContain("9 failed, 61 passed in 0.29s");
    // The excerpt is an excerpt: the forty lines of runner chatter stay folded.
    expect(out).not.toContain("collecting item 2\n");
    expect(h.detail()).toContain("collecting item 2");
  });

  it("collapses a run of same-reason failures into one block and one count", () => {
    const h = harness();
    for (let i = 0; i < 11; i++) {
      h.turn.onEvent({
        type: "tool_call_end",
        callId: `r${i}`,
        args: { path: `src/file${i}.ts` },
        output: {
          toolName: "read_file",
          result: "",
          success: false,
          error: `Rate limit exceeded for "read_file". Retry after ${31075 - i * 900}ms`,
        },
      });
    }
    h.turn.onEvent({ type: "text_delta", text: "Backing off." });
    h.turn.finish();
    const out = h.output();
    expect(out.split("Rate limit exceeded").length - 1).toBe(1);
    expect(out).toContain("same failure repeated 10 more times");
  });

  it("surfaces the same error only once and never labels it done", () => {
    const h = harness();
    h.turn.onEvent({ type: "error", error: "All providers unavailable" });
    h.turn.onError(new Error("All providers unavailable"));
    h.turn.finish();
    const occurrences = h.output().split("All providers unavailable").length - 1;
    expect(occurrences).toBe(1);
    expect(h.output()).toContain("stopped on an error");
    expect(h.output()).not.toContain("✓ Done");
  });

  it("records an interrupted turn without pretending it completed", () => {
    const h = harness();
    h.turn.onEvent(toolEnd("read_file", { path: "a.ts" }));
    h.turn.finish({ aborted: true });
    expect(h.output()).toContain("interrupted");
    expect(h.output()).not.toContain("✓ Done");
  });
});

describe("renderReplay", () => {
  const line = (
    value: Partial<TranscriptLineView> & { role: TranscriptLineView["role"] },
  ): TranscriptLineView => ({ text: "", ...value });

  it("replays the full reference chronology and the outcome summary", () => {
    const output = stripAnsi(
      renderReplay([
        line({ role: "user", text: "fix the bug" }),
        line({ role: "assistant", text: "I am reading the files." }),
        line({ role: "tool", toolName: "read_file", args: { path: "a.ts" } }),
        line({ role: "tool", toolName: "read_file", args: { path: "b.ts" } }),
        line({ role: "tool", toolName: "edit_file", args: { path: "a.ts" } }),
        line({
          role: "tool",
          toolName: "bash",
          args: { command: "bun test" },
          result: '{"exit_code":0}',
        }),
        line({ role: "assistant", text: "Fixed and verified." }),
      ]),
    );
    expect(output).toContain("fix the bug"); // the user's words, on a speaker band
    expect(output).not.toContain("› fix the bug"); // no longer a chevron marker
    expect(output).toContain("◇ I am reading the files.");
    // Two reads are below the chamber threshold: both worth naming.
    expect(output).toContain("│   read  a.ts");
    expect(output).toContain("│   read  b.ts");
    expect(output).toContain("1 file changed · 1 check passed");
    expect(output).toContain("Fixed and verified.");
  });

  it("keeps a bare question and answer free of process chrome", () => {
    const output = stripAnsi(
      renderReplay([
        line({ role: "user", text: "hello" }),
        line({ role: "assistant", text: "Hi." }),
      ]),
    );
    expect(output).toContain("Hi.");
    expect(output).not.toContain("✓ Done");
  });
});

describe("helpers", () => {
  it("keeps the user's message visually findable", () => {
    // Findable now by the speaker band (a monochrome inverse), not a chevron.
    // Colour is stripped here, so the text itself is what the assertion sees.
    const block = stripAnsi(userBlock("build the app"));
    expect(block).toContain("build the app");
    expect(block).not.toContain("›");
  });

  it("classifies common verification commands without treating every shell call as a check", () => {
    for (const command of [
      "bun test",
      "npm run typecheck",
      "cargo check --quiet",
      "go test ./...",
    ]) {
      expect(isVerificationCommand(command)).toBe(true);
    }
    expect(isVerificationCommand("mkdir -p dist")).toBe(false);
    expect(isVerificationCommand("git status --short")).toBe(false);
  });
});

describe("TurnRenderer — the plan is set down once, not on every tick", () => {
  const plan = (states: string[]) => ({
    type: "todo_updated",
    items: [
      { content: "Map the repository", status: states[0] },
      { content: "Audit the backend", status: states[1] },
      { content: "Run the checks", status: states[2] },
    ],
  });

  it("commits the shape once and the final state once, never the ticks between", () => {
    const h = harness();
    h.turn.onEvent(plan(["in_progress", "pending", "pending"]));
    h.turn.onEvent(plan(["completed", "in_progress", "pending"]));
    h.turn.onEvent(plan(["completed", "completed", "in_progress"]));
    // Three updates, one commit so far: the shape, when it was first known.
    expect(h.commits).toHaveLength(1);

    h.turn.onEvent(plan(["completed", "completed", "completed"]));
    h.turn.finish();
    const rendered = h.output().split("Map the repository").length - 1;
    expect(rendered).toBe(2); // the opening shape, and the close
  });

  it("does not reprint an unchanged plan at the close", () => {
    const h = harness();
    h.turn.onEvent(plan(["in_progress", "pending", "pending"]));
    h.turn.finish();
    expect(h.output().split("Map the repository").length - 1).toBe(1);
  });

  it("carries the live step and the ratio on the rung while the ticks are hidden", () => {
    const h = harness();
    h.turn.onEvent(plan(["completed", "in_progress", "pending"]));
    expect(h.rung()).toContain("Audit the backend");
    expect(h.rung()).toContain("1/3 steps");
  });
});

// A run the safety broker halted is not a finished run. Rendering it like one
// is the same dishonesty the turn-ceiling row was added to fix: silence reads
// as success, and here it would also invite the user to walk straight back
// into whatever tripped the halt.
describe("a halted run closes honestly", () => {
  it("says the safety broker stopped it, and does not offer a plain retry", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "I was verifying the release when I was stopped." });
    h.turn.onEvent({ type: "turn_complete", stopReason: "halted", totalTurns: 2 } as any);
    h.turn.finish();

    const out = h.output();
    expect(out).toContain("safety halted the run");
    expect(out).toContain("the task is not finished");
    expect(out).toContain("check what it read");
    expect(out).not.toContain("send a follow-up to continue");
  });

  it("still calls a turn ceiling a turn ceiling", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "Working." });
    h.turn.onEvent({ type: "turn_complete", stopReason: "max_turns", totalTurns: 80 } as any);
    h.turn.finish();

    const out = h.output();
    expect(out).toContain("ran out of turns");
    expect(out).toContain("send a follow-up to continue");
  });
});

// ─── The live sink: rows when a call starts, folded retroactively, prose in
// place. This is the contract the fixed viewport offers (tui.ts amend) and
// the one the transcript diagnosis of 2026-09-05 asked for: 45% of a
// session's active time had no new row because a call only became a row
// when it ended and gathering was held until news landed. ───

/** A sink that owns its buffer: commits are blocks with identity, and an
 *  amend replaces one in place. `output()` is the buffer as a reader sees it. */
function liveHarness() {
  const blocks = new Map<number, { block: string; detail?: string }>();
  const order: number[] = [];
  const previews: (string[] | null)[] = [];
  let seq = 0;
  const sink: TurnSink = {
    commit: (block, detail) => {
      const handle = ++seq;
      blocks.set(handle, { block, detail });
      order.push(handle);
      return handle;
    },
    amend: (handle, block, detail) => {
      if (!blocks.has(handle)) throw new Error(`amend of unknown block ${handle}`);
      if (block === "") blocks.delete(handle);
      else blocks.set(handle, { block, detail });
    },
    preview: (lines) => previews.push(lines),
  };
  const turn = new TurnRenderer(sink, { getCost: () => 0.01 });
  const live = () => order.filter((h) => blocks.has(h)).map((h) => blocks.get(h)!);
  return {
    turn,
    previews,
    output: () =>
      stripAnsi(
        live()
          .map((b) => b.block)
          .join("\n"),
      ),
    detail: () =>
      stripAnsi(
        live()
          .map((b) => b.detail ?? "")
          .join("\n"),
      ),
    blocks: () => live().length,
  };
}

function toolStart(name: string, callId: string, args: Record<string, unknown>) {
  return [
    { type: "tool_call_start", callId, toolName: name },
    { type: "tool_call_args_delta", callId, partialJson: JSON.stringify(args) },
  ];
}

describe("TurnRenderer — a sink that can amend", () => {
  it("a started call is visible before its result, and finishes in place", () => {
    const h = liveHarness();
    for (const e of toolStart("bash", "b1", { command: "npx vitest run" })) h.turn.onEvent(e);
    // Before any result: the row is on screen, marked in flight.
    expect(h.output()).toContain("│ › run   npx vitest run");
    expect(h.blocks()).toBe(1);
    h.turn.onEvent({
      type: "tool_call_end",
      callId: "b1",
      args: { command: "npx vitest run" },
      output: {
        toolName: "bash",
        success: true,
        result: JSON.stringify({ stdout: "12 passed", stderr: "", exit_code: 0 }),
      },
    });
    // The same block, finished: no second row, no in-flight mark.
    expect(h.blocks()).toBe(1);
    expect(h.output()).toContain("│ ✓ run   npx vitest run");
    expect(h.output()).toContain("│ │ 12 passed");
    expect(h.output()).not.toContain("›");
  });

  it("gathering lands as it finishes, and folds into one chamber at the third row", () => {
    const h = liveHarness();
    const read = (i: number) => {
      const callId = `r${i}`;
      const path = `src/file-${i}.ts`;
      for (const e of toolStart("read_file", callId, { path })) h.turn.onEvent(e);
      h.turn.onEvent({
        type: "tool_call_end",
        callId,
        args: { path },
        output: {
          toolName: "read_file",
          success: true,
          result: JSON.stringify({ path, total_lines: 10 }),
        },
      });
    };
    read(0);
    read(1);
    // Two paths are worth naming, and they are on screen already.
    expect(h.output()).toContain("│   read  src/file-0.ts  10 lines");
    expect(h.output()).toContain("│   read  src/file-1.ts  10 lines");
    expect(h.blocks()).toBe(2);
    read(2);
    // The third makes the run one fact: one chamber row, the calls in its fold.
    expect(h.blocks()).toBe(1);
    expect(h.output()).toContain("read 3 files");
    expect(h.output()).not.toContain("src/file-1.ts");
    expect(h.detail()).toContain("src/file-1.ts");
    for (let i = 3; i < 30; i++) read(i);
    expect(h.blocks()).toBe(1);
    expect(h.output()).toContain("read 30 files");
    expect(h.output()).toContain("300 lines");
    // News ends the run: the next read starts a new one, under the finding.
    h.turn.onEvent({ type: "text_delta", text: "The implementation is mapped." });
    read(30);
    expect(h.output().indexOf("read 30 files")).toBeLessThan(
      h.output().indexOf("The implementation is mapped."),
    );
    expect(h.output()).toContain("│   read  src/file-30.ts");
    h.turn.finish();
  });

  it("prose streams into the transcript and stays where it streamed", () => {
    const h = liveHarness();
    const before = h.previews.length;
    h.turn.onEvent({ type: "text_delta", text: "Tracing the authentication " });
    expect(h.output()).toContain("◇ Tracing the authentication");
    const blocksAfterFirst = h.blocks();
    h.turn.tick();
    h.turn.onEvent({ type: "text_delta", text: "path first." });
    h.turn.tick();
    // The same block, grown -- not a second paragraph.
    expect(h.blocks()).toBe(blocksAfterFirst);
    expect(h.output()).toContain("◇ Tracing the authentication path first.");
    // A tool call starting beneath it does not move it or repeat it.
    for (const e of toolStart("read_file", "r1", { path: "src/auth.ts" })) h.turn.onEvent(e);
    expect(h.output().split("Tracing the authentication").length - 1).toBe(1);
    expect(h.output().indexOf("Tracing")).toBeLessThan(h.output().indexOf("│ › read  src/auth.ts"));
    // And the live block never repainted for a text delta: the words are in
    // the transcript, and the rung has one row.
    const proseRepaints = h.previews
      .slice(before)
      .filter((p) => p && p.some((l) => stripAnsi(l).includes("Tracing")));
    expect(proseRepaints).toHaveLength(0);
    expect(h.turn.liveLines()).toHaveLength(1);
    h.turn.finish();
  });

  it("the final answer takes its finished form in the block it streamed into", () => {
    const h = liveHarness();
    h.turn.onEvent({ type: "text_delta", text: "Fixed the handler.\n\n- one\n- two" });
    h.turn.finish();
    expect(h.blocks()).toBe(1);
    expect(h.output()).toContain("◇ Fixed the handler.");
    expect(h.output()).toContain("one");
  });

  it("a run of same-reason failures folds under the first, in place", () => {
    const h = liveHarness();
    for (let i = 0; i < 11; i++) {
      const callId = `f${i}`;
      const path = `src/file${i}.ts`;
      for (const e of toolStart("read_file", callId, { path })) h.turn.onEvent(e);
      h.turn.onEvent({
        type: "tool_call_end",
        callId,
        args: { path },
        output: {
          toolName: "read_file",
          result: "",
          success: false,
          error: `Rate limit exceeded for "read_file". Retry after ${31075 - i * 900}ms`,
        },
      });
    }
    expect(h.blocks()).toBe(1);
    const out = h.output();
    expect(out.split("Rate limit exceeded").length - 1).toBe(1);
    expect(out).toContain("same failure repeated 10 more times");
    h.turn.finish();
  });

  it("a harness tool's refusal is a quiet note and never counts as a failure", () => {
    const h = liveHarness();
    for (const e of toolStart("todo_write", "t1", { items: [] })) h.turn.onEvent(e);
    h.turn.onEvent({
      type: "tool_call_end",
      callId: "t1",
      args: { items: [{ content: "x", status: "completed" }] },
      output: {
        toolName: "todo_write",
        result: "",
        success: false,
        error: 'Plan not updated: step 1 "x" is not closed: nothing ran while it was open.',
      },
    });
    h.turn.onEvent({ type: "text_delta", text: "Done." });
    h.turn.finish();
    expect(h.output()).toContain("│   plan  updated");
    expect(h.output()).not.toContain("✗");
    expect(h.output()).not.toContain("stopped on an error");
  });

  it("the live block is one row, and one row per sub-agent when there is a fleet", () => {
    const h = liveHarness();
    h.turn.onEvent({ type: "text_delta", text: "Reading the config." });
    expect(h.turn.liveLines()).toHaveLength(1);
    for (const e of toolStart("bash", "b1", { command: "ls" })) h.turn.onEvent(e);
    expect(h.turn.liveLines()).toHaveLength(1);
    h.turn.onEvent({ type: "tool_call_start", callId: "s1", toolName: "task" });
    h.turn.onEvent({ type: "tool_call_start", callId: "s2", toolName: "task" });
    expect(h.turn.liveLines()).toHaveLength(3);
    h.turn.finish();
  });
});

describe("TurnRenderer — the plan is set down once", () => {
  it("a checklist carried over from the previous turn is not reprinted", () => {
    const items = [
      { content: "Trace the flow", status: "completed" },
      { content: "Fix the branch", status: "in_progress" },
    ];
    const first = harness();
    first.turn.onEvent({ type: "todo_updated", items });
    first.turn.finish();
    expect(first.output()).toContain("│ plan");
    const key = first.turn.planKey()!;
    expect(key).toBeTruthy();

    const commits: string[] = [];
    const next = new TurnRenderer({ commit: (b) => void commits.push(b) }, { priorPlanKey: key });
    next.onEvent({ type: "todo_updated", items });
    next.onEvent({ type: "text_delta", text: "Still on it." });
    next.finish();
    const out = stripAnsi(commits.join("\n"));
    expect(out).not.toContain("│ plan");
    expect(out).toContain("Still on it.");

    // But a plan that MOVED is news, once, at the close.
    const later: string[] = [];
    const moved = new TurnRenderer({ commit: (b) => void later.push(b) }, { priorPlanKey: key });
    moved.onEvent({ type: "todo_updated", items });
    moved.onEvent({
      type: "todo_updated",
      items: [
        { content: "Trace the flow", status: "completed" },
        { content: "Fix the branch", status: "completed" },
      ],
    });
    moved.finish();
    const printed = stripAnsi(later.join("\n"));
    expect(printed.split("│ plan").length - 1).toBe(1);
    expect(printed).toContain("│ ✓ Fix the branch");
  });

  it("a clean turn is the model's words, its actions and its answer -- nothing harness-authored", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "Checking the retry loop first." });
    h.turn.onEvent(
      toolEnd("read_file", { path: "src/retry.ts" }, '{"path":"src/retry.ts","total_lines":40}'),
    );
    h.turn.onEvent(
      toolEnd(
        "edit_file",
        { path: "src/retry.ts" },
        JSON.stringify({ path: "src/retry.ts", diff: "@@ -1 +1 @@\n-old\n+new" }),
      ),
    );
    h.turn.onEvent(
      toolEnd(
        "bash",
        { command: "bun test" },
        JSON.stringify({ stdout: "12 passed", stderr: "", exit_code: 0 }),
      ),
    );
    h.turn.onEvent({ type: "text_delta", text: "The 429 now surfaces." });
    h.turn.finish();
    const rows = h
      .output()
      .split("\n")
      .filter((l) => l.trim());
    // Every row is one of: the dot (the model), the rail (an action), the diff.
    for (const row of rows) {
      expect(row, row).toMatch(/^\s*(◇|│)/);
    }
    expect(h.output()).not.toContain("changed");
    expect(h.output()).not.toContain("reviewed");
    expect(h.output()).not.toContain("/rewind");
  });
});
