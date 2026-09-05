/**
 * `rune acp`, driven by the Agent Client Protocol project's OWN client.
 *
 * `acp.test.ts` beside this file speaks JSON-RPC by hand. That test is worth
 * keeping — it asserts Rune-specific policy (a cancelled dialog is a deny) that
 * no third-party client knows to check — but it can only prove Rune is
 * consistent with the shapes the test author believed in. A mapping that is
 * wrong in the same way in both places passes it.
 *
 * This file removes that circularity. `@agentclientprotocol/sdk` is the
 * reference TypeScript implementation published by the ACP project
 * (github.com/agentclientprotocol/typescript-sdk, Apache-2.0). Its client
 * parses every inbound frame through the schema generated from the protocol's
 * own JSON Schema: a `session/update` whose shape Rune invented is a zod
 * failure here, not a silently-rendered blob. Running it against `rune acp` is
 * the difference between "our test agrees with our agent" and "the protocol's
 * client can drive it".
 *
 * What it walks: `initialize` → `session/new` → `session/prompt` → a
 * `session/request_permission` it answers → the prompt's `stopReason`; then
 * `session/cancel` mid-turn; then two sessions on one server, which is the case
 * an editor with two tabs open produces on the first afternoon.
 *
 * Everything is real except the model.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const repoRoot = join(import.meta.dir, "../..");
const CLI = join(repoRoot, "packages", "orchestrator", "src", "bin", "rune-cli.ts");
const RUST_BIN =
  process.env.RUNE_TOOLS_BIN ??
  [
    join(repoRoot, "target", "release", "rune-tools"),
    join(repoRoot, "target", "debug", "rune-tools"),
    join(process.env.HOME ?? "", ".rune", "bin", "rune-tools"),
  ].find((p) => existsSync(p)) ??
  "";
const HAS_RUST_BIN = RUST_BIN !== "" && existsSync(RUST_BIN);

// ─── The fake model ───

const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
const sseText = (text: string): string =>
  chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
const sseToolCall = (id: string, name: string, args: Record<string, unknown>): string =>
  chunk(
    {
      role: "assistant",
      tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
    },
    null,
  ) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, null) +
  chunk({}, "tool_calls") +
  "data: [DONE]\n\n";

// ─── The agent under test, as a subprocess ───

interface Agent {
  proc: ChildProcessWithoutNullStreams;
  stream: acp.Stream;
  stderr: () => string;
}

describe("rune acp — conformance against the ACP reference client", () => {
  let dir: string;
  let runeHome: string;
  let model: ReturnType<typeof Bun.serve> | null = null;
  let agent: Agent | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-acp-conf-"));
    runeHome = join(dir, "home");
    mkdirSync(runeHome, { recursive: true });
  });

  afterEach(async () => {
    // SIGTERM and wait: `rune acp` stops its per-session engine hosts in its
    // signal handler, and killing it outright strands one host per test for the
    // rest of the suite. `zz-no-leaked-hosts.test.ts` is the assertion.
    const proc = agent?.proc;
    agent = null;
    if (proc && proc.exitCode === null) {
      const settled = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      proc.kill("SIGTERM");
      const hard = setTimeout(() => proc.kill("SIGKILL"), 10_000);
      await settled;
      clearTimeout(hard);
    }
    model?.stop(true);
    model = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function start(script: string[]): Agent {
    let turn = 0;
    model = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        await req.text();
        return new Response(script[Math.min(turn++, script.length - 1)]!, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    writeFileSync(
      join(runeHome, "model.json"),
      JSON.stringify({ provider: "custom", model: "fake-model" }),
    );
    writeFileSync(
      join(runeHome, "secrets.json"),
      JSON.stringify({
        custom: {
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
          model: "fake-model",
          key: "fake-key-the-test-server-ignores",
        },
      }),
      { mode: 0o600 },
    );

    const proc = spawn("bun", [CLI, "acp", "--workspace", dir], {
      cwd: dir,
      env: {
        ...process.env,
        RUNE_HOME: runeHome,
        RUNE_WORKSPACE: dir,
        RUNE_DB_PATH: join(dir, "rune.db"),
        RUNE_TOOLS_BIN: RUST_BIN,
        RUNE_ROUNDTRIP_TIMEOUT_MS: "120000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let err = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c: string) => {
      err += c;
    });

    agent = {
      proc,
      // `ndJsonStream` is the reference client's own stdio framing. Using it
      // rather than splitting lines by hand means the newline discipline
      // `rune acp` promises is checked by the protocol's implementation of it.
      stream: acp.ndJsonStream(
        Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
      ),
      stderr: () => err,
    };
    return agent;
  }

  test.skipIf(!HAS_RUST_BIN)(
    "initialize → session/new → session/prompt → permission → stopReason",
    async () => {
      const under = start([
        sseToolCall("call_todo", "todo_write", {
          items: [
            { content: "check the shell works", status: "in_progress" },
            { content: "report back", status: "pending" },
          ],
        }),
        sseToolCall("call_bash", "bash", { command: "echo hello-from-the-reference-client" }),
        sseText("Done — the shell answered."),
      ]);

      const asked: Array<{ title: string; options: string[] }> = [];
      const updates: acp.schema.SessionUpdate[] = [];

      const stopReason = await acp
        .client({ name: "acp-conformance-test" })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
          const params = ctx.params;
          asked.push({
            title: params.toolCall.title ?? "",
            options: params.options.map((o) => o.optionId),
          });
          const allow = params.options.find((o) => o.kind === "allow_once");
          return {
            outcome: allow
              ? { outcome: "selected" as const, optionId: allow.optionId }
              : { outcome: "cancelled" as const },
          };
        })
        .connectWith(under.stream, async (ctx) => {
          const init = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          });
          // The reference client validated this against the protocol's schema
          // on the way in; asserting the version is asserting we negotiated the
          // one it speaks, not merely that a number came back.
          expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
          expect(init.agentCapabilities?.loadSession).toBe(false);
          // Rune holds its own provider credentials (`rune login`), so there is
          // nothing for an editor to authenticate and it says so.
          expect(init.authMethods).toEqual([]);

          return await ctx.buildSession(dir).withSession(async (session) => {
            expect(session.sessionId.length).toBeGreaterThan(0);
            void session.prompt("check the shell works");
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") return message.stopReason;
              updates.push(message.update);
            }
          });
        });

      expect(stopReason, under.stderr()).toBe("end_turn");

      // ── the permission round-trip, from the client's side ──
      expect(asked.length).toBeGreaterThan(0);
      expect(asked[0]!.title).toContain("hello-from-the-reference-client");
      expect(asked[0]!.options).toContain("allow_once");
      expect(asked[0]!.options).toContain("deny");

      // ── what the editor was given ──
      const kinds = updates.map((u) => u.sessionUpdate);
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_call_update");
      expect(kinds).toContain("agent_message_chunk");

      const kindOf = (toolCallId: string): string | undefined =>
        (
          updates.find(
            (u) =>
              u.sessionUpdate === "tool_call" &&
              (u as { toolCallId?: string }).toolCallId === toolCallId,
          ) as { kind?: string } | undefined
        )?.kind;
      // A `kind` is what lets an editor draw a shell command as a shell command
      // rather than as one more anonymous "other"…
      expect(kindOf("call_bash")).toBe("execute");
      // …and it is why the ordering in `toolKind` matters: `todo_write`
      // contains "write" and is a plan update, not a file edit.
      expect(kindOf("call_todo")).toBe("think");

      const completed = updates.find(
        (u) =>
          u.sessionUpdate === "tool_call_update" &&
          (u as { toolCallId?: string }).toolCallId === "call_bash",
      ) as { status?: string; content?: Array<{ type: string; content?: { text?: string } }> };
      expect(completed.status).toBe("completed");
      // The reference client's schema drops array members it cannot parse
      // (`vecSkipError`) rather than failing the notification, so an empty
      // `content` here is how a WRONG tool-result shape would present. Asserting
      // the block survived is asserting Rune's shape is the protocol's.
      expect(completed.content?.length ?? 0).toBeGreaterThan(0);
      expect(completed.content?.[0]?.type).toBe("content");
      expect(completed.content?.[0]?.content?.text).toContain("hello-from-the-reference-client");

      // `todo_updated` → `plan`, with entries the protocol's schema accepts.
      // A `status` or `priority` Rune invented would be dropped by the same
      // `vecSkipError` and leave this list empty.
      const plan = updates.find((u) => u.sessionUpdate === "plan") as {
        entries?: Array<{ content: string; status: string; priority: string }>;
      };
      expect(plan?.entries?.length).toBe(2);
      expect(plan!.entries![0]!.status).toBe("in_progress");
      expect(plan!.entries![1]!.status).toBe("pending");

      const text = updates
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => {
          const content = (u as { content?: { type?: string; text?: string } }).content;
          return content?.type === "text" ? (content.text ?? "") : "";
        })
        .join("");
      expect(text).toContain("the shell answered");
    },
    240_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "session/cancel stops the turn and the prompt answers `cancelled`",
    async () => {
      // The model asks for a command; the client cancels instead of answering
      // the permission. ACP's rule is that a cancelled turn still answers its
      // `session/prompt` — with `cancelled` — rather than leaving the editor
      // holding a request forever.
      const under = start([
        sseToolCall("call_bash", "bash", { command: "sleep 600" }),
        sseText("unreachable"),
      ]);

      const outcome = await acp
        .client({ name: "acp-conformance-cancel" })
        .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
          // Cancel WHILE the agent is waiting on us — the real shape of a
          // person closing the panel with a dialog open.
          await ctx.agent.notify(acp.methods.agent.session.cancel, {
            sessionId: ctx.params.sessionId,
          });
          return { outcome: { outcome: "cancelled" as const } };
        })
        .connectWith(under.stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          return await ctx.buildSession(dir).withSession(async (session) => {
            void session.prompt("run something long");
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") return message.stopReason;
            }
          });
        });

      expect(outcome, under.stderr()).toBe("cancelled");
    },
    240_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "two sessions on one agent process stay separate",
    async () => {
      // An editor with two tabs open is one `rune acp` process and two
      // sessions. Each gets its own engine host, and an update for one must
      // never be delivered against the other's id — which is exactly what the
      // reference client's per-session update routing would catch.
      const under = start([sseText("first"), sseText("second")]);

      const result = await acp
        .client({ name: "acp-conformance-two-sessions" })
        .connectWith(under.stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });

          const a = await ctx.buildSession(dir).start();
          const b = await ctx.buildSession(dir).start();
          try {
            const textOf = async (session: acp.ActiveSession): Promise<string> => {
              let text = "";
              void session.prompt("say something");
              for (;;) {
                const message = await session.nextUpdate();
                if (message.kind === "stop") return text;
                if (message.update.sessionUpdate !== "agent_message_chunk") continue;
                // The notification's own sessionId is the routing claim being
                // checked: `nextUpdate` only yields frames addressed to THIS
                // session, so a mis-addressed one would hang here, not leak.
                expect(message.notification.sessionId).toBe(session.sessionId);
                const content = message.update.content;
                if (content.type === "text") text += content.text;
              }
            };

            const first = await textOf(a);
            const second = await textOf(b);
            return { ids: [a.sessionId, b.sessionId], first, second };
          } finally {
            a.dispose();
            b.dispose();
          }
        });

      expect(result.ids[0]).not.toBe(result.ids[1]);
      expect(result.first, under.stderr()).toBe("first");
      expect(result.second, under.stderr()).toBe("second");
    },
    240_000,
  );
});
