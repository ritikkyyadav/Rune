/**
 * Unit tests for the thought-chain activity renderer — the compact one-line-per-tool
 * language shared by the live stream and the session-resume replay.
 */

import { describe, it, expect } from "bun:test";
import {
  renderToolActivity,
  renderTranscript,
  stepHead,
  runningLabel,
  STEP,
  type ToolActivityView,
  type TranscriptLineView,
} from "../../../packages/orchestrator/src/bin/ui/activity";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

const plain = (s: string) => stripAnsi(s);

function tool(over: Partial<ToolActivityView>): ToolActivityView {
  return { toolName: "bash", args: {}, result: "", success: true, ...over };
}

describe("renderToolActivity — compact one-liners", () => {
  it("renders a read as a single `Read <file>` line", () => {
    const out = plain(renderToolActivity(tool({ toolName: "read_file", args: { path: "src/engine.ts" } })));
    expect(out).toBe("  Read  src/engine.ts");
    expect(out.split("\n")).toHaveLength(1);
  });

  // Tool results are STRUCTURED JSON (matching the Rust tools' Output structs), not raw text —
  // these tests feed the real shapes so a "dump the JSON blob" regression can't slip through.
  it("renders a grep with the real total_matches count (JSON result)", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "grep",
          args: { pattern: "ProviderName" },
          result: JSON.stringify({ total_matches: 3, matches: [{}, {}, {}], truncated: false }),
        }),
      ),
    );
    expect(out).toContain("Searched");
    expect(out).toContain('"ProviderName"');
    expect(out).toContain("3 matches");
    expect(out).not.toContain("total_matches"); // the JSON is parsed, not dumped
  });

  it("says `no matches` for a zero-match grep", () => {
    const out = plain(
      renderToolActivity(
        tool({ toolName: "grep", args: { pattern: "zzz" }, result: JSON.stringify({ total_matches: 0, matches: [] }) }),
      ),
    );
    expect(out).toContain("no matches");
  });

  it("renders a bash run with the last stdout line (JSON result), not the raw blob", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "bash",
          args: { command: "bun test" },
          result: JSON.stringify({ stdout: "...\n531 pass", stderr: "", exit_code: 0, timed_out: false }),
        }),
      ),
    );
    expect(out).toContain("Ran");
    expect(out).toContain("bun test");
    expect(out).toContain("531 pass");
    expect(out).not.toContain("exit_code"); // parsed, not dumped
    expect(out).not.toContain("stdout");
  });

  it("surfaces a nonzero bash exit code instead of output", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "bash",
          args: { command: "ls -la" },
          result: JSON.stringify({ stdout: "", stderr: "nope", exit_code: 1, timed_out: false }),
        }),
      ),
    );
    expect(out).toContain("Ran");
    expect(out).toContain("ls -la");
    expect(out).toContain("exit 1");
  });

  it("renders web_search with its query (not raw args JSON)", () => {
    const out = plain(
      renderToolActivity(tool({ toolName: "web_search", args: { query: "what is today's date" }, result: "[]" })),
    );
    expect(out).toContain("Searched web");
    expect(out).toContain("what is today's date");
    expect(out).not.toContain("{"); // no raw JSON args
  });

  it("renders a write with its byte count", () => {
    const out = plain(
      renderToolActivity(
        tool({ toolName: "write_file", args: { path: "a.ts" }, result: '{"path":"a.ts","bytes_written":42}' }),
      ),
    );
    expect(out).toContain("Wrote");
    expect(out).toContain("a.ts");
    expect(out).toContain("42 bytes");
  });

  it("ALWAYS shows the diff for an edit, with +/- counts", () => {
    const out = plain(
      renderToolActivity(
        tool({
          toolName: "edit_file",
          args: { path: "src/engine.ts" },
          result: JSON.stringify({ path: "src/engine.ts", diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;" }),
        }),
      ),
    );
    expect(out).toContain("Edited");
    expect(out).toContain("src/engine.ts");
    expect(out).toContain("+1");
    expect(out).toContain("-1");
    expect(out).toContain("const a = 1;"); // the diff body is present, not collapsed
    expect(out).toContain("const a = 2;");
  });

  it("renders a failure on one line with the reason (no 6-line preview)", () => {
    const out = plain(
      renderToolActivity(
        tool({ toolName: "read_file", args: { path: "missing.ts" }, success: false, error: "ENOENT: no such file" }),
      ),
    );
    expect(out).toContain("Read");
    expect(out).toContain("missing.ts");
    expect(out).toContain("ENOENT");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("never overflows the terminal width, even with a long command + tail or long path", () => {
    const longCmd = renderToolActivity(
      tool({
        toolName: "bash",
        args: { command: "echo " + "x".repeat(300) },
        result: JSON.stringify({ stdout: "ok " + "y".repeat(200), stderr: "", exit_code: 0, timed_out: false }),
      }),
    );
    const longPath = renderToolActivity(
      tool({ toolName: "read_file", args: { path: "/" + Array(20).fill("segment").join("/") + "/file.ts" } }),
    );
    for (const block of [longCmd, longPath]) {
      for (const line of block.split("\n")) expect(plain(line).length).toBeLessThanOrEqual(80);
    }
  });
});

describe("renderTranscript — batch replay", () => {
  const L = (over: Partial<TranscriptLineView> & { role: TranscriptLineView["role"] }): TranscriptLineView => ({
    text: "",
    ...over,
  });

  it("opens a ● step for assistant prose and `›` for the user", () => {
    const out = plain(
      renderTranscript([
        L({ role: "user", text: "fix the bug" }),
        L({ role: "assistant", text: "On it." }),
      ]),
    ).split("\n");
    expect(out[0]).toBe("  › fix the bug");
    expect(out[1]).toBe(`  ${STEP} On it.`);
  });

  it("collapses a run of consecutive reads into `Read N files`", () => {
    const reads = (p: string): TranscriptLineView =>
      L({ role: "tool", toolName: "read_file", args: { path: p }, result: "x" });
    const out = plain(
      renderTranscript([reads("a.ts"), reads("b.ts"), reads("c.ts")]),
    );
    expect(out).toBe("  Read  3 files");
  });

  it("keeps a single read as `Read <file>` (no collapse)", () => {
    const out = plain(
      renderTranscript([L({ role: "tool", toolName: "read_file", args: { path: "only.ts" }, result: "x" })]),
    );
    expect(out).toBe("  Read  only.ts");
  });

  it("interleaves prose → tools → prose as two distinct ● steps", () => {
    const out = plain(
      renderTranscript([
        L({ role: "assistant", text: "First I look." }),
        L({ role: "tool", toolName: "bash", args: { command: "ls" }, result: "a\nb" }),
        L({ role: "assistant", text: "Now I fix." }),
      ]),
    ).split("\n");
    expect(out.filter((l) => l.startsWith(`  ${STEP} `))).toHaveLength(2);
    expect(out[1]).toContain("Ran");
  });

  it("renders a compaction note", () => {
    const out = plain(renderTranscript([L({ role: "note", text: "context compacted earlier" })]));
    expect(out).toBe("  — context compacted earlier —");
  });
});

describe("helpers", () => {
  it("stepHead prefixes the ● marker", () => {
    expect(plain(stepHead("hello"))).toBe(`  ${STEP} hello`);
  });

  it("runningLabel gives a present-tense verb for the live status", () => {
    expect(runningLabel("read_file")).toBe("Reading");
    expect(runningLabel("bash")).toBe("Running");
    expect(runningLabel("some_mcp_tool")).toBe("some_mcp_tool");
  });
});
