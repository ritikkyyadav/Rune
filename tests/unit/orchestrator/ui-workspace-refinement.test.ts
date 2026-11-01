import { afterEach, describe, expect, test } from "bun:test";
import {
  renderToolActivity,
  renderToolDetail,
  renderChamberDetail,
  type ToolActivityView,
} from "../../../packages/orchestrator/src/bin/ui/activity";
import {
  renderPicker,
  renderSlashPalette,
} from "../../../packages/orchestrator/src/bin/ui/composer";
import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";
import { setTermWidthOverride, visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

afterEach(() => setTermWidthOverride(null));
const view = (
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown> | string,
): ToolActivityView => ({
  toolName,
  args,
  result: typeof result === "string" ? result : JSON.stringify(result),
  success: true,
});
function harness(live = true) {
  const blocks = new Map<number, { block: string; detail?: string }>();
  let seq = 0;
  const sink: TurnSink = {
    commit(block, detail) {
      const id = ++seq;
      blocks.set(id, { block, detail });
      return id;
    },
    ...(live
      ? {
          amend(id: number, block: string, detail?: string) {
            blocks.set(id, { block, detail });
          },
        }
      : {}),
  };
  const turn = new TurnRenderer(sink);
  return {
    turn,
    blocks,
    output: () => stripAnsi([...blocks.values()].map((b) => b.block).join("\n")),
  };
}

describe("a quieter workspace retains the evidence", () => {
  test("one-line reads and pages still have a usable expansion", () => {
    for (const v of [
      view(
        "read_file",
        { path: "src/a.ts" },
        { content: "  21\tconst answer = 42;", total_lines: 100, lines_shown: 1, offset: 20 },
      ),
      view("web_fetch", { url: "https://example.com" }, "A small page."),
    ]) {
      expect(stripAnsi(renderToolActivity(v)).split("\n")).toHaveLength(1);
      const detail = stripAnsi(renderToolDetail(v)!);
      expect(detail).toContain(v.toolName === "read_file" ? "const answer = 42;" : "A small page.");
      if (v.toolName === "read_file") expect(detail).toContain("lines 21-21");
    }
  });

  test("short ordinary command output can be opened without losing indentation", () => {
    const v = view(
      "bash",
      { command: "wc -l src/a.ts" },
      { stdout: "  42 src/a.ts", exit_code: 0 },
    );
    expect(stripAnsi(renderToolActivity(v)).split("\n")).toHaveLength(1);
    expect(stripAnsi(renderToolDetail(v)!)).toContain("  42 src/a.ts");
    expect(stripAnsi(renderToolActivity(v))).not.toContain("✓");
  });

  test("a long live activity group keeps every call and output in its fold", () => {
    const h = harness();
    for (let i = 0; i < 80; i++) {
      const callId = `read-${i}`;
      h.turn.onEvent({ type: "tool_call_start", callId, toolName: "read_file" });
      h.turn.onEvent({
        type: "tool_call_end",
        callId,
        args: { path: `src/file-${i}.ts` },
        output: {
          callId,
          toolName: "read_file",
          success: true,
          result: JSON.stringify({ total_lines: 1, content: `const value${i} = ${i};` }),
        },
      });
    }
    h.turn.finish();
    const visible = [...h.blocks.values()].filter((b) => b.block.trim());
    expect(visible).toHaveLength(1);
    expect(h.output()).toContain("read 80 files");
    for (let i = 0; i < 80; i++) {
      expect(stripAnsi(visible[0]!.detail!)).toContain(`src/file-${i}.ts`);
      expect(stripAnsi(visible[0]!.detail!)).toContain(`const value${i} = ${i};`);
    }
  });

  test("new files and diffs have bounded previews, exact counts and expandable tails", () => {
    const added = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
    const diff = `@@ -1,0 +1,80 @@\n${added.map((l) => `+${l}`).join("\n")}`;
    for (const v of [
      view("write_file", { path: "new.ts", content: added.join("\n") }, { path: "new.ts" }),
      view("edit_file", { path: "edit.ts" }, { path: "edit.ts", diff }),
      view("apply_patch", {}, { files: [{ path: "patch.ts", action: "modified", diff }] }),
    ]) {
      const compact = stripAnsi(renderToolActivity(v));
      expect(compact.split("\n").length).toBeLessThanOrEqual(8);
      expect(compact).toMatch(/75 more (diff |changed )?lines/);
      expect(compact).toContain("ctrl+o");
      expect(compact).toContain("+80");
      expect(stripAnsi(renderToolDetail(v)!)).toContain("line 80");
    }
  });

  test("a six-line change still expands when its sixth line became the fold hint", () => {
    const v = view("write_file", { path: "six.ts", content: "1\n2\n3\n4\n5\nlast line" }, {});
    expect(stripAnsi(renderToolActivity(v))).toContain("1 more line");
    expect(stripAnsi(renderToolActivity(v))).toContain("ctrl+o");
    expect(stripAnsi(renderToolDetail(v)!)).toContain("last line");
  });

  test("work review retains changes beyond the compact preview without requiring folds", () => {
    const h = harness();
    h.turn.onEvent({
      type: "tool_call_end",
      callId: "write",
      args: {
        path: "new.ts",
        content: Array.from({ length: 20 }, (_, i) => `content line ${i + 1}`).join("\n"),
      },
      output: { callId: "write", toolName: "write_file", success: true, result: "{}" },
    });
    h.turn.finish();
    expect(h.output()).not.toContain("content line 20");
    expect(stripAnsi(h.turn.fullLog()!)).toContain("content line 20");
    expect(stripAnsi(h.turn.fullLog()!)).not.toContain("ctrl+o");
  });

  test("failed and timed-out commands stay prominent", () => {
    for (const result of [
      { stdout: "FAILED: check the config", exit_code: 1 },
      { stdout: "still waiting", timed_out: true },
    ]) {
      const out = stripAnsi(
        renderToolActivity(view("bash", { command: "node script.js" }, result)),
      );
      expect(out).toContain("✗");
      expect(out).toContain("timed_out" in result ? "timed out" : "FAILED: check the config");
      expect(out.split("\n").length).toBeGreaterThan(1);
    }
  });

  test("opening a long activity group does not displace thousands of transcript rows", () => {
    const calls = Array.from({ length: 80 }, (_, i) =>
      i % 2
        ? view(
            "bash",
            { command: `cat file${i}.txt` },
            {
              stdout: Array.from({ length: 200 }, (_, n) => `output ${i} line ${n}`).join("\n"),
              exit_code: 0,
            },
          )
        : view(
            "read_file",
            { path: `file${i}.txt` },
            {
              content: Array.from({ length: 200 }, (_, n) => `content ${i} line ${n}`).join("\n"),
              total_lines: 200,
            },
          ),
    );
    const expanded = stripAnsi(renderChamberDetail(calls));
    expect(expanded.split("\n").length).toBeLessThan(500);
    for (let i = 0; i < 80; i++) expect(expanded).toContain(`file${i}.txt`);
    expect(expanded).toContain("ctrl+r");
  });

  test("live plans update once in place, preserving unproven status and the work log", () => {
    const h = harness();
    h.turn.onEvent({
      type: "todo_updated",
      items: [{ content: "Inspect the workspace", status: "in_progress" }],
    });
    h.turn.onEvent({
      type: "todo_updated",
      items: [{ content: "Inspect the workspace", status: "completed", unproven: "no_evidence" }],
    });
    h.turn.finish();
    expect(h.output().match(/Inspect the workspace/g)).toHaveLength(1);
    expect(h.output()).toContain("unproven");
    expect(stripAnsi(h.turn.fullLog()!).match(/Inspect the workspace/g)).toHaveLength(2);
  });

  test("inline sessions retain initial and final plan snapshots", () => {
    const h = harness(false);
    h.turn.onEvent({
      type: "todo_updated",
      items: [{ content: "Inspect the workspace", status: "in_progress" }],
    });
    h.turn.onEvent({
      type: "todo_updated",
      items: [{ content: "Inspect the workspace", status: "completed" }],
    });
    h.turn.finish();
    expect(h.output().match(/Inspect the workspace/g)).toHaveLength(2);
  });
});

describe("panels stay legible while navigating", () => {
  test("slash description columns remain stable across list windows", () => {
    const items = Array.from({ length: 24 }, (_, i) => ({
      name: i === 23 ? "/long-custom-command" : `/cmd${i}`,
      desc: "Description",
    }));
    const column = (selected: number) =>
      renderSlashPalette(items, selected, 80)
        .map(stripAnsi)
        .find((l) => l.includes("Description"))!
        .indexOf("Description");
    expect(column(0)).toBe(column(23));
    expect(stripAnsi(renderSlashPalette(items, 23, 80).join("\n"))).toContain("17-24 of 24");
  });

  test("unmatched commands explain how to recover", () => {
    const out = stripAnsi(renderSlashPalette([], 0, 40, 8, 27, "/nothing").join("\n"));
    expect(out).toContain("No matching commands");
    expect(out).toContain("esc to close");
  });

  test("selection, current tags and descriptions fit narrow and short panels", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      label: `Setting ${i} with a long name`,
      current: true,
      hint: "auto",
      description: `Description of setting ${i}. Applies to this session.`,
    }));
    for (const width of [32, 40, 80, 120]) {
      setTermWidthOverride(width);
      for (const height of [3, 8, 16])
        for (const selected of [0, 12, 24]) {
          const panel = renderPicker("Settings", items, selected, width, height);
          expect(panel.lines.length).toBeLessThanOrEqual(height);
          for (const line of panel.lines) expect(visLen(line)).toBeLessThan(width);
          const row = stripAnsi(panel.lines[panel.caretRow]!);
          expect(row).toContain("›");
          expect(row).toContain(`Setting ${selected}`);
          expect(row).toContain("current");
          if (height >= 8)
            expect(stripAnsi(panel.lines.join("\n"))).toContain(
              `Description of setting ${selected}.`,
            );
        }
    }
  });
});
