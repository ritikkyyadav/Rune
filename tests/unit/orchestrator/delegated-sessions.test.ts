import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../packages/shared/src/session";
import { DelegatedSessions } from "../../../packages/orchestrator/src/delegated-sessions";
import { createSubagentTool } from "../../../packages/orchestrator/src/subagent";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import { UsageProvider } from "../../helpers/usage-provider";
import {
  CHECKPOINT_MAX_BYTES,
  compactCheckpointMessages,
} from "../../../packages/orchestrator/src/delegated-sessions";
import type { Message } from "../../../packages/llm-gateway/src/types";
const dirs: string[] = [];
afterEach(() => {
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});

test("a child retains findings across follow-up, process restart, and parent scoping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rune-child-"));
  dirs.push(dir);
  const path = join(dir, "sessions.db");
  let sessions = new SessionManager(path);
  const parent = sessions.createSession(dir, "claude-sonnet-5", "anthropic").id;
  const provider = new UsageProvider();
  provider.onRequest = () => [
    { type: "text", text: "The parser is in source/parser.ts; preserve escaped quotes." },
  ];
  const gateway = new LlmGateway({ providers: {}, defaultProvider: "anthropic", maxRetries: 0 });
  gateway.registerProvider(provider);
  const build = (model = "claude-sonnet-5") =>
    createSubagentTool({
      gateway,
      registry: new ToolRegistry(),
      model,
      provider: "anthropic",
      delegatedSessions: new DelegatedSessions(sessions),
    });
  const input = {
    toolName: "task",
    callId: "first",
    workspaceRoot: dir,
    sessionId: parent,
    args: { prompt: "Locate the parser" },
  };
  const first = await build().execute(input);
  expect(first.success).toBe(true);
  const id = first.structured?.task_id as string;
  expect(id).toMatch(/^task_/);
  sessions.close();
  sessions = new SessionManager(path);
  const second = await build().execute({
    ...input,
    callId: "follow",
    args: { prompt: "What constraint did you find?", task_id: id },
  });
  expect(second.success).toBe(true);
  expect(second.structured?.task_id).toBe(id);
  expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain("preserve escaped quotes");
  const count = provider.requests.length;
  expect(
    (
      await build().execute({
        ...input,
        sessionId: "different",
        args: { prompt: "Continue", task_id: id },
      })
    ).success,
  ).toBe(false);
  expect(
    (
      await build("claude-haiku-4-5").execute({
        ...input,
        args: { prompt: "Continue", task_id: id },
      })
    ).error,
  ).toContain("Resume with that model");
  expect(provider.requests).toHaveLength(count);
  sessions.close();
});

test("a delegated session cannot run overlapping follow-ups and releases its lease", () => {
  const store = new DelegatedSessions();
  const release = store.claim("parent", "child");
  expect(() => store.claim("parent", "child")).toThrow("already running");
  release();
  expect(() => store.claim("parent", "child")()).not.toThrow();
});

test("a resume checkpoint is bounded: results trimmed, exchanges dropped whole, prompt and final report kept", () => {
  const big = "x".repeat(40_000);
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Locate the parser" }] },
  ];
  for (let i = 0; i < 12; i++) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          toolCallId: `call-${i}`,
          toolName: "read_file",
          toolInput: { path: `f${i}.ts` },
        },
      ],
    });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", toolCallId: `call-${i}`, toolResultContent: big },
        { type: "image", mediaType: "image/png", data: big },
      ],
    });
  }
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: "The parser is in source/parser.ts." }],
  });
  const pairsHold = (list: Message[]) => {
    for (const [i, m] of list.entries())
      for (const b of m.content)
        if (b.type === "tool_result") {
          const prev = list[i - 1]!;
          expect(prev.role).toBe("assistant");
          expect(
            prev.content.some((p) => p.type === "tool_use" && p.toolCallId === b.toolCallId),
          ).toBe(true);
        }
  };
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(CHECKPOINT_MAX_BYTES);
  const compact = compactCheckpointMessages(messages);
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(CHECKPOINT_MAX_BYTES);
  expect(compact).toHaveLength(messages.length);
  expect(compact[0]).toEqual(messages[0]);
  expect(compact.at(-1)).toEqual(messages.at(-1));
  expect(JSON.stringify(compact)).not.toContain("image/png");
  expect(JSON.stringify(compact)).toContain("omitted from the resume checkpoint");
  pairsHold(compact);
  const tight = compactCheckpointMessages(messages, 8_000);
  expect(tight.length).toBeLessThan(compact.length);
  expect(tight[0]).toEqual(messages[0]);
  expect(tight.at(-1)).toEqual(messages.at(-1));
  expect(JSON.stringify(tight)).toMatch(/earlier exchanges? omitted/);
  pairsHold(tight);
  // The original is never mutated.
  expect(messages[1]!.content[0]).toMatchObject({ type: "tool_use" });
  expect((messages[2]!.content[0] as { toolResultContent: string }).toolResultContent).toHaveLength(
    40_000,
  );
});
