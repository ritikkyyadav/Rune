/** Deterministic work sequence through the real renderer; no model or tools run.
 * bun scripts/tui-capture/workspace-refinement.ts OUTDIR
 * The output is a design fixture, not evidence of an agent completing a task.
 */
import "../fake-tty";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TurnRenderer,
  userBlock,
  type TurnSink,
} from "../../packages/orchestrator/src/bin/ui/turn";
import { setTermWidthOverride } from "../../packages/orchestrator/src/bin/ui/render";
import { stripAnsi } from "../../packages/orchestrator/src/bin/ui/theme";

const out = process.argv[2]!;
mkdirSync(out, { recursive: true });
for (const width of [80, 120]) {
  setTermWidthOverride(width);
  const blocks = new Map<number, string>();
  let next = 0;
  const sink: TurnSink = {
    commit(block) {
      const id = ++next;
      blocks.set(id, block);
      return id;
    },
    amend(id, block) {
      blocks.set(id, block);
    },
  };
  sink.commit(userBlock("Keep the current theme. Make the activity workspace easier to follow."));
  const turn = new TurnRenderer(sink);
  const call = (name: string, args: Record<string, unknown>, result: Record<string, unknown>) => {
    const callId = `fixture-${++next}`;
    turn.onEvent({ type: "tool_call_start", callId, toolName: name });
    turn.onEvent({
      type: "tool_call_end",
      callId,
      args,
      output: {
        callId,
        toolName: name,
        result: JSON.stringify(result),
        success: true,
        durationMs: 28,
      },
    });
  };
  turn.onEvent({
    type: "text_delta",
    text: "I am checking how the workspace displays routine activity and changes.",
  });
  call(
    "read_file",
    { path: "src/workspace.ts" },
    {
      path: "src/workspace.ts",
      total_lines: 164,
      content: "export function renderWorkspace() {\n  return activity.map(renderBlock);\n}\n",
    },
  );
  call(
    "bash",
    { command: "git status --short" },
    { stdout: " M src/workspace.ts\n", exit_code: 0 },
  );
  turn.onEvent({
    type: "text_delta",
    text: "Routine output can stay compact. Changes will retain a short preview and expandable evidence.",
  });
  call(
    "write_file",
    {
      path: "src/activity-row.ts",
      content: Array.from({ length: 18 }, (_, i) => `// Activity rendering line ${i + 1}`).join(
        "\n",
      ),
    },
    { path: "src/activity-row.ts" },
  );
  call(
    "bash",
    { command: "bun test activity" },
    { stdout: "bun test\n\n8 pass\n0 fail\nRan 8 tests across 1 file.", exit_code: 0 },
  );
  turn.onEvent({
    type: "text_delta",
    text: "The workspace now gives routine activity less space while keeping changes and check results readable.",
  });
  turn.finish();
  const ansi = [...blocks.values()].filter(Boolean).join("\n");
  writeFileSync(join(out, `workspace-${width}.ansi`), ansi);
  writeFileSync(join(out, `workspace-${width}.txt`), stripAnsi(ansi));
}
setTermWidthOverride(null);
