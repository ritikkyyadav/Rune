/**
 * P2 — a session's requests reach the provider with the session's cache key.
 *
 * The provider adapter keys its prompt cache on what the caller sends
 * (`StreamOpts.cacheKey`) and fell back to an id of its own when none came —
 * which was always: nothing passed one. That id changes whenever the gateway is
 * rebuilt and whenever the process is, so a warm cache was thrown away at every
 * `/model`, every `/login` and every resume.
 *
 * A real Engine and a provider that records what each request was sent WITH.
 * Held here: the key is the session's for the session's whole life — every
 * turn, a second message, a rebuilt provider, a second process on the same
 * database — and never another session's.
 *
 * What it is worth in tokens is not measured here. That needs the same model,
 * effort and inputs with the key and without it, against a live provider.
 *
 * Zero live model calls.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type {
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ProviderName,
  StreamEvent,
  StreamOpts,
} from "../../packages/llm-gateway/src/types";
import { Engine } from "../../packages/orchestrator/src/engine";
import { sessionCacheKey } from "../../packages/orchestrator/src/session-cache-key";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** Answers every request with one line, and remembers the key each one came with. */
class KeyRecorder implements LlmProvider {
  readonly name: ProviderName = "anthropic";
  readonly keys: Array<string | undefined> = [];
  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    return {
      id: "helper",
      model: request.model,
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async *inferStream(_request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    this.keys.push(opts?.cacheKey);
    yield { type: "message_start", messageId: "m" };
    yield { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text: "Done." } };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  }
  async countTokens(_messages: Message[]): Promise<number> {
    return 1;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function home(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "p2-ws-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const runeHome = mkdtempSync(join(tmpdir(), "p2-home-"));
  cleanup.push(() => rmSync(runeHome, { recursive: true, force: true }));
  const previous = process.env.RUNE_HOME;
  process.env.RUNE_HOME = runeHome;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previous;
  });
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  return { dir, dbPath: join(runeHome, "rune.db") };
}

/** An engine on `place`, and the recorder its requests go to. */
function engineOn(place: { dir: string; dbPath: string }) {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: place.dir,
    dbPath: place.dbPath,
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
  } as ConstructorParameters<typeof Engine>[0]);
  cleanup.push(() => engine.close());
  const recorder = new KeyRecorder();
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(recorder);
  return { engine, recorder };
}

async function say(engine: Engine, session: string, message: string): Promise<void> {
  for await (const _event of engine.chat(session, message)) {
    // drained
  }
}

describe("the key a session's requests carry", () => {
  test("is the session's, on every request of every message", async () => {
    const { engine, recorder } = engineOn(home());
    const session = engine.createSession();
    await say(engine, session, "Say hello.");
    await say(engine, session, "And again.");

    expect(recorder.keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(recorder.keys)).toEqual(new Set([sessionCacheKey(session)]));
  }, 60_000);

  test("is not another session's, in the same process", async () => {
    const { engine, recorder } = engineOn(home());
    const one = engine.createSession();
    const two = engine.createSession();
    await say(engine, one, "Say hello.");
    const first = [...recorder.keys];
    await say(engine, two, "Say hello.");
    const second = recorder.keys.slice(first.length);

    expect(new Set(first)).toEqual(new Set([sessionCacheKey(one)]));
    expect(new Set(second)).toEqual(new Set([sessionCacheKey(two)]));
    expect(sessionCacheKey(one)).not.toBe(sessionCacheKey(two));
  }, 60_000);

  test("does not move when the provider is rebuilt under the session", async () => {
    const { engine, recorder } = engineOn(home());
    const session = engine.createSession();
    await say(engine, session, "Say hello.");
    // What `/model` and `/login` do: a new provider instance, with a new id of its own.
    const rebuilt = new KeyRecorder();
    (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(rebuilt);
    await say(engine, session, "And again.");

    expect(rebuilt.keys.length).toBeGreaterThanOrEqual(1);
    expect(new Set([...recorder.keys, ...rebuilt.keys])).toEqual(
      new Set([sessionCacheKey(session)]),
    );
  }, 60_000);

  test("is the same in the process that resumes the session", async () => {
    const place = home();
    const before = engineOn(place);
    const session = before.engine.createSession();
    await say(before.engine, session, "Say hello.");
    before.engine.close();

    // Another engine on the same database: a resumed run, in a new process.
    const after = engineOn(place);
    await say(after.engine, session, "Continue.");

    expect(after.recorder.keys.length).toBeGreaterThanOrEqual(1);
    expect(new Set(after.recorder.keys)).toEqual(new Set(before.recorder.keys));
    expect(after.recorder.keys[0]).toBe(sessionCacheKey(session));
  }, 60_000);
});
