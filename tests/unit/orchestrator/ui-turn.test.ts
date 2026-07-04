/**
 * Unit tests for the collapsed TurnRenderer (the Codex idiom): narration and
 * the final answer stay in the open; the heavy work accumulates in a hidden
 * log (live tail while streaming, `⋯ N earlier steps · ctrl+r` afterwards),
 * with edit chips, the ⬢ to-do checklist, and a one-line record.
 */

import { describe, it, expect } from "bun:test";
import {
  TurnRenderer,
  userBlock,
  renderReplay,
  editChip,
  todoBlock,
  collapsedWork,
  type TurnSink,
} from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import type { TranscriptLineView } from "../../../packages/orchestrator/src/bin/ui/activity";

function harness(opts: { streamWork?: boolean } = {}) {
  const commits: string[] = [];
  const previews: (string[] | null)[] = [];
  const sink: TurnSink = {
    commit: (b) => commits.push(b),
    preview: (l) => previews.push(l),
  };
  const turn = new TurnRenderer(sink, { getCost: () => 0, ...opts });
  return { commits, previews, sink, turn, plain: () => stripAnsi(commits.join("\n")) };
}

const toolEnd = (name = "bash", result = "{}", args: Record<string, unknown> = { command: "ls" }) => ({
  type: "tool_call_end",
  args,
  output: { toolName: name, result, success: true },
});

describe("TurnRenderer — the work hides, the answer stays out", () => {
  it("a pure Q&A turn renders the response only — no log, no record", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "Just an answer." });
    h.turn.onEvent({ type: "turn_complete", totalTurns: 1 });
    h.turn.finish();
    const out = h.plain();
    expect(out).toContain("Alan▮");
    expect(out).toContain("Just an answer.");
    expect(out).not.toContain("⬢ done");
    expect(out).not.toContain("ctrl+r");
  });

  it("tool work stays OUT of the transcript until finish, then commits collapsed", () => {
    const h = harness();
    for (let i = 0; i < 6; i++) {
      h.turn.onEvent(toolEnd("read_file", "{}", { path: `src/f${i}.ts` }));
    }
    // Mid-turn: nothing committed yet — the work lives in the live window.
    expect(h.commits.length).toBe(0);
    expect(h.previews.at(-1)).not.toBeNull();

    h.turn.onEvent({ type: "text_delta", text: "The answer." });
    h.turn.finish();
    const out = h.plain();
    // Collapsed: the first few work lines, then `N more (ctrl+r to expand)`.
    expect(out).toContain("more (ctrl+r to expand)");
    expect(out).toContain("src/f0.ts");
    expect(out).not.toContain("src/f5.ts");
    // The record + the answer.
    expect(out).toContain("⬢ done");
    expect(out).toContain("6 tools");
    expect(out).toContain("The answer.");
  });

  it("narration prose commits in the open, bright and plain", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "Running linters and typecheck.\n" });
    h.turn.onEvent(toolEnd());
    h.turn.onEvent({ type: "text_delta", text: "All green." });
    h.turn.finish();
    const out = h.plain();
    expect(out).toContain("Running linters and typecheck.");
    // Narration is not inside the work log (no ⋯ needed for one tool line).
    expect(out).toContain("All green.");
  });

  it("edits produce framed chips with +/- counts", () => {
    const h = harness();
    h.turn.onEvent(
      toolEnd(
        "edit_file",
        JSON.stringify({ path: "src/app.ts", diff: "--- a\n+++ b\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n" }),
        { path: "src/app.ts" },
      ),
    );
    h.turn.onEvent({ type: "text_delta", text: "Edited." });
    h.turn.finish();
    const out = h.plain();
    expect(out).toContain("╭");
    expect(out).toContain("src/app.ts");
    expect(out).toMatch(/\+\d+ -\d+/);
  });

  it("written files chip as `new`", () => {
    const h = harness();
    h.turn.onEvent(
      toolEnd("write_file", JSON.stringify({ path: "site/index.html", bytes_written: 6573 }), {
        path: "site/index.html",
      }),
    );
    h.turn.finish();
    const out = h.plain();
    expect(out).toContain("site/index.html");
    expect(out).toContain("new");
  });

  it("to-dos render as the ⬢ checklist and commit their final state once", () => {
    const h = harness();
    h.turn.onEvent({
      type: "todo_updated",
      items: [
        { content: "Made new things", status: "completed" },
        { content: "Read files", status: "in_progress" },
        { content: "Give summary", status: "pending" },
      ],
    });
    // Mid-turn it lives in the live window only.
    expect(h.commits.length).toBe(0);
    expect(stripAnsi((h.previews.at(-1) ?? []).join("\n"))).toContain("Working on 2 to-dos");
    h.turn.finish();
    const out = h.plain();
    expect(out).toContain("☒ Made new things");
    expect(out).toContain("☐ Give summary");
  });

  it("thinking streams into the hidden log, not the transcript", () => {
    const h = harness();
    h.turn.onEvent({ type: "thinking_delta", text: "the user wants a website\n" });
    h.turn.onEvent({ type: "text_delta", text: "Answer." });
    h.turn.finish();
    const out = h.plain();
    // With only 2 log lines it commits (collapsed == full) but stays dim log content.
    expect(h.turn.fullLog()).not.toBeNull();
    expect(stripAnsi(h.turn.fullLog()!)).toContain("the user wants a website");
    expect(out).toContain("Answer.");
  });

  it("a trailing 'Verifying changes…' notice does NOT swallow the final answer", () => {
    const h = harness();
    h.turn.onEvent(toolEnd());
    h.turn.onEvent({ type: "text_delta", text: "Done — everything works." });
    h.turn.onEvent({ type: "notice", message: "Verifying changes…" });
    h.turn.onEvent({ type: "turn_complete", totalTurns: 2 });
    h.turn.finish();
    const out = h.plain();
    expect(out).toContain("Alan▮");
    expect(out).toContain("Done — everything works.");
  });

  it("a 'Verification failed' notice demotes the stale run to open narration", () => {
    const h = harness();
    h.turn.onEvent(toolEnd());
    h.turn.onEvent({ type: "text_delta", text: "All done!" });
    h.turn.onEvent({ type: "notice", message: "Verification failed — asking the agent to fix it." });
    h.turn.onEvent(toolEnd());
    h.turn.onEvent({ type: "text_delta", text: "Actually fixed now." });
    h.turn.finish();
    const out = h.plain();
    const answerIdx = out.indexOf("Alan▮");
    expect(out).toContain("All done!");
    expect(out.slice(answerIdx)).toContain("Actually fixed now.");
    expect(out.slice(answerIdx)).not.toContain("All done!");
  });

  it("reroutes count on the record line", () => {
    const h = harness();
    h.turn.onEvent({
      type: "notice",
      message: "ollama-turbo/qwen3-coder:480b unavailable — rate limited. Switching to openrouter/qwen…",
    });
    h.turn.onEvent(toolEnd());
    h.turn.finish();
    expect(h.plain()).toContain("1 reroute");
  });

  it("errors are never hidden — they commit to the transcript", () => {
    const h = harness();
    h.turn.onEvent({ type: "error", error: "All providers rate limited" });
    h.turn.finish();
    const out = h.plain();
    expect(out).toContain("All providers rate limited");
    expect(out).toContain("⬢ failed");
  });

  it("an interrupted turn records as interrupted", () => {
    const h = harness();
    h.turn.onEvent(toolEnd());
    h.turn.finish({ aborted: true });
    expect(h.plain()).toContain("⬢ interrupted");
  });

  it("turn_complete does not print its own line (folded into the record)", () => {
    const h = harness();
    h.turn.onEvent(toolEnd());
    h.turn.onEvent({ type: "turn_complete", totalTurns: 3 });
    h.turn.finish();
    expect(h.plain()).not.toContain("turns ·");
  });

  it("the live window previews the buffered prose and clears when it commits", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "Streaming out…" });
    expect(stripAnsi((h.previews.at(-1) ?? []).join("\n"))).toContain("Streaming out…");
    h.turn.onEvent(toolEnd()); // run resolved as narration → prose gone from the window
    const win = stripAnsi((h.previews.at(-1) ?? []).join("\n"));
    expect(win).not.toContain("Streaming out…");
  });

  it("streamWork (classic surface) commits work lines as they happen", () => {
    const h = harness({ streamWork: true });
    h.turn.onEvent(toolEnd());
    expect(h.commits.length).toBeGreaterThan(0);
    h.turn.finish();
    expect(h.plain()).not.toContain("ctrl+r"); // nothing was hidden
  });

  it("renders the final answer as markdown typography (no raw markers)", () => {
    const h = harness();
    h.turn.onEvent(toolEnd());
    h.turn.onEvent({ type: "text_delta", text: "### How to use\n\n1. **Navigate** to `dir`\n" });
    h.turn.finish();
    const out = h.plain();
    expect(out).not.toContain("###");
    expect(out).not.toContain("**");
    expect(out).toContain("How to use");
  });
});

describe("fragments", () => {
  it("userBlock sets the message behind the accent bar, bold", () => {
    expect(stripAnsi(userBlock("build me a website"))).toContain("▌ build me a website");
  });

  it("editChip frames path + counts", () => {
    const out = stripAnsi(editChip("src/app.ts", { added: 12, removed: 3 }));
    expect(out).toContain("│ src/app.ts  +12 -3 │");
  });

  it("todoBlock states the open count and the checkboxes", () => {
    const out = stripAnsi(
      todoBlock(
        [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
        ],
        false,
      ),
    );
    expect(out).toContain("Working on 1 to-do");
    expect(out).toContain("☒ a");
    expect(out).toContain("▣ b");
  });

  it("collapsedWork shows the head and counts the rest", () => {
    const log = ["l1", "l2", "l3", "l4", "l5"];
    const out = stripAnsi(collapsedWork(log));
    expect(out).toContain("2 more (ctrl+r to expand)");
    expect(out).toContain("l1");
    expect(out).not.toContain("l5");
  });
});

describe("renderReplay — resumed sessions read like they did live", () => {
  it("keeps narration + answer in the open, collapses the tool work", () => {
    const lines: TranscriptLineView[] = [
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "Looking at the file." },
      { role: "tool", toolName: "read_file", args: { path: "a.ts" }, result: "" },
      { role: "tool", toolName: "read_file", args: { path: "b.ts" }, result: "" },
      { role: "tool", toolName: "read_file", args: { path: "c.ts" }, result: "" },
      { role: "tool", toolName: "read_file", args: { path: "d.ts" }, result: "" },
      { role: "tool", toolName: "read_file", args: { path: "e.ts" }, result: "" },
      { role: "tool", toolName: "read_file", args: { path: "f.ts" }, result: "" },
      { role: "assistant", text: "Fixed it — the handler was missing." },
    ];
    const out = stripAnsi(renderReplay(lines));
    expect(out).toContain("▌ fix the bug");
    expect(out).toContain("Looking at the file.");
    expect(out).toContain("more (replayed)");
    expect(out).toContain("Alan▮");
    expect(out).toContain("Fixed it — the handler was missing.");
  });

  it("a bare Q&A replay is just the exchange", () => {
    const out = stripAnsi(
      renderReplay([
        { role: "user", text: "hi" },
        { role: "assistant", text: "Hello." },
      ]),
    );
    expect(out).not.toContain("⋯");
    expect(out).toContain("Hello.");
  });
});
