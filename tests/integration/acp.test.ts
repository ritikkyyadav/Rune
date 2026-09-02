/**
 * `gear acp`, driven by an ACP client.
 *
 * This is the gate for P5.1, and it has to be, because the real client is Zed
 * and Zed cannot be run here. So the harness IS the client: it spawns the
 * agent, speaks JSON-RPC over its stdio, and walks the whole path —
 * `initialize` → `session/new` → `session/prompt` → a permission request it
 * answers → completion.
 *
 * The permission round-trip is the part worth testing. Streaming text to an
 * editor is easy; an editor that cannot answer a permission would have to run
 * Gear in 4th gear to get anything done, which is the opposite of what an
 * editor integration is for.
 *
 * Everything is real except the model: the supervisor, the spawned engine host,
 * the permission broker, the session store and the protocol are shipping code.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const CLI = join(repoRoot, "packages", "orchestrator", "src", "bin", "gear-cli.ts");
const RUST_BIN =
  process.env.GEAR_TOOLS_BIN ??
  [
    join(repoRoot, "target", "release", "gear-tools"),
    join(repoRoot, "target", "debug", "gear-tools"),
    join(process.env.HOME ?? "", ".gear", "bin", "gear-tools"),
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

// ─── An ACP client ───

interface Frame {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * The editor's half of the conversation.
 *
 * Deliberately hand-written against the ACP shapes rather than built on a Gear
 * type: a test that shares its types with the thing under test cannot catch the
 * mapping being wrong, only inconsistent.
 */
class AcpClient {
  readonly updates: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
  readonly permissionAsks: Array<Record<string, unknown>> = [];
  /** How to answer the next `session/request_permission`, by option id. */
  answerWith: string | null = "allow_once";
  readonly stderr: string[] = [];

  private nextId = 1;
  private readonly pending = new Map<number, (f: Frame) => void>();
  private buffer = "";

  private constructor(private readonly proc: ReturnType<typeof Bun.spawn>) {}

  static start(env: Record<string, string>, cwd: string): AcpClient {
    const proc = Bun.spawn(["bun", CLI, "acp", "--workspace", cwd], {
      env: { ...process.env, ...env },
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const client = new AcpClient(proc);
    void client.pump();
    void client.pumpErr();
    return client;
  }

  private async pump(): Promise<void> {
    for await (const chunkBytes of this.proc.stdout as ReadableStream<Uint8Array>) {
      this.buffer += new TextDecoder().decode(chunkBytes);
      let at: number;
      while ((at = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, at).trim();
        this.buffer = this.buffer.slice(at + 1);
        if (line) this.onFrame(line);
      }
    }
  }

  private async pumpErr(): Promise<void> {
    for await (const chunkBytes of this.proc.stderr as ReadableStream<Uint8Array>) {
      this.stderr.push(new TextDecoder().decode(chunkBytes));
    }
  }

  private onFrame(line: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(line) as Frame;
    } catch {
      this.stderr.push(`[client] unparseable frame: ${line}`);
      return;
    }

    if (frame.method === "session/update") {
      const p = (frame.params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
      this.updates.push({ sessionId: String(p.sessionId), update: p.update ?? {} });
      return;
    }

    if (frame.method === "session/request_permission") {
      this.permissionAsks.push(frame.params ?? {});
      const outcome =
        this.answerWith === null
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId: this.answerWith };
      this.write({ jsonrpc: "2.0", id: frame.id, result: { outcome } });
      return;
    }

    if (typeof frame.id === "number") {
      const settle = this.pending.get(frame.id);
      if (settle) {
        this.pending.delete(frame.id);
        settle(frame);
      }
    }
  }

  private write(frame: Frame): void {
    (this.proc.stdin as { write(s: string): void }).write(`${JSON.stringify(frame)}\n`);
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<Frame> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `no answer to ${method} in ${timeoutMs}ms; agent stderr:\n${this.stderr.join("")}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, (f) => {
        clearTimeout(timer);
        resolve(f);
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Every chunk of a kind, joined — the text an editor would have rendered. */
  textOf(kind: string): string {
    return this.updates
      .filter((u) => u.update.sessionUpdate === kind)
      .map((u) => {
        const content = u.update.content as { text?: string } | undefined;
        return content?.text ?? "";
      })
      .join("");
  }

  async waitFor(match: (u: Record<string, unknown>) => boolean, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.updates.some((u) => match(u.update))) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(
      `timed out; saw: ${this.updates.map((u) => u.update.sessionUpdate).join(", ") || "(nothing)"}`,
    );
  }

  /**
   * SIGTERM and WAIT.
   *
   * `gear acp` runs one `engine-host` process per session and stops them in its
   * signal handler (P10.0). Killing it without waiting — what this used to do —
   * left one engine per ACP test running for the rest of the suite;
   * `zz-no-leaked-hosts.test.ts` is the assertion that it no longer does.
   */
  async stop(graceMs = 10_000): Promise<void> {
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, graceMs);
    await this.proc.exited.catch(() => {});
    clearTimeout(timer);
  }
}

// ─── The fixture ───

describe("gear acp (an ACP client, a real engine, a fake model)", () => {
  let dir: string;
  let gearHome: string;
  let model: ReturnType<typeof Bun.serve> | null = null;
  let client: AcpClient | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gear-acp-"));
    gearHome = join(dir, "home");
    mkdirSync(gearHome, { recursive: true });
  });

  afterEach(async () => {
    await client?.stop();
    client = null;
    model?.stop(true);
    model = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function start(script: string[]): AcpClient {
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
      join(gearHome, "model.json"),
      JSON.stringify({ provider: "custom", model: "fake-model" }),
    );
    writeFileSync(
      join(gearHome, "secrets.json"),
      JSON.stringify({
        custom: {
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
          model: "fake-model",
          key: "fake-key-the-test-server-ignores",
        },
      }),
      { mode: 0o600 },
    );

    client = AcpClient.start(
      {
        GEAR_HOME: gearHome,
        GEAR_WORKSPACE: dir,
        GEAR_DB_PATH: join(dir, "gear.db"),
        GEAR_TOOLS_BIN: RUST_BIN,
        GEAR_ROUNDTRIP_TIMEOUT_MS: "120000",
      },
      dir,
    );
    return client;
  }

  test.skipIf(!HAS_RUST_BIN)(
    "initialize → new session → prompt → permission → completion",
    async () => {
      const acp = start([
        sseToolCall("call_bash", "bash", { command: "echo hello-from-the-editor" }),
        sseText("Done — the shell answered."),
      ]);

      // ── initialize ──
      const init = await acp.call("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      expect(init.error, JSON.stringify(init.error)).toBeUndefined();
      expect(init.result?.protocolVersion).toBe(1);
      // Capabilities are a promise to the client; `loadSession` is declared
      // false rather than half-implemented.
      const caps = init.result?.agentCapabilities as { loadSession?: boolean };
      expect(caps.loadSession).toBe(false);

      // ── a session ──
      const created = await acp.call("session/new", { cwd: dir, mcpServers: [] });
      const sessionId = String(created.result?.sessionId ?? "");
      expect(sessionId.length).toBeGreaterThan(0);

      // ── the turn ──
      acp.answerWith = "allow_once";
      const prompt = acp.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "check the shell works" }],
      });

      // The tool call reaches the editor as a `tool_call` update…
      await acp.waitFor((u) => u.sessionUpdate === "tool_call");
      const toolCall = acp.updates.find((u) => u.update.sessionUpdate === "tool_call")!.update;
      expect(toolCall.title).toBe("bash");
      // …with a kind, so an editor can show it as a shell command rather than
      // as one more anonymous "other".
      expect(toolCall.kind).toBe("execute");

      // ── the permission, answered by the editor ──
      const done = await prompt;
      expect(done.error, JSON.stringify(done.error)).toBeUndefined();
      expect(done.result?.stopReason).toBe("end_turn");

      expect(acp.permissionAsks.length).toBeGreaterThan(0);
      const ask = acp.permissionAsks[0] as {
        sessionId: string;
        toolCall: { title: string };
        options: Array<{ optionId: string; kind: string }>;
      };
      expect(ask.sessionId).toBe(sessionId);
      expect(ask.toolCall.title).toContain("hello-from-the-editor");
      expect(ask.options.map((o) => o.optionId)).toContain("allow_once");
      expect(ask.options.map((o) => o.optionId)).toContain("deny");

      // ── what the editor rendered ──
      expect(acp.textOf("agent_message_chunk")).toContain("the shell answered");
      const updated = acp.updates.find((u) => u.update.sessionUpdate === "tool_call_update");
      expect(updated?.update.status).toBe("completed");
    },
    240_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "a cancelled permission dialog is a deny, not a silence",
    async () => {
      // A closed dialog must not read as consent. The tool is refused and the
      // turn still completes, because that is what a denial does.
      const acp = start([
        sseToolCall("call_bash", "bash", { command: "rm -rf /tmp/whatever" }),
        sseText("Refused; stopping."),
      ]);

      await acp.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = await acp.call("session/new", { cwd: dir, mcpServers: [] });
      const sessionId = String(created.result?.sessionId ?? "");

      acp.answerWith = null; // the editor cancels
      const done = await acp.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "tidy up" }],
      });

      expect(done.result?.stopReason).toBe("end_turn");
      expect(acp.permissionAsks.length).toBeGreaterThan(0);
      const failed = acp.updates.filter(
        (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "failed",
      );
      expect(failed.length).toBeGreaterThan(0);
    },
    240_000,
  );
});
