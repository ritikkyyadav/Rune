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

/**
 * A box, split into the three parts §2.3 gives every tool call: a title row
 * that opens the frame and carries the verb and the argument verbatim, the
 * tool's own lines inside it, and a receipt row that closes it and carries the
 * outcome and the metrics.
 *
 * The frame is what these tests check most often, because it is the property a
 * box has that a rail does not: it closes. A rectangle that does not close has
 * stopped being a rectangle, and it is the failure that a width change causes
 * and an eye does not catch.
 */
function boxParts(block: string): {
  title: string;
  body: string[];
  /** Body rows with the frame taken off: what the tool actually printed. The
   *  pad between the text and the right edge is the frame's, not the tool's. */
  text: string[];
  receipt: string;
} {
  const lines = plain(block).split("\n");
  const body = lines.slice(1, -1);
  return {
    title: lines[0]!,
    body,
    text: body.map((row) => row.replace(/^ {2}[\u2502|] /, "").replace(/\s*[\u2502|]$/, "")),
    receipt: lines.at(-1)!,
  };
}

/** Both corners present, on both rows, ending in the same column. */
function expectClosed(block: string): void {
  const { title, body, receipt } = boxParts(block);
  expect(title).toMatch(/^ {2}\u250c .+\u2510$/);
  expect(receipt).toMatch(/^ {2}\u2514 .+\u2518$/);
  expect(title.length).toBe(receipt.length);
  // Every body row stands between the two side edges, at the same measure. A
  // body row that is short is a hole in the frame; one that is long has pushed
  // the right edge off the row it belongs to.
  for (const row of body) {
    expect(row).toMatch(/^ {2}\u2502 .*\u2502$/);
    expect(row.length).toBe(title.length);
  }
}

function tool(over: Partial<ToolActivityView>): ToolActivityView {
  return { toolName: "bash", args: {}, result: "", success: true, ...over };
}

describe("renderToolActivity — one call, one row", () => {
  it("frames a read, with the span it reported in the receipt", () => {
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
    // A read produced a FILE, and a file is code: §2.3 frames it. With nothing
    // to preview -- this result carried no content -- the box is its two
    // structural rows and no body, which is still a frame and still says which
    // file and how much of it.
    expectClosed(out);
    const { title, body, receipt } = boxParts(out);
    expect(body).toEqual([]);
    expect(title).toContain("read  src/engine.ts");
    // The neutral mark, and the rung in words. A read is quotable output, so it
    // is `observed`; the tick costs a test that failed on the parent commit and
    // a box that spent it here would outrank the ledger.
    expect(receipt).toContain("· observed · 120 lines");
    expect(receipt).not.toContain("✓");
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
    expect(out[1]).toBe("    │ │ src/a.ts:42 · 2 more");
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

  it("frames a passing check around the evidence that says it passed", () => {
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
    );
    // It used to be the tally alone: one row saying `37 passed`, with the
    // print-out behind the fold. Inside a frame the evidence costs four rows,
    // and four rows is the difference between being TOLD a suite passed and
    // seeing it say so.
    expectClosed(out);
    const { title, body, receipt } = boxParts(out);
    expect(title).toContain("run   bun test tests/unit/");
    expect(body.join("\n")).toContain("37 passed in 1.9s");
    // The metrics are the receipt's, in order: how it ended, its tally, how
    // long it took.
    expect(receipt).toContain("✓");
    expect(receipt).toContain("exit 0");
    expect(receipt).toContain("2.6s");
    // Never the raw envelope the tool returned.
    expect(out).not.toContain("exit_code");
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
    );
    expectClosed(out);
    const { title, body, receipt } = boxParts(out);
    expect(title).toContain("run   pytest -q");
    // The excerpt keeps the verdict-carrying lines and drops the chatter, and
    // the runner's own last line is the body's last row -- which is where a
    // runner puts its verdict.
    expect(body.join("\n")).toContain("FAILED tests/a.py::test_x");
    expect(body.at(-1)).toContain("2 failed, 5 passed in 0.2s");
    expect(body.join("\n")).not.toContain("collecting item 2\n");
    // Contained: a failure never commits a wall. The 12-row body cap is the
    // keel rule -- nothing larger enters the workspace without a keystroke --
    // and the two frame rows are on top of it.
    expect(out.split("\n").length).toBeLessThanOrEqual(14);
    expect(body.length).toBeLessThanOrEqual(12);
    expect(receipt).toContain("✗");
    // The title already names the command; nothing below repeats it.
    expect(out.split("\n").filter((l) => l.includes("pytest -q"))).toHaveLength(1);
  });

  it("carries the shell's exit code AND the runner's tally: two different facts", () => {
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
    // The row form had one receipt cell and had to choose; a receipt row has
    // space for the metrics in order, and they answer different questions.
    // `exit 1` is what the shell returned -- the fact a script branches on --
    // and `1 failed, 24 passed` is what the runner counted.
    expectClosed(out);
    const { body, receipt } = boxParts(out);
    expect(receipt).toContain("✗");
    expect(receipt).toContain("exit 1");
    expect(receipt).toContain("1 failed, 24 passed");
    expect(body.join("\n")).toContain("1 failed | 1 passed (2)");
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

  it("keeps an ordinary one-line command to one body row", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "bash",
          args: { command: "git rev-parse HEAD" },
          result: JSON.stringify({ stdout: "9be117a\n", stderr: "", exit_code: 0 }),
        }),
      ),
    );
    expectClosed(out);
    const { body, text, receipt } = boxParts(out);
    // One line in, one line out: reformatted never, inside the frame.
    expect(body).toHaveLength(1);
    expect(text[0]).toBe("9be117a");
    expect(receipt).toContain("exit 0");
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
    );
    expectClosed(out);
    const { title, text, receipt } = boxParts(out);
    // The verb column is held whether or not a row carries a mark, so an edit
    // lines up with the reads above it instead of hanging two cells left.
    expect(title).toMatch(/^ {2}\u250c edit {2}src\/engine\.ts /);
    // The diff is banded INSIDE the frame: the frame is the left edge, and the
    // rail that used to carry it would be a second left edge on the same row.
    expect(text[0]).toBe("   1 - const a = 1;");
    expect(text[1]).toBe("   1 + const a = 2;");
    expect(receipt).toContain("+1 -1 | 1 hunk");
    // An edit's receipt carries no tick: the diff above it is the evidence, and
    // it does not need one to vouch for it.
    expect(receipt).not.toContain("✓");
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

  it("keeps a single read as its own box", () => {
    const out = plain(
      renderTranscript([L({ role: "tool", toolName: "read_file", args: { path: "only.ts" } })]),
    );
    // One read is worth naming; three are a burst and collapse to the chamber
    // row above. The named one is framed like every other call.
    expect(out).toContain("┌ read  only.ts");
    expect(out.split("\n").at(-1)).toMatch(/^ {2}\u2514 .+\u2518$/);
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
    // The work between them is a box, which is the whole of what separates it
    // from the two sentences around it.
    expect(out.some((l) => l.includes("\u250c run   ls"))).toBe(true);
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
      )
        .split("\n")
        .at(-1)!;
    // The mark moved from the row's left edge to the RECEIPT, which is the row
    // that knows how the call ended -- a title row is written before the call
    // returns and cannot carry an outcome without lying for the duration.
    //
    // A check that came back clean is the one routine outcome worth announcing.
    expect(run("npx vitest run")).toContain("\u2514 ✓ ");
    expect(run("bun run typecheck")).toContain("\u2514 ✓ ");
    // Anything that merely ran takes the neutral mark: a tick spent on fifteen
    // routine calls is a tick that has been spent before the one that mattered.
    expect(run("git status --short")).toContain("\u2514 · ");
    expect(run("mkdir -p dist")).toContain("\u2514 · ");
    // A failure still interrupts, checked or not.
    expect(run("npx vitest run", 1)).toContain("\u2514 ✗ ");
    expect(run("git push", 1)).toContain("\u2514 ✗ ");
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
      expect(out, result.slice(0, 40)).toContain("\u250c edit  src/a.ts ");
      expect(out, result.slice(0, 40)).toContain("+1 -1 | 1 hunk");
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
    expect(out).toContain("\u250c run   ls -lh");
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
    // Reformatted never: `wc -l` right-aligns its count and the box keeps the
    // two leading spaces it aligned with. The rail used to trim them.
    expect(out).toContain("│   995 app.js");
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
    // One box per file, each closing on its own receipt: a patch that touched
    // two files is two changes, and one frame around both would say otherwise.
    expect(out).toContain("\u250c edit  src/a.ts ");
    expect(out).toContain("+1 -1 | 1 hunk");
    expect(out).toContain("\u250c edit  src/gone.ts ");
    expect(out).toContain("-2 | deleted");
    expect(out.split("\n").filter((l) => l.startsWith("  \u250c "))).toHaveLength(2);
    expect(out.split("\n").filter((l) => l.startsWith("  \u2514 "))).toHaveLength(2);
    expect(out).toContain("1 - one");
    expect(out).not.toContain("apply_patch");
    expect(out).not.toContain('{"');
  });
});

describe("tool-row paths read against the workspace", () => {
  it("a file inside the workspace is shown relative to it; outside, under the home as ~", async () => {
    const { listingPath, setActivityWorkspaceRoot } =
      await import("../../../packages/orchestrator/src/bin/ui/activity");
    const { homedir } = await import("node:os");
    setActivityWorkspaceRoot("/private/tmp/claude-501/rune-live-gFFS/ws");
    try {
      expect(listingPath("/private/tmp/claude-501/rune-live-gFFS/ws/greet.ts")).toBe("greet.ts");
      expect(listingPath("/private/tmp/claude-501/rune-live-gFFS/ws/src/a/b.ts")).toBe(
        "src/a/b.ts",
      );
      expect(listingPath("/private/tmp/claude-501/rune-live-gFFS/ws")).toBe(".");
      expect(listingPath(`${homedir()}/notes/todo.md`)).toBe("~/notes/todo.md");
      expect(listingPath("/opt/very/deep/path/to/some/file.txt")).toBe(".../path/to/some/file.txt");
      expect(listingPath("src/local.ts")).toBe("src/local.ts");
    } finally {
      setActivityWorkspaceRoot(null);
    }
  });
});
