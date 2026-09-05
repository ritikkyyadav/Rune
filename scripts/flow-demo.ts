// The flow design system, rendered by the real product code.
//
// Every block below comes from the module that ships it — the header from
// ui/banner, the transcript from ui/turn + ui/activity, the prompt from
// ui/composer — driven by a scripted turn of engine events. Nothing here is a
// mock, so if this looks right, `rune` looks right. It needs no API key, which
// makes it the fastest way to review a change to the terminal UI.
//
//   bun run scripts/flow-demo.ts
import { setTheme } from "../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../packages/orchestrator/src/bin/ui/render";
import { renderBanner } from "../packages/orchestrator/src/bin/ui/banner";
import { TurnRenderer, userBlock } from "../packages/orchestrator/src/bin/ui/turn";
import {
  permissionModeBanner,
  renderComposer,
  renderPermissionCard,
  renderPicker,
  renderSlashPalette,
  sandboxModeBanner,
  statusLine,
  waitingRung,
} from "../packages/orchestrator/src/bin/ui/composer";
import { formatCompaction, formatFallback } from "../packages/orchestrator/src/bin/ui/events";
import { renderStatus } from "../packages/orchestrator/src/bin/ui/status";

setTheme("flow");
const COLS = Number(process.env.COLS ?? 84);
setTermWidthOverride(COLS);

const say = (s: string) => process.stdout.write(s + "\n");

say(
  renderBanner({
    model: "claude-opus-5",
    workspace: "/Users/dev/acme/sdk-ts",
    branch: "fix/stream-stop",
    dirtyFiles: 3,
    version: "0.3.0",
    scope: "1st gear",
    caution: "every action asks first",
    sandbox: true,
  }),
);

say(
  userBlock(
    "the streaming client drops the last content block when a turn ends in tool_use. find it and fix it, with a test",
  ),
);

const renderer = new TurnRenderer({ commit: (b) => say(b), preview: () => {} });
const ev = (e: unknown) => renderer.onEvent(e);

ev({
  type: "text_delta",
  text: "I'll reproduce it first, then read the event loop. My guess is the loop exits on the wrong event, but a guess is not a diagnosis.",
});
ev({
  type: "tool_call_end",
  args: { pattern: "content_block_stop", path: "src" },
  output: {
    toolName: "grep",
    success: true,
    durationMs: 180,
    result: JSON.stringify({
      matches: [
        { file: "src/streaming.ts", line_number: 42, content: "" },
        { file: "test/a.test.ts", line_number: 9, content: "" },
        { file: "test/b.test.ts", line_number: 3, content: "" },
      ],
      total_matches: 4,
    }),
  },
});
ev({
  type: "tool_call_end",
  args: { path: "src/streaming.ts", offset: 29, limit: 31 },
  output: {
    toolName: "read_file",
    success: true,
    result: JSON.stringify({
      path: "src/streaming.ts",
      total_lines: 120,
      lines_shown: 31,
      offset: 29,
    }),
  },
});
ev({
  type: "text_delta",
  text: "Found it. The loop breaks on content_block_stop, which fires after every block — not just the last one. When a turn ends in tool_use the final block is still open when that event arrives, so it is never pushed.",
});
ev({
  type: "tool_call_end",
  args: { path: "src/streaming.ts" },
  output: {
    toolName: "edit_file",
    success: true,
    result: JSON.stringify({
      path: "src/streaming.ts",
      replacements: 1,
      diff: `@@ -38,6 +38,11 @@
   const stream = await client.messages.stream(request)
   let current: ContentBlock | null = null
 
   for await (const event of stream) {
-    if (event.type === 'content_block_stop') break
+    if (event.type === 'content_block_stop') {
+      if (current) blocks.push(current)
+      current = null
+      continue
+    }
+    if (event.type === 'message_stop') break
     current = apply(event, current)
   }`,
    }),
  },
});
ev({
  type: "tool_call_end",
  args: { command: "npx vitest run" },
  output: {
    toolName: "bash",
    success: true,
    durationMs: 2610,
    result: JSON.stringify({
      exit_code: 1,
      stdout: ` RUN  v1.6.0 /Users/dev/sdk-ts

 ✓ test/client.test.ts (18)
 ❯ test/streaming.test.ts (7)
   ✓ emits text deltas in order
   × keeps the final block when the turn ends in tool_use

 FAIL  test/streaming.test.ts > keeps the final block when the turn ends in tool_use
 AssertionError: expected length 1 to be 2

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 24 passed (25)
 1 failed, 24 passed in 2.6s`,
      stderr: "",
    }),
  },
});
ev({
  type: "todo_updated",
  items: [
    { content: "reproduce the drop with a fixture", status: "completed" },
    { content: "read the event loop in src/streaming.ts", status: "completed" },
    { content: "fix the exit condition", status: "in_progress" },
    { content: "add a regression test", status: "pending" },
  ],
});
ev({
  type: "tool_call_end",
  args: { command: "npx vitest run" },
  output: {
    toolName: "bash",
    success: true,
    durationMs: 2210,
    result: JSON.stringify({
      exit_code: 0,
      stdout: " Test Files  3 passed (3)\n      Tests  37 passed (37)\n 37 passed in 1.9s",
      stderr: "",
    }),
  },
});
ev({ type: "usage", outputTokens: 6100 });
ev({ type: "checkpoint_saved", runId: "r1", version: 2, turnCount: 1 });
ev({
  type: "text_delta",
  text: "The exit condition now flushes on exhaustion as well as on `message_stop`, so a turn that ends in `tool_use` keeps its final block.\n\nOne thing I could not verify: the fixture is hand-written, not captured from the API.",
});
renderer.finish();

say("");
const perm = renderPermissionCard("bash", "bash: rm -rf ~/.cache/acme-sdk && npm ci", COLS, {
  selected: 2,
  preview: {
    question: "Run this? It touches files outside the repo.",
    scope: "bash · host",
    detail: "rm -rf ~/.cache/acme-sdk && npm ci --prefer-offline",
    lines: [],
    added: 0,
    removed: 0,
    truncated: false,
    guard: "Nothing has run yet",
    choices: ["run it", "show me what would be deleted first", "skip, the cache is probably fine"],
    risk: [
      { label: "deletes", value: "1.2 GB outside the repo", tone: "warn" },
      { label: "cannot", value: "be undone", tone: "accent" },
    ],
  } as never,
});
say(perm.lines.join("\n"));

say("");
const composer = renderComposer({
  input: "",
  caret: 0,
  width: COLS,
  status: statusLine(
    { model: "claude-opus-5", workspace: ".", mode: "gear-1", contextPercent: 62 },
    COLS,
  ),
});
say(composer.lines.join("\n"));
say("");

// ─── The rest of the surfaces ───
// Transient states and overlays, so drift from the transcript's grammar is
// visible in one screen rather than discovered a week later in a real session.
const heading = (label: string) =>
  say(`\n\x1b[2m── ${label} ${"─".repeat(Math.max(3, 60 - label.length))}\x1b[0m`);

heading("rune shifted (shift+tab)");
say(permissionModeBanner("gear-4"));

heading("sandbox toggled");
say(sandboxModeBanner(false));

heading("waiting on a decision");
say(waitingRung(9, "bash", "gear-1"));

heading("provider rerouted mid-turn");
say(
  formatFallback({
    from: { provider: "anthropic", model: "claude-opus-5" },
    to: { provider: "openrouter", model: "qwen/qwen3-coder:free" },
    status: 429,
    reason: "rate limited",
    chain: ["anthropic", "openrouter", "ollama"],
  }),
);

heading("context compacted");
say(
  formatCompaction({
    beforeTokens: 82_000,
    afterTokens: 51_000,
    limitTokens: 100_000,
    summarizedCount: 14,
  }),
);

heading("/model");
say(
  renderPicker(
    "Model",
    [
      { label: "claude-opus-5", hint: "Anthropic · 1M context", current: true },
      { label: "gemini-2.5-flash", hint: "Google" },
      { label: "qwen3-coder", hint: "OpenRouter" },
    ],
    1,
    COLS,
  ).lines.join("\n"),
);

heading("/ palette");
say(
  renderSlashPalette(
    [
      { name: "/model", desc: "switch the model" },
      { name: "/gear", desc: "shift the autonomy gear" },
      { name: "/rewind", desc: "undo to a checkpoint" },
    ],
    0,
    COLS,
  ).join("\n"),
);

heading("/status");
say(
  renderStatus({
    model: "claude-opus-5",
    provider: "anthropic",
    workspace: "/Users/dev/acme/sdk-ts",
    sessionId: "0f3a91cc-aa",
    cost: 0.0412,
    version: "0.3.0",
    permissionMode: "gear-1",
    sandboxEnabled: true,
    contextUsage: { used: 62_000, limit: 200_000, percent: 31 },
  }),
);
say("");
