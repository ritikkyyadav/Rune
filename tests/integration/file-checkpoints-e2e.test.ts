/**
 * File checkpoints through the REAL Engine (R5.1 of
 * docs/program/rune-reliability-plan-20261014.md): a scripted model writes
 * files through the real permission check and the real native tools over two
 * turns, and `rewindCode` puts them back to how each turn found them — the
 * file that existed restored, the file a turn created removed.
 *
 * Offline: the model is the UsageProvider helper, answering in order.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { Engine } from "../../packages/orchestrator/src/engine";
import { UsageProvider } from "../helpers/usage-provider";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function toolsBinary(): string {
  const env = process.env.RUNE_TOOLS_BIN ?? process.env.RUNE_TOOLS_BINARY;
  if (env && existsSync(env)) return env;
  const bin = join(process.cwd(), "target", "debug", "rune-tools");
  if (!existsSync(bin)) throw new Error(`needs the native tools binary: ${bin}`);
  return bin;
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "rune-fc-ws-"));
  const home = mkdtempSync(join(tmpdir(), "rune-fc-home-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previous;
  });
  return dir;
}

function makeEngine(dir: string, over: Record<string, unknown> = {}): Engine {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(process.env.RUNE_HOME!, "rune.db"),
    toolsBinaryPath: toolsBinary(),
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
    ...over,
  } as ConstructorParameters<typeof Engine>[0]);
  cleanup.push(() => engine.close());
  return engine;
}

let callSeq = 0;
const tool = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `fc${++callSeq}`,
  toolName: name,
  toolInput: args,
});

/** The last thing the person typed in a request, skipping the harness's own notes. */
function personSaid(request: unknown): string {
  const messages =
    (request as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const texts =
      typeof m.content === "string"
        ? [m.content]
        : (m.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text!);
    const said = texts.find((t) => !t.trimStart().startsWith("["));
    if (said) return said;
  }
  return "";
}

/**
 * A model that answers each message the person sent with its scripted calls
 * once, and with plain text on every later request in that turn — so a gate
 * asking the model again inside a turn cannot pull the next turn's calls in.
 */
function script(engine: Engine, byMessage: Record<string, ContentBlock[]>): void {
  const provider = new UsageProvider();
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  const answered = new Set<string>();
  provider.onRequest = (r) => {
    const said = personSaid(r);
    const calls = byMessage[said];
    if (calls && !answered.has(said)) {
      answered.add(said);
      return calls;
    }
    return [{ type: "text", text: "Done." }];
  };
}

async function drain(engine: Engine, sessionId: string, message: string): Promise<void> {
  for await (const _ of engine.chat(sessionId, message)) {
    // drain
  }
}

describe("file checkpoints, end to end", () => {
  test("two turns of writes, put back one turn at a time", async () => {
    const dir = workspace();
    writeFileSync(join(dir, "a.txt"), "original\n");
    const engine = makeEngine(dir);
    script(engine, {
      "change a.txt": [tool("write_file", { path: "a.txt", content: "v1\n" })],
      "change it again and add b.txt": [
        tool("write_file", { path: "a.txt", content: "v2\n" }),
        tool("write_file", { path: "b.txt", content: "new\n" }),
      ],
    });
    const session = engine.createSession();
    await drain(engine, session, "change a.txt");
    await drain(engine, session, "change it again and add b.txt");

    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v2\n");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("new\n");

    const turns = engine.listUserTurns(session);
    expect(turns).toHaveLength(2);
    const byTurn = engine.fileChangesByTurn(session);
    expect(byTurn.get(turns[0]!.seq)).toEqual([join(dir, "a.txt")]);
    expect(byTurn.get(turns[1]!.seq)?.sort()).toEqual([join(dir, "a.txt"), join(dir, "b.txt")]);

    // Back to how turn 2 found the files: a.txt as turn 1 left it, no b.txt.
    const second = engine.rewindCode(session, turns[1]!.seq);
    expect(second.restored).toEqual([join(dir, "a.txt")]);
    expect(second.deleted).toEqual([join(dir, "b.txt")]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);

    // Back to how turn 1 found them: the original.
    engine.rewindCode(session, turns[0]!.seq);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("original\n");

    // Rewinding the conversation past both turns forgets their snapshots.
    engine.rewindTo(session, turns[0]!.seq - 1);
    expect(engine.fileChangesByTurn(session).size).toBe(0);
  });

  test("a write the permission check refuses leaves no snapshot", async () => {
    const dir = workspace();
    // Manual mode with nobody to ask: every write is refused.
    const engine = makeEngine(dir, { permissionMode: "manual" });
    script(engine, {
      "write a.txt": [tool("write_file", { path: "a.txt", content: "should not land\n" })],
    });
    const session = engine.createSession();
    await drain(engine, session, "write a.txt");
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
    expect(engine.fileChangesByTurn(session).size).toBe(0);
  });
});
