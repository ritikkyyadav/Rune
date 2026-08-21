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
  const previews: (string[] | null)[] = [];
  const sink: TurnSink = {
    commit: (block) => commits.push(block),
    preview: (lines) => previews.push(lines),
  };
  const turn = new TurnRenderer(sink, { getCost: () => 0.01 });
  return {
    commits,
    previews,
    turn,
    output: () => stripAnsi(commits.join("\n")),
    preview: () => stripAnsi((previews.at(-1) ?? []).join("\n")),
  };
}

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
    expect(h.output()).not.toContain("◉ Gear");
  });

  it("paces a long routine burst into one visible summary while preserving full details", () => {
    const h = harness();
    for (let index = 0; index < 30; index++) {
      h.turn.onEvent(toolEnd("read_file", { path: `src/file-${index}.ts` }));
    }
    expect(h.commits).toHaveLength(0);
    expect(h.preview()).toContain("Thinking"); // the v2 rung: label + receipt, no ledger
    expect((h.previews.at(-1) ?? []).length).toBeLessThanOrEqual(2);

    h.turn.onEvent({ type: "text_delta", text: "The implementation is mapped." });
    h.turn.finish();
    expect(h.output()).toContain("Read 30 files");
    expect(h.output()).toContain("30 files reviewed");
    expect(h.output()).not.toContain("src/file-0.ts");
    expect(stripAnsi(h.turn.fullLog() ?? "")).toContain("src/file-0.ts");
  });

  it("renders model progress prose as a Plan row before the matching action", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "Tracing the authentication path." });
    h.turn.onEvent({ type: "tool_call_start", callId: "r1", toolName: "read_file" });
    h.turn.onEvent({
      type: "tool_call_args_delta",
      callId: "r1",
      partialJson: '{"path":"src/auth/session.ts"}',
    });
    expect(h.preview()).toContain("Reading");
    expect(h.preview()).toContain("src/auth/session.ts");
    h.turn.onEvent(toolEnd("read_file", { path: "src/auth/session.ts" }));
    h.turn.onEvent({ type: "text_delta", text: "The stale branch is the cause." });
    h.turn.finish();
    expect(h.output()).toContain("Plan:");
    expect(h.output()).toContain("Tracing the authentication path");
    expect(h.output()).toContain("The stale branch is the cause.");
  });

  it("uses Plan once, then renders later progress as ordinary activity", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "Trace the request path." });
    h.turn.onEvent({ type: "tool_call_start", callId: "r1", toolName: "read_file" });
    h.turn.onEvent(toolEnd("read_file", { path: "src/a.ts" }));
    h.turn.onEvent({ type: "text_delta", text: "The stale branch is isolated." });
    h.turn.onEvent({ type: "tool_call_start", callId: "r2", toolName: "grep" });
    h.turn.onEvent(toolEnd("grep", { pattern: "stale", path: "src" }));
    h.turn.finish();
    expect(h.output().match(/Plan:/g) ?? []).toHaveLength(1);
    expect(h.output()).toContain("● The stale branch is isolated.");
  });

  it("matches the reference ledger for a mixed exploration burst", () => {
    const h = harness();
    h.turn.onEvent(toolEnd("read_file", { path: "src/app.ts" }));
    h.turn.onEvent(toolEnd("list_dir", { path: "src" }));
    h.turn.onEvent(
      toolEnd("bash", { command: "git status --short" }, '{"stdout":"M src/app.ts","exit_code":0}'),
    );
    h.turn.onEvent({ type: "text_delta", text: "The implementation is mapped." });
    h.turn.finish();
    expect(h.output()).toContain("Read 1 file, listed 1 directory, and ran 1 shell command");
    expect(h.output()).toContain("● Running command");
    expect(h.output()).toContain("$ git status --short");
  });

  it("advances through Plan, Act, and Verify while retaining the completed rows", () => {
    const h = harness();
    h.turn.onEvent({
      type: "todo_updated",
      items: [
        { content: "Trace the flow", status: "completed" },
        { content: "Fix the branch", status: "in_progress" },
        { content: "Run checks", status: "pending" },
      ],
    });
    expect(h.output()).toContain("Plan:");
    expect(h.preview()).toContain("Fix the branch");
    expect(h.preview()).toContain("1/3 steps");

    h.turn.onEvent({ type: "tool_call_start", callId: "e1", toolName: "edit_file" });
    h.turn.onEvent({
      type: "tool_call_args_delta",
      callId: "e1",
      partialJson: '{"path":"src/auth/session.ts"}',
    });
    expect(h.preview()).toContain("Updating src/auth/session.ts");

    h.turn.onEvent({ type: "verification_started", attempt: 1 });
    expect(h.preview()).toContain("Verifying");
  });

  it("renders the reference's file header and line-level diff card", () => {
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
    expect(h.output()).toContain("1 file changed");
    expect(h.output()).toContain("src/app.ts");
    expect(h.output()).toMatch(/\+\d+ −\d+/);
    expect(h.output()).toContain("lines 1–2");
    expect(h.output()).toContain("- old");
    expect(h.output()).toContain("+ new");
    expect(h.output().indexOf("Complete.")).toBeLessThan(
      h.output().indexOf("Updated the handler."),
    );
    expect(h.output().indexOf("Updated the handler.")).toBeLessThan(
      h.output().indexOf("1 file changed"),
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
    expect(h.output()).toContain("✓ typecheck clean"); // v2 summary-strip badge
    expect(h.output()).toContain("bun run typecheck");
    expect(h.output()).not.toContain("verification not observed");
  });

  it("states when changed code has no observed verification", () => {
    const h = harness();
    h.turn.onEvent(toolEnd("write_file", { path: "src/new.ts" }, '{"path":"src/new.ts"}'));
    h.turn.onEvent({ type: "text_delta", text: "Created the file." });
    h.turn.finish();
    expect(h.output()).toContain("verification not observed");
  });

  it("recognizes a failed-then-passing verification cycle as repaired", () => {
    const h = harness();
    h.turn.onEvent(toolEnd("edit_file", { path: "a.ts" }, '{"path":"a.ts"}'));
    h.turn.onEvent({
      type: "verification_completed",
      attempt: 1,
      ran: true,
      passed: false,
      report: "$ bun test  (exit 1)\n1 failed",
    });
    expect(h.preview()).toContain("Fixing what the checks found");
    h.turn.onEvent({
      type: "verification_completed",
      attempt: 2,
      ran: true,
      passed: true,
      report: "$ bun test  (ok)",
    });
    h.turn.onEvent({ type: "text_delta", text: "Fixed." });
    h.turn.finish();
    expect(h.output()).toContain("Complete.");
    expect(h.output()).toContain("1 failure repaired");
    expect(h.output()).not.toContain("Done with notes");
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

  it("keeps raw command evidence in details while the default stays compact", () => {
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
    expect(h.output()).toContain("42 tests passed");
    expect(h.output()).not.toContain("suite A passed");
    expect(stripAnsi(h.turn.fullLog() ?? "")).toContain("suite A passed");
  });

  it("surfaces the same error only once and never labels it done", () => {
    const h = harness();
    h.turn.onEvent({ type: "error", error: "All providers unavailable" });
    h.turn.onError(new Error("All providers unavailable"));
    h.turn.finish();
    const occurrences = h.output().split("All providers unavailable").length - 1;
    expect(occurrences).toBe(1);
    expect(h.output()).toContain("Needs attention");
    expect(h.output()).not.toContain("✓ Done");
  });

  it("records an interrupted turn without pretending it completed", () => {
    const h = harness();
    h.turn.onEvent(toolEnd("read_file", { path: "a.ts" }));
    h.turn.finish({ aborted: true });
    expect(h.output()).toContain("Interrupted.");
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
    expect(output).toContain("⌄ fix the bug");
    expect(output).toContain("I am reading the files.");
    expect(output).toContain("1 file changed");
    expect(output).toContain("1 check passed");
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
    expect(stripAnsi(userBlock("build the app"))).toContain("⌄ build the app");
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
