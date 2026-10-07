/**
 * Phase 5 — the frontend loop, end to end through the real AgentLoop with a
 * scripted provider. Zero model calls.
 *
 * F2: a frontend run with no browser mounted says so on the FIRST turn, as a
 * notice to the person and as a note to the model, and the read-back's `leave`
 * carries the same sentence.
 *
 * F5: the `form-states` fixture materialises, and the evaluator acceptance the
 * model never sees runs green against the hand-written solution — while the
 * browser criterion, which needs a real Chromium, is reported as a SKIP and
 * never as a pass.
 */

import { describe, expect, test, mock } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { materialise, runAcceptance } from "./fixtures/phase5/harness";
import { AgentLoop, type AgentTurnEvent } from "../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../packages/orchestrator/src/task-state";
import { briefFromArgs } from "../../packages/orchestrator/src/brief";
import { NO_BROWSER_PREFLIGHT } from "../../packages/orchestrator/src/visual-verification";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tools?: Array<{ name: string; args?: Record<string, unknown> }>; text?: string };

function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      if (t.tools && t.tools.length > 0) {
        for (let k = 0; k < t.tools.length; k++) {
          yield ev("tool_use_start", { toolCallId: `c${i}-${k}`, toolName: t.tools[k]!.name });
          yield ev("tool_use_stop", {
            toolCallId: `c${i}-${k}`,
            toolInput: t.tools[k]!.args ?? {},
          });
        }
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({
      content: [],
      model: "m",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as never;
}

/** A registry whose tool list either carries the browser MCP or does not. */
function makeRegistry(browser: boolean) {
  const names = ["write_file", "bash", "read_back", ...(browser ? ["mcp_browser_navigate"] : [])];
  return {
    toLlmTools: mock(() => []),
    list: mock(() => names.map((name) => ({ name }))),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: ["write_file"].includes(name) ? "write" : name === "bash" ? "execute" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    })),
  } as never;
}

function makeLoop(gateway: unknown, browser: boolean) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 6,
      systemPrompt: "s",
      taskState: new TaskStateStore(),
    } as never,
    gateway as never,
    makeRegistry(browser) as never,
  );
}

/**
 * Whether a mounted browser can launch is read from the machine: a Playwright
 * module, or a Chromium in Playwright's cache under the home directory. A
 * laptop that has run `playwright install` has one and a CI runner does not,
 * so "a browser is mounted" meant something different on each — and the two
 * tests that mount one passed on the first and failed on the second.
 *
 * This says which machine a test means. `true` names a Playwright through
 * `RUNE_TEST_PLAYWRIGHT`, which the probe takes at its word. `false` leaves
 * the probe nothing to find: no named module, and an empty home.
 */
async function withBrowserRuntime<T>(present: boolean, body: () => Promise<T>): Promise<T> {
  const names = [
    "RUNE_TEST_PLAYWRIGHT",
    "RUNE_BENCH_PLAYWRIGHT",
    "PLAYWRIGHT_BROWSERS_PATH",
    "HOME",
  ] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  const emptyHome = mkdtempSync(join(tmpdir(), "rune-no-browser-home-"));
  try {
    delete process.env.RUNE_BENCH_PLAYWRIGHT;
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (present) {
      process.env.RUNE_TEST_PLAYWRIGHT = import.meta.path;
    } else {
      delete process.env.RUNE_TEST_PLAYWRIGHT;
      process.env.HOME = emptyHome;
    }
    return await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(emptyHome, { recursive: true, force: true });
  }
}

describe("F2 — a run without a browser says so before it spends", () => {
  test("the limit is a first-turn notice and reaches the model before its first decision", async () => {
    const gw = makeGateway([{ text: "done" }]) as { inferStream: unknown };
    let firstRequest = "";
    const stream = gw.inferStream as (r: unknown) => AsyncGenerator<unknown>;
    gw.inferStream = async function* (request: unknown) {
      firstRequest ||= JSON.stringify(request);
      yield* stream(request);
    };
    const loop = makeLoop(gw, false);
    const events = await collect(loop.run("Build the settings screen", "noBrowser", "/tmp"));
    const notices = events.filter((e) => e.type === "notice") as Array<{ message: string }>;
    expect(notices.some((n) => n.message.includes(NO_BROWSER_PREFLIGHT))).toBe(true);
    // Before the first completion, not at the finish gate.
    expect(firstRequest).toContain(NO_BROWSER_PREFLIGHT);
    expect(firstRequest).toContain("`leave`");
  });

  test("a run WITH the browser mounted pays nothing for the pre-flight", async () => {
    await withBrowserRuntime(true, async () => {
      const loop = makeLoop(makeGateway([{ text: "done" }]), true);
      const events = await collect(loop.run("Build the settings screen", "withBrowser", "/tmp"));
      const notices = events.filter((e) => e.type === "notice") as Array<{ message: string }>;
      expect(notices.some((n) => n.message.includes(NO_BROWSER_PREFLIGHT))).toBe(false);
      expect(JSON.stringify(loop.getMessages())).not.toContain(NO_BROWSER_PREFLIGHT);
    });
  });

  test("a browser that is mounted but has nothing to launch is said too, with the reason", async () => {
    // What a CI runner is: the tools are registered, and there is no Chromium.
    await withBrowserRuntime(false, async () => {
      const loop = makeLoop(makeGateway([{ text: "done" }]), true);
      const events = await collect(loop.run("Build the settings screen", "noChromium", "/tmp"));
      const notices = events.filter((e) => e.type === "notice") as Array<{ message: string }>;
      const said = notices.find((n) => n.message.includes(NO_BROWSER_PREFLIGHT));
      expect(said).toBeDefined();
      expect(said!.message).toContain("no Chromium to launch");
    });
  });

  test("a backend run with no browser pays nothing either", async () => {
    const loop = makeLoop(makeGateway([{ text: "done" }]), false);
    const events = await collect(loop.run("Fix the CSV parser's quote handling", "be", "/tmp"));
    expect(
      (events.filter((e) => e.type === "notice") as Array<{ message: string }>).some((n) =>
        n.message.includes(NO_BROWSER_PREFLIGHT),
      ),
    ).toBe(false);
  });

  test("the read-back's leave list carries the limit, once", () => {
    const brief = briefFromArgs(
      { reading: "r", leave: ["the API layer"], done_when: ["it renders"] },
      "build a screen",
      "2026-09-15T00:00:00.000Z",
      { preflight: [NO_BROWSER_PREFLIGHT] },
    );
    expect(brief.leave).toEqual(["the API layer", NO_BROWSER_PREFLIGHT]);

    // The model wrote it itself: not duplicated.
    const already = briefFromArgs(
      { reading: "r", leave: [`Screenshots — ${NO_BROWSER_PREFLIGHT}.`], done_when: ["x"] },
      "build a screen",
      "2026-09-15T00:00:00.000Z",
      { preflight: [NO_BROWSER_PREFLIGHT] },
    );
    expect(already.leave).toHaveLength(1);

    // No pre-flight: byte-identical to what every existing caller gets.
    expect(briefFromArgs({ reading: "r", leave: ["x"], done_when: ["y"] }, "q", "t").leave).toEqual(
      ["x"],
    );
  });
});

// ─── F5 — the form fixture, and the acceptance the model never sees ───

const FIXTURES = join(import.meta.dir, "fixtures", "phase5");

describe("F5 — the form fixture", () => {
  const dir = join(FIXTURES, "form-states");

  test("is shaped the way the corpus lane expects, and hides its acceptance", () => {
    for (const file of ["task.json", "acceptance.json", "files", "solution"]) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
    const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf-8")) as {
      id: string;
      family: string;
      prompt: string;
    };
    expect(task.id).toBe("form-states");
    expect(task.family).toBe("frontend");
    expect(task.prompt.length).toBeGreaterThan(200);
    // The prompt never points at the file that grades it.
    expect(task.prompt).not.toContain("acceptance");
    // Every command addresses the tree by relative path.
    const raw = readFileSync(join(dir, "acceptance.json"), "utf-8");
    expect(raw).not.toContain("fixtures/phase5");
    expect(raw).not.toMatch(/"command":\s*"[^"]*\s\//);
  });

  test("the acceptance runs green against the hand-written solution", () => {
    const work = materialise(dir, "solution");
    try {
      const result = runAcceptance(work, join(dir, "acceptance.json"));
      expect(result.failed).toEqual([]);
      expect(result.passed.length).toBeGreaterThanOrEqual(8);
      if (process.env.RUNE_TEST_PLAYWRIGHT) {
        expect(result.skipped).toEqual([]);
        expect(result.passed).toContain("mobile-no-overflow");
      } else {
        // Reported as a skip. It is not a pass, and the count above excludes it.
        expect(result.skipped).toEqual(["mobile-no-overflow"]);
        expect(result.passed).not.toContain("mobile-no-overflow");
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("the acceptance is not vacuous: a form that stops announcing its errors goes red", () => {
    const work = materialise(dir, "solution");
    try {
      const app = join(work, "app.js");
      const broken = readFileSync(app, "utf-8").replace(/ role="alert"/g, "");
      expect(broken).not.toBe(readFileSync(app, "utf-8"));
      writeFileSync(app, broken);
      const result = runAcceptance(work, join(dir, "acceptance.json"));
      expect(result.failed).toContain("error-state");
      // And only that one: the mutation is narrow, so the rest still hold.
      expect(result.failed).toEqual(["error-state"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

// ─── F2, through the real Engine: the limit reaches the persisted brief ───
//
// The loop's notice and harness note are the person's and the model's copies
// of the limit. The brief's `leave` list is the DURABLE one — it survives a
// restart, it is what the contract carries forward as a constraint, and it is
// what a person reads back afterwards to see what the run knew it could not
// do. Everything below drives the real Engine with an in-process scripted
// provider under a scratch RUNE_HOME; `~/.rune` is never opened.

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { Engine } from "../../packages/orchestrator/src/engine";
import { UsageProvider } from "../helpers/usage-provider";

const engineCleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of engineCleanup.splice(0).reverse()) fn();
});

function toolsBinary(): string {
  const env = process.env.RUNE_TOOLS_BIN ?? process.env.RUNE_TOOLS_BINARY;
  if (env && existsSync(env)) return env;
  const bin = join(process.cwd(), "target", "debug", "rune-tools");
  if (!existsSync(bin)) throw new Error(`needs the native tools binary: ${bin}`);
  return bin;
}

function screenRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "f2-screen-"));
  engineCleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "f2-home-"));
  engineCleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  engineCleanup.push(() => {
    if (previous === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previous;
  });
  writeFileSync(join(dir, "index.html"), "<!doctype html>\n<title>settings</title>\n");
  const git = (args: string[]) => {
    const res = spawnSync(
      "git",
      [
        "-c",
        "user.name=F2",
        "-c",
        "user.email=f2@localhost",
        "-c",
        "commit.gpgSign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    );
    if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
  };
  git(["init", "--initial-branch=main"]);
  git(["add", "."]);
  git(["commit", "-m", "a screen to change"]);
  return dir;
}

function makeEngine(dir: string): Engine {
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
  } as ConstructorParameters<typeof Engine>[0]);
  engineCleanup.push(() => engine.close());
  return engine;
}

/**
 * Mount a browser the way a run with `--browser` has one: a tool whose name
 * starts `mcp_browser_`. `browserMounted()` reads the registry rather than the
 * config flag, so this is exactly the fact it is looking at.
 */
function mountBrowser(engine: Engine): void {
  (engine as unknown as { registry: { register: (h: unknown) => void } }).registry.register({
    schema: {
      name: "mcp_browser_navigate",
      version: "0.1.0",
      description: "navigate",
      inputSchema: { type: "object", properties: {} },
      category: "read",
      permissionLevel: "auto",
    },
    execute: async (input: { callId: string; toolName: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    }),
  });
}

async function runReadBack(engine: Engine, request: string): Promise<string> {
  const session = engine.createSession();
  const provider = new UsageProvider();
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  let seq = 0;
  provider.onRequest = (_request, index): ContentBlock[] =>
    index === 1
      ? [
          {
            type: "tool_use",
            toolCallId: `f2c${++seq}`,
            toolName: "read_back",
            toolInput: {
              reading: "you want the settings screen rebuilt",
              touch: ["index.html"],
              leave: ["the API layer"],
              done_when: ["index.html renders the new settings screen"],
            },
          },
        ]
      : [{ type: "text", text: "Read back; stopping here." }];
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(session, request)) events.push(event);
  expect(events.filter((e) => e.type === "error")).toEqual([]);
  return session;
}

const FRONTEND_REQUEST = "Redesign the settings screen in index.html";

describe("F2 through the real Engine — the pre-flight lands in the persisted brief", () => {
  test("no browser mounted: the sentence is in `leave`, and it survives to the session log", async () => {
    const dir = screenRepo();
    const engine = makeEngine(dir);
    const session = await runReadBack(engine, FRONTEND_REQUEST);

    const brief = engine.currentBrief();
    expect(brief).toBeDefined();
    // What the model wrote is kept; the runtime's limit is appended to it.
    expect(brief!.leave).toContain("the API layer");
    expect(brief!.leave).toContain(NO_BROWSER_PREFLIGHT);

    // Durable: the persisted `brief` event carries it, so a restart or an
    // audit reads the same boundary the run was working to.
    const sessions = (engine as unknown as { sessions: SessionManager }).sessions;
    const persisted = sessions
      .getEvents(session, 1)
      .filter((row) => row.event.type === "brief")
      .map((row) => JSON.stringify(row.event.payload));
    expect(persisted.length).toBeGreaterThanOrEqual(1);
    expect(persisted.at(-1)!).toContain(NO_BROWSER_PREFLIGHT);
  });

  test("a browser IS mounted: nothing is appended", async () => {
    await withBrowserRuntime(true, async () => {
      const dir = screenRepo();
      const engine = makeEngine(dir);
      mountBrowser(engine);
      await runReadBack(engine, FRONTEND_REQUEST);

      const brief = engine.currentBrief();
      expect(brief!.leave).toEqual(["the API layer"]);
      expect(JSON.stringify(brief)).not.toContain(NO_BROWSER_PREFLIGHT);
    });
  });

  test("a backend request with no browser: nothing is appended either", async () => {
    const dir = screenRepo();
    const engine = makeEngine(dir);
    await runReadBack(engine, "Fix the off-by-one in the CSV row counter");

    expect(engine.currentBrief()!.leave).toEqual(["the API layer"]);
  });
});
