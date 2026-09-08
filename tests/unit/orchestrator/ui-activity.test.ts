/**
 * The flow grammar for one tool call, shared by the live stream and the
 * session-resume replay. Every assertion here is a design decision: the rail,
 * the four-column verb, the receipt at the right edge, and the two cases that
 * earn more than a single row.
 */

import { describe, it, expect } from "bun:test";
import {
  renderToolActivity,
  renderTranscript,
  stepHead,
  planBlock,
  runningLabel,
  commandOutcome,
  STEP,
  type ToolActivityView,
  type TranscriptLineView,
} from "../../../packages/orchestrator/src/bin/ui/activity";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../../packages/orchestrator/src/bin/ui/render";

const plain = (s: string) => stripAnsi(s);

function tool(over: Partial<ToolActivityView>): ToolActivityView {
  return { toolName: "bash", args: {}, result: "", success: true, ...over };
}

describe("renderToolActivity — one call, one row", () => {
  it("renders a read as a single rail row with the line count it reported", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "read_file",
          args: { path: "src/engine.ts" },
          result: JSON.stringify({
            path: "src/engine.ts",
            total_lines: 120,
            lines_shown: 120,
            offset: 0,
          }),
        }),
      ),
    );
    expect(out.split("\n")).toHaveLength(1);
    // A read that returned takes the neutral mark. What the row is *for* is the
    // receipt on the right — the line count — and a green tick here would only
    // compete with it.
    expect(out).toMatch(/^ {4}│ {3}read {2}src\/engine\.ts {2,}120 lines$/);
  });

  it("names the range when a read was partial, rather than implying the whole file", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "read_file",
          args: { path: "src/engine.ts" },
          result: JSON.stringify({
            path: "src/engine.ts",
            total_lines: 120,
            lines_shown: 31,
            offset: 29,
          }),
        }),
      ),
    );
    expect(out).toContain("lines 30-60");
  });

  it("reports a grep by the files it hit and points at the first one", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "grep",
          args: { pattern: "ProviderName" },
          result: JSON.stringify({
            matches: [
              { file: "src/a.ts", line_number: 42 },
              { file: "src/b.ts", line_number: 9 },
            ],
            total_matches: 3,
          }),
        }),
      ),
    ).split("\n");
    expect(out[0]).toContain("grep  ProviderName");
    expect(out[0]).toContain("2 files");
    expect(out[1]).toBe("    │ │ src/a.ts:42 | 2 more");
    expect(plain(out.join())).not.toContain("total_matches"); // parsed, not dumped
  });

  it("says `no matches` for a zero-match grep instead of leaving the receipt blank", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "grep",
          args: { pattern: "zzz" },
          result: JSON.stringify({ matches: [], total_matches: 0 }),
        }),
      ),
    );
    expect(out).toContain("no matches");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("states a passing check as its verdict alone -- the print-out is the fold's", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "bash",
          args: { command: "bun test tests/unit/" },
          durationMs: 2610,
          result: JSON.stringify({
            stdout: " Test Files  3 passed (3)\n      Tests  37 passed (37)\n 37 passed in 1.9s",
            stderr: "",
            exit_code: 0,
            timed_out: false,
          }),
        }),
      ),
    ).split("\n");
    expect(out[0]).toContain("run   bun test tests/unit/");
    expect(out[0]).toContain("2.6s");
    expect(out[1]).toBe("    │ │ 37 passed");
    expect(out).toHaveLength(2);
    expect(out.join()).not.toContain("exit_code");
  });

  it("shows a failed command as a signal excerpt closed by its own verdict", () => {
    const noise = Array.from({ length: 30 }, (_, i) => `collecting item ${i}`).join("\n");
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "bash",
          args: { command: "pytest -q" },
          result: JSON.stringify({
            stdout: `${noise}\nFAILED tests/a.py::test_x\nAssertionError: boom\n2 failed, 5 passed in 0.2s`,
            stderr: "",
            exit_code: 1,
            timed_out: false,
          }),
        }),
      ),
    ).split("\n");
    expect(out[0]).toContain("run   pytest -q");
    // The excerpt keeps the verdict-carrying lines and drops the chatter.
    expect(out.join("\n")).toContain("FAILED tests/a.py::test_x");
    expect(out.at(-1)).toBe("    │ 2 failed, 5 passed in 0.2s");
    expect(out.join("\n")).not.toContain("collecting item 2\n");
    // Contained: a failure never commits a wall.
    expect(out.length).toBeLessThanOrEqual(12);
    // The row above already names the command; the rail does not repeat it.
    expect(out.filter((l) => l.includes("pytest -q"))).toHaveLength(1);
  });

  it("prefers a runner's tally over the shell's exit code when both are known", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "bash",
          args: { command: "npx vitest run" },
          result: JSON.stringify({
            stdout: " Test Files  1 failed | 1 passed (2)\n 1 failed, 24 passed in 2.6s",
            stderr: "",
            exit_code: 1,
            timed_out: false,
          }),
        }),
      ),
    );
    expect(out).toContain("│ ✗ run ");
    expect(out).toContain("│ 1 failed, 24 passed");
    expect(out).not.toContain("exit 1");
  });

  it("falls back to the exit code when a failed command printed nothing", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "bash",
          args: { command: "ls -la /nope" },
          result: JSON.stringify({ stdout: "", stderr: "", exit_code: 1, timed_out: false }),
        }),
      ),
    );
    expect(out).toContain("ls -la /nope");
    expect(out).toContain("exit 1");
  });

  it("keeps an ordinary one-line command to one row and its one line of output", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "bash",
          args: { command: "git rev-parse HEAD" },
          result: JSON.stringify({ stdout: "9be117a\n", stderr: "", exit_code: 0 }),
        }),
      ),
    ).split("\n");
    expect(out).toHaveLength(2);
    // The output line is verbatim output, on the output rail.
    expect(out[1]).toBe("    │ 9be117a");
  });

  it("ALWAYS shows an edit's diff, with real line numbers and signed counts", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "edit_file",
          args: { path: "src/engine.ts" },
          result: JSON.stringify({
            path: "src/engine.ts",
            diff: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;",
          }),
        }),
      ),
    ).split("\n");
    // The verb column is held whether or not a row carries a mark, so an edit
    // lines up with the reads above it instead of hanging two cells left.
    expect(out[0]).toMatch(/^ {4}│ {3}edit {2}src\/engine\.ts/);
    expect(out[0]).toContain("edit  src/engine.ts");
    expect(out[0]).toContain("+1 -1 | 1 hunk");
    expect(out[1]).toBe("    │    1 - const a = 1;");
    expect(out[2]).toBe("    │    1 + const a = 2;");
    // An edit carries no mark at all: the diff below it is the evidence, and it
    // does not need a tick to vouch for it.
    expect(out[0]).not.toContain("✓");
  });

  it("renders a new file as a write with its own line count", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "write_file",
          args: { path: "a.ts", content: "one\ntwo\nthree" },
          result: JSON.stringify({ path: "a.ts", bytes_written: 13 }),
        }),
      ),
    );
    expect(out).toContain("new   a.ts");
    expect(out).toContain("+3 | new file");
  });

  it("renders web_search with its query, never the raw args JSON", () => {
    const out = plain(
      renderToolActivity(
        tool({ toolName: "web_search", args: { query: "what is today's date" }, result: "a\nb" }),
      ),
    );
    expect(out).toContain("web   what is today's date");
    expect(out).not.toContain("{");
  });

  it("renders a failure as its own row plus the tool's own reason", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "read_file",
          args: { path: "missing.ts" },
          success: false,
          error: "ENOENT: no such file or directory",
        }),
      ),
    ).split("\n");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("│ ✗ read  missing.ts");
    expect(out[1]).toBe("    │ │ ENOENT: no such file or directory");
  });

  it("uses the width it has, and never spills past a narrow terminal", () => {
    for (const columns of [60, 80, 200]) {
      setTermWidthOverride(columns);
      const blocks = [
        renderToolActivity(
          tool({
            toolName: "bash",
            args: { command: "echo " + "x".repeat(300) },
            result: JSON.stringify({
              stdout: "ok " + "y".repeat(200),
              stderr: "",
              exit_code: 0,
            }),
          }),
        ),
        renderToolActivity(
          tool({
            toolName: "read_file",
            args: { path: "/" + Array(20).fill("segment").join("/") + "/file.ts" },
            result: JSON.stringify({ total_lines: 5, lines_shown: 5, offset: 0 }),
          }),
        ),
      ];
      for (const block of blocks) {
        for (const line of block.split("\n")) {
          // The invariant this test's name states is the TERMINAL width, not a
          // fixed ceiling. Rows follow the window now: capping them at 120 on a
          // 241-column screen truncated paths while half the window sat empty.
          expect(plain(line).length).toBeLessThanOrEqual(columns);
        }
      }
    }
    setTermWidthOverride(null);
  });
});

describe("commandOutcome", () => {
  it("reads the runner's verdict from the end, not its per-file counts", () => {
    expect(
      commandOutcome(" Test Files  1 failed | 1 passed (2)\n 1 failed, 24 passed in 2.6s"),
    ).toBe("1 failed, 24 passed");
  });

  it("falls back to the last line when nothing stated a tally", () => {
    expect(commandOutcome("cloning…\ndone.")).toBe("done.");
  });
});

describe("renderTranscript — batch replay", () => {
  const L = (
    over: Partial<TranscriptLineView> & { role: TranscriptLineView["role"] },
  ): TranscriptLineView => ({
    text: "",
    ...over,
  });

  it("bands the user's words and opens `●` for the agent", () => {
    const out = plain(
      renderTranscript([
        L({ role: "user", text: "fix the bug" }),
        L({ role: "assistant", text: "On it." }),
      ]),
    ).split("\n");
    // The user's line is a speaker band (a monochrome inverse), so with colour
    // stripped it is the words themselves, inset and padded -- no chevron.
    expect(out[1]?.trim()).toBe("fix the bug");
    expect(out[1]).not.toContain("›");
    expect(out[2]).toBe(`  ${STEP} On it.`);
  });

  it("collapses a run of consecutive reads into one rail row", () => {
    const reads = [1, 2, 3].map((n) =>
      L({ role: "tool", toolName: "read_file", args: { path: `${n}.ts` } }),
    );
    expect(plain(renderTranscript(reads))).toBe("    │ › read 3 files");
  });

  it("keeps a single read as its own row", () => {
    const out = plain(
      renderTranscript([L({ role: "tool", toolName: "read_file", args: { path: "only.ts" } })]),
    );
    expect(out).toContain("│   read  only.ts");
  });

  it("interleaves prose → work → prose as three distinct blocks", () => {
    const out = plain(
      renderTranscript([
        L({ role: "assistant", text: "Looking." }),
        L({ role: "tool", toolName: "bash", args: { command: "ls" } }),
        L({ role: "assistant", text: "Done." }),
      ]),
    ).split("\n");
    expect(out.filter((l) => l.startsWith(`  ${STEP} `))).toHaveLength(2);
    expect(out.some((l) => l.includes("│   run   ls"))).toBe(true);
  });

  it("spends the green tick only on a command that checked something", () => {
    const run = (command: string, exit = 0) =>
      plain(
        renderToolActivity(
          tool({
            toolName: "bash",
            args: { command },
            result: JSON.stringify({ stdout: "42 passed\n", stderr: "", exit_code: exit }),
          }),
        ),
      ).split("\n")[0]!;
    // A check that came back clean is the one routine outcome worth announcing.
    expect(run("npx vitest run")).toContain("│ ✓ run ");
    expect(run("bun run typecheck")).toContain("│ ✓ run ");
    // Anything that merely ran reports itself in the receipt column instead.
    expect(run("git status --short")).toContain("│   run ");
    expect(run("mkdir -p dist")).toContain("│   run ");
    // A failure still interrupts, checked or not.
    expect(run("npx vitest run", 1)).toContain("│ ✗ run ");
    expect(run("git push", 1)).toContain("│ ✗ run ");
  });

  it("renders a compaction note", () => {
    expect(plain(renderTranscript([L({ role: "note", text: "context compacted earlier" })]))).toBe(
      "  -- context compacted earlier --",
    );
  });
});

describe("helpers", () => {
  it("stepHead prefixes the ◇ marker", () => {
    expect(plain(stepHead("hello"))).toBe(`  ${STEP} hello`);
  });

  it("drops an authored Plan label rather than repeating it", () => {
    expect(plain(planBlock("Plan: Trace the request path.").join("\n"))).toBe(
      `  ${STEP} Trace the request path.`,
    );
  });

  it("runningLabel gives a present-tense verb for the live status", () => {
    expect(runningLabel("read_file")).toBe("reading");
    expect(runningLabel("bash")).toBe("running");
  });
});

// ─── The envelope, the harness's own rows, and the rule that a row never
// shows an object. From the transcript diagnosis of 2026-09-05: a doctrine
// block prepended to an edit's result hid its diff; record_evidence, ask_user,
// read_back and note_hypothesis printed their argument JSON; a command that
// merely ran was summarised by its last line, whatever that was. ───

import {
  unwrapEnvelope,
  describeArgs,
  renderToolDetail,
  HARNESS_TOOLS,
} from "../../../packages/orchestrator/src/bin/ui/activity";

const DIFF = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c";

describe("the harness envelope around a tool result", () => {
  const json = JSON.stringify({ path: "src/a.ts", diff: DIFF, hash: "x" });

  it("peels a doctrine block and a harness note off the front, and hook output off the back", () => {
    const wrapped =
      "[Doctrine — applies for the rest of the session]\n# Building interfaces\n- one rule {with a brace}\n\n" +
      "[Harness note] Recurring mistakes on this machine — avoid them:\n- bash (3×): sandboxed\n\n" +
      json +
      "\n\n[post-tool hook output]\nprettier: formatted 1 file";
    const { body, notes } = unwrapEnvelope(wrapped);
    expect(body).toBe(json);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("[Doctrine");
    expect(notes[2]).toContain("prettier");
  });

  it("leaves a plain result alone", () => {
    expect(unwrapEnvelope(json)).toEqual({ body: json, notes: [] });
    expect(unwrapEnvelope("plain prose report").body).toBe("plain prose report");
  });

  it("an edit keeps its diff whatever the harness wrapped around it", () => {
    for (const result of [
      json,
      `[Doctrine — applies for the rest of the session]\nrule {a}\n\n${json}`,
      `[Harness note] batch your reads\n\n${json}`,
      `${json}\n\n[post-tool hook output]\nok`,
      `[Harness note] note {with: braces}\n\n${json}\n\n[post-tool hook output]\n{"also":"braces"}`,
    ]) {
      const out = plain(
        renderToolActivity(tool({ toolName: "edit_file", args: { path: "src/a.ts" }, result })),
      );
      expect(out, result.slice(0, 40)).toContain("│   edit  src/a.ts  +1 -1 | 1 hunk");
      expect(out, result.slice(0, 40)).toContain("2 - b");
      expect(out, result.slice(0, 40)).toContain("2 + B");
    }
  });
});

describe("a command that merely ran shows its first lines and its last", () => {
  it("five lines inline, the rest counted, the whole print-out in the fold", () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join("\n");
    const view = tool({
      toolName: "bash",
      args: { command: "ls -lh" },
      result: JSON.stringify({ stdout, stderr: "", exit_code: 0, timed_out: false }),
    });
    const out = plain(renderToolActivity(view));
    expect(out).toContain("│   run   ls -lh");
    for (const n of [1, 2, 3, 4]) expect(out).toContain(`│ row ${n}`);
    expect(out).not.toContain("row 5\n");
    expect(out).toContain("7 more lines");
    expect(out).toContain("│ row 12"); // the verdict line, last
    const detail = plain(renderToolDetail(view) ?? "");
    expect(detail).toContain("row 5");
    expect(detail).toContain("row 11");
  });

  it("a short output is shown whole, with no count", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "bash",
          args: { command: "wc -l app.js" },
          result: JSON.stringify({ stdout: "  995 app.js", stderr: "", exit_code: 0 }),
        }),
      ),
    );
    expect(out).toContain("│ 995 app.js");
    expect(out).not.toContain("more line");
  });
});

describe("the harness's own tools have designed rows", () => {
  const cases: Array<[ToolActivityView, string[]]> = [
    [
      tool({
        toolName: "ask_user",
        args: {
          questions: [{ question: "Which data source?", options: ["live", "conversation"] }],
        },
        result: "live",
      }),
      ["│   ask   Which data source?", "│ │ answered live"],
    ],
    [
      tool({
        toolName: "ask_user",
        args: { questions: [{ question: "Platform?" }, { question: "Depth?" }] },
        result: "Q: Platform?\nA: web\n\nQ: Depth?\nA: working core",
      }),
      ["│   ask   Platform?  2 questions", "│ │ answered web"],
    ],
    [
      tool({
        toolName: "record_evidence",
        args: { criterion: 1, command: "curl -sS http://x" },
        result:
          "Recorded as observed: it appeared in output that can be quoted back. (1 of 3 criteria verified)",
      }),
      ["│   evidence  criterion 2 · curl -sS http://x  observed"],
    ],
    [
      tool({
        toolName: "record_evidence",
        args: { claim: "the export is on disk", command: "ls -lh out.html" },
        result:
          'Noted for "the export is on disk": observed — it appeared in output. No read_back criteria are in play, so this settles no criterion.',
      }),
      ["│   evidence  the export is on disk · ls -lh out.html  observed"],
    ],
    [
      tool({
        toolName: "note_hypothesis",
        args: { text: "the timer is cleared before the await" },
        result: "h1 recorded as testing",
      }),
      ['│   hypothesis  "the timer is cleared before the await"  testing'],
    ],
    [
      tool({
        toolName: "note_hypothesis",
        args: { id: "h2", status: "refuted", reason: "TTL unchanged across the deploy" },
        result: "h2 refuted",
      }),
      ["│   hypothesis  h2  refuted", "│ │ TTL unchanged across the deploy"],
    ],
    [
      tool({
        toolName: "record_decision",
        args: { text: "restore the customer index", based_on: [{ kind: "check", ref: "x" }] },
        result: "d1 recorded",
      }),
      ["│   decision  restore the customer index  on 1 piece of evidence"],
    ],
    [
      tool({
        toolName: "read_back",
        args: { kind: "build", reading: "You want…", done_when: ["a", "b", "c"] },
        result: "Accepted. Work to this brief and report against these criteria.",
      }),
      ["│   read-back  build  3 criteria · accepted"],
    ],
    [
      tool({
        toolName: "read_many",
        args: { paths: ["a.ts", "b.ts", "c.ts"] },
        result: "=== a.ts ===\n1\n2\n=== b.ts ===\n3\n=== c.ts ===\n4\n5\n6",
      }),
      ["│   read  3 files  6 lines"],
    ],
    [
      tool({
        toolName: "team",
        args: { action: "claim", paths: ["bangla-sweets/"] },
        result: "{}",
      }),
      ["│   team  claim · bangla-sweets/"],
    ],
    [
      tool({
        toolName: "mcp_linear_create_issue",
        args: { title: "Fix the retry loop", body: { nested: { deep: true } } },
        result: '{"id":"LIN-42"}',
      }),
      ["│   mcp_linear_create_issue  Fix the retry loop"],
    ],
  ];

  for (const [view, expected] of cases) {
    it(`renders ${view.toolName} as words, never as its argument object`, () => {
      const out = plain(renderToolActivity(view));
      for (const line of expected) expect(out).toContain(line);
      expect(out).not.toContain('{"');
    });
  }

  it("a harness tool's failure is a quiet note, not a red row", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "todo_write",
          args: { items: [{ content: "x", status: "completed" }] },
          success: false,
          error: 'Plan not updated: step 1 "x" is not closed: nothing ran while it was open.',
        }),
      ),
    );
    expect(out).toContain("│   plan  updated");
    expect(out).toContain("│ │ Plan not updated: step 1");
    expect(out).not.toContain("✗");
    expect(HARNESS_TOOLS.has("todo_write")).toBe(true);
  });

  it("describeArgs picks the most descriptive scalar and never returns JSON", () => {
    expect(describeArgs({ questions: [{ question: "Which?" }], other: 1 })).toBe("1");
    expect(describeArgs({ title: "Fix it", body: { a: 1 } })).toBe("Fix it");
    expect(describeArgs({ nested: { only: true } })).toBe("");
  });
});

describe("apply_patch renders a row and a diff per file", () => {
  it("modified, deleted and moved files each get their own edit row", () => {
    const view = tool({
      toolName: "apply_patch",
      args: { patch: "*** Begin Patch\n…" },
      result: JSON.stringify({
        files: [
          { path: "src/a.ts", action: "modified", diff: DIFF, hash: "h" },
          {
            path: "src/gone.ts",
            action: "deleted",
            diff: "--- a/src/gone.ts\n+++ b/src/gone.ts\n@@ -1,2 +1,1 @@\n-one\n-two\n ",
          },
        ],
      }),
    });
    const out = plain(renderToolActivity(view));
    expect(out).toContain("│   edit  src/a.ts  +1 -1 | 1 hunk");
    expect(out).toContain("│   edit  src/gone.ts  -2 | deleted");
    expect(out).toContain("1 - one");
    expect(out).not.toContain("apply_patch");
    expect(out).not.toContain('{"');
  });
});
