// ─── Fresh machine → first answer ───
//
// P12.4's acceptance is "fresh machine to first task in under three minutes",
// and nothing measured it. The interactive path is a TUI (login picker → model
// choice → composer), which a test cannot drive; this is its headless
// equivalent, walked end to end against a completely empty home:
//
//   1. an empty RUNE_HOME — no config, no credential index, no database
//   2. `rune doctor` runs and says the machine is clean, not broken
//   3. the login picker's own data: the free routes are the top rows, marked
//   4. connect a route, the way the picker's last step writes it
//   5. choose a model (`rune use`), the way the picker's model step writes it
//   6. the first prompt, headless, and an answer comes back
//   7. `rune doctor` afterwards reports the route as configured
//
// The model on the other end is a local stub speaking the OpenAI wire, which is
// the `custom` provider — the same route `/login → Offline → Other local
// server` configures. That keeps this test free, offline and deterministic
// while still exercising the real CLI, the real config writer and the real
// engine.
//
// The elapsed wall time is printed and asserted, because the deliverable is a
// duration, not a boolean.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loginTargets,
  routeChoices,
  isFreeRoute,
} from "../../packages/orchestrator/src/bin/ui/login-picker";

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

/**
 * A budget, not a benchmark. Three minutes is the phase's acceptance; the
 * ceiling here is generous enough that a slow CI box does not fail the build
 * and tight enough that a path which has started hanging does.
 */
const BUDGET_MS = 180_000;

let dir: string;
let runeHome: string;
let workspace: string;
let model: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-fresh-home-"));
  runeHome = join(dir, "home", ".rune");
  workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  model?.stop(true);
  model = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** One SSE completion, the shape an OpenAI-compatible host streams. */
function sse(text: string): string {
  const frame = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "cmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "fresh-home-stub",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return frame({ role: "assistant" }, null) + frame({ content: text }, null) + frame({}, "stop");
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME: join(dir, "home"),
    RUNE_HOME: runeHome,
    RUNE_WORKSPACE: workspace,
    RUNE_DB_PATH: join(runeHome, "rune.db"),
    NO_COLOR: "1",
    TERM: "dumb",
    // A fresh machine has none of these. Inheriting the developer's would make
    // the test pass for the wrong reason.
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    OPENROUTER_API_KEY: "",
    GOOGLE_API_KEY: "",
    ...(HAS_RUST_BIN ? { RUNE_TOOLS_BIN: RUST_BIN } : {}),
    ...extra,
  };
}

async function rune(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", CLI, ...args], {
    cwd: workspace,
    env: env(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

describe("a fresh machine reaches its first answer", () => {
  test("the login picker offers the free routes first, and marks them", () => {
    // Step 3, and the only one that is pure data. It runs even without the
    // native executor, because it is the step a new user actually sees first.
    const api = loginTargets("api_key").map((t) => t.providerId);
    expect(api.length).toBeGreaterThan(20);
    expect(isFreeRoute(api[0]!)).toBe(true);
    // Every free route sorts above every paid one.
    const lastFree = api.map(isFreeRoute).lastIndexOf(true);
    const firstPaid = api.map(isFreeRoute).indexOf(false);
    expect(lastFree).toBeLessThan(firstPaid);

    const openrouter = loginTargets("api_key").find((t) => t.providerId === "openrouter");
    expect(openrouter?.label.toLowerCase()).toContain("free");

    // And level 1 says so before you have chosen anything.
    const apiRoute = routeChoices().find((r) => r.id === "api_key");
    expect(apiRoute?.hint).toContain("free");
    expect(routeChoices().find((r) => r.id === "offline")?.hint).toContain("free");
  });

  test.skipIf(!HAS_RUST_BIN)(
    "empty home → doctor → connect → model → first prompt, inside the budget",
    async () => {
      const started = Date.now();
      const mark: [string, number][] = [];
      const lap = (label: string) => mark.push([label, Date.now() - started]);

      // ── 1. Nothing exists yet.
      expect(existsSync(runeHome)).toBe(false);

      // ── 2. Doctor on an empty machine: clean, and it says so.
      const d1 = await rune(["doctor"]);
      expect(d1.code).toBe(0);
      expect(d1.out).toContain("RUNE DOCTOR");
      expect(d1.out).toContain("no cap or retirement recorded");
      lap("doctor (empty home)");

      // Doctor must not have gone looking in the real home.
      expect(existsSync(runeHome)).toBe(true);
      expect(readdirSync(runeHome).some((f) => f.includes("secrets"))).toBe(false);

      // ── 4. Connect a route. This is what the picker's last step writes for
      // `Offline → Other local server`: a base URL and a model, no OAuth.
      model = Bun.serve({
        port: 0,
        fetch: async (req) => {
          if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
            return new Response("not found", { status: 404 });
          }
          await req.text();
          return new Response(sse("Hello from the fresh-home stub. Nothing to do."), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      writeFileSync(
        join(runeHome, "secrets.json"),
        JSON.stringify({
          custom: {
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            model: "fresh-home-stub",
            key: "the-stub-ignores-this",
          },
        }),
        { mode: 0o600 },
      );
      lap("connect a route");

      // ── 5. Choose a model. `rune use` is the headless form of the picker's
      // model step, and it must persist into the fresh home.
      const use = await rune(["use", "custom", "fresh-home-stub"]);
      expect(use.code).toBe(0);
      expect(existsSync(join(runeHome, "model.json"))).toBe(true);
      lap("choose a model");

      // ── 6. The first prompt.
      const first = await rune([
        "-P",
        "Say hello and stop. Do not use any tools.",
        "--gear",
        "1",
        "--workspace",
        workspace,
      ]);
      expect(first.code).toBe(0);
      expect(`${first.out}${first.err}`).toContain("fresh-home stub");
      lap("first prompt answered");

      // ── 7. Doctor afterwards knows about the route.
      const d2 = await rune(["doctor"]);
      expect(d2.code).toBe(0);
      expect(d2.out).toContain("provider routes");
      lap("doctor (configured)");

      const total = Date.now() - started;
      console.log(
        `\n  fresh HOME → first answer: ${(total / 1000).toFixed(1)}s\n` +
          mark.map(([l, ms]) => `    ${(ms / 1000).toFixed(1)}s  ${l}`).join("\n") +
          "\n",
      );
      expect(total).toBeLessThan(BUDGET_MS);
    },
    BUDGET_MS + 30_000,
  );
});

// ─── Phase 4 Lane E: the six-step wizard, walked headlessly ───
//
// The interactive wizard is a TUI; this is the same state machine with no
// terminal attached. It runs against a clean RUNE_HOME and a loopback server
// standing in for the provider — the endpoint is the only thing it is told and
// the key it sends is a fake one, so no credential and no model call is ever
// involved.
//
// What is asserted is the founder's acceptance, item by item: the config file's
// contents after every step; that the key reaches neither the config file, nor
// a log, nor anything the wizard emits; that a session override reads as
// `active != saved`; that a rejected key saves nothing; that conflicting
// sources resolve by the one-line precedence; that a restart-required change
// says so and is in force in a NEW process; that cancelling leaves what was
// already saved alone; and that a resize does not disturb the ledger.

import {
  FirstRun,
  SETUP_STEPS,
  CONFIG_PRECEDENCE,
  ledgerRows,
  savedActiveRows,
  maskSecret,
  redactSecret,
  probeEndpoint,
  precedenceLine,
} from "../../packages/orchestrator/src/first-run";
import { resetRuneHomeCache } from "../../packages/shared/src/paths";
import { runSettingsCommand } from "../../packages/orchestrator/src/settings-command";
import { transcriptGutter } from "../../packages/orchestrator/src/bin/ui/tui-commands";

/** The fake key. It is never a real credential and never leaves this file. */
const FAKE_KEY = "sk-lane-e-not-a-real-key-0000-7f2a";

/** A loopback stand-in for the provider: it checks the header and nothing else. */
function startMockProvider(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      if (url.pathname.endsWith("/models")) {
        if (auth !== `Bearer ${FAKE_KEY}`) {
          // Shaped like the providers' own rejection, key echoed back — which
          // is exactly the case the receipt has to redact.
          return new Response(
            JSON.stringify({
              error: { message: `Incorrect API key provided: ${auth.replace("Bearer ", "")}` },
            }),
            { status: 401, statusText: "Unauthorized", headers: { "content-type": "text/json" } },
          );
        }
        return new Response(JSON.stringify({ data: [{ id: "mock-small", object: "model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/chat/completions")) {
        await req.text();
        return new Response(sse("The mock answered. No provider was called."), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

/**
 * Point the shared config reader and writer at the scratch home for the length
 * of one test, and put it back afterwards. `RUNE_CONFIG_PATH` is honoured by
 * both the loader and the writer, so reader and writer can never disagree.
 */
function scratchConfig(): { configPath: string; restore: () => void } {
  const before = {
    home: process.env.RUNE_HOME,
    config: process.env.RUNE_CONFIG_PATH,
    secrets: process.env.RUNE_SECRETS_PATH,
  };
  mkdirSync(runeHome, { recursive: true });
  const configPath = join(runeHome, "config.toml");
  process.env.RUNE_HOME = runeHome;
  process.env.RUNE_CONFIG_PATH = configPath;
  resetRuneHomeCache();
  return {
    configPath,
    restore: () => {
      if (before.home === undefined) delete process.env.RUNE_HOME;
      else process.env.RUNE_HOME = before.home;
      if (before.config === undefined) delete process.env.RUNE_CONFIG_PATH;
      else process.env.RUNE_CONFIG_PATH = before.config;
      if (before.secrets === undefined) delete process.env.RUNE_SECRETS_PATH;
      else process.env.RUNE_SECRETS_PATH = before.secrets;
      resetRuneHomeCache();
    },
  };
}

function readConfig(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Every regular file under `root`, recursively. Symlinks are not followed. */
function everyFile(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...everyFile(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

describe("first run: six steps without editing a config file", () => {
  test("the wizard walks all six steps and the file says so after each one", async () => {
    const scratch = scratchConfig();
    const server = startMockProvider();
    const stored: Array<[string, string]> = [];
    const emitted: string[] = [];
    try {
      // Nothing on disk yet: the founder has not edited anything.
      expect(readConfig(scratch.configPath)).toBe("");

      const run = new FirstRun({
        workspaceRoot: workspace,
        env: {},
        endpointFor: () => `http://127.0.0.1:${server.port}/v1/models`,
        storeSecret: (id, secret) => {
          stored.push([id, secret]);
          return "the system keychain";
        },
        // A running session that takes every change live, the way the TUI's does.
        applyLive: () => ({ ok: true }),
      });

      expect(run.heading()).toBe("1 of 6");
      expect(SETUP_STEPS.map((s) => s.id)).toEqual([
        "provider",
        "model",
        "key",
        "search",
        "spend_cap",
        "sandbox",
      ]);

      // ── 1. provider
      let out = await run.answer("custom");
      emitted.push(out.receipt.title, ...out.receipt.body, out.receipt.close);
      expect(out.ok).toBe(true);
      expect(out.savedTo).toBe(scratch.configPath);
      expect(readConfig(scratch.configPath)).toContain('defaultProvider = "custom"');
      expect(run.heading()).toBe("2 of 6");

      // ── 1a. the custom provider's base URL, which only `custom` is asked
      // for. It is a sub-question of the model step, not a seventh step: the
      // heading does not move, and the ledger still has six rows.
      expect(run.current()!.question).toContain("base URL");
      expect(run.heading()).toBe("2 of 6");
      expect(run.steps()).toHaveLength(6);
      const badUrl = await run.answer("http://not-loopback.example.com/v1");
      expect(badUrl.ok).toBe(false);
      expect(readConfig(scratch.configPath)).not.toContain("not-loopback");
      out = await run.answer(`http://127.0.0.1:${server.port}/v1`);
      emitted.push(out.receipt.title, ...out.receipt.body, out.receipt.close);
      expect(out.ok).toBe(true);
      // Held in memory until there is a model to pair it with: an endpoint
      // without a model is not a route, and half a route in the file is worse
      // than none.
      expect(readConfig(scratch.configPath)).not.toContain("127.0.0.1");
      expect(run.current()!.id).toBe("model");

      // ── 2. model — written under the provider that was just chosen
      out = await run.answer("mock-small");
      emitted.push(out.receipt.title, ...out.receipt.body, out.receipt.close);
      expect(out.ok).toBe(true);
      expect(readConfig(scratch.configPath)).toContain('model = "mock-small"');
      expect(readConfig(scratch.configPath)).toContain("[llm.custom]");

      // ── 3. key — probed first, stored only on a 2xx, never in the file
      const beforeKey = readConfig(scratch.configPath);
      out = await run.answer(FAKE_KEY);
      emitted.push(out.receipt.title, ...out.receipt.body, out.receipt.close);
      expect(out.ok).toBe(true);
      expect(out.receipt.body.join(" ")).toContain("200 OK");
      expect(out.receipt.close).toContain("the system keychain");
      expect(stored).toEqual([["custom", FAKE_KEY]]);
      // The config file is byte-identical: a key is not configuration.
      expect(readConfig(scratch.configPath)).toBe(beforeKey);

      // ── 4. search
      out = await run.answer("duckduckgo");
      emitted.push(out.receipt.title, ...out.receipt.body, out.receipt.close);
      expect(out.ok).toBe(true);
      expect(readConfig(scratch.configPath)).toContain('provider = "duckduckgo"');

      // ── 5. spend cap — validated by the same catalogue `/config` uses
      const bad = await run.answer("not-a-number");
      expect(bad.ok).toBe(false);
      expect(bad.receipt.close).toContain("nothing was saved");
      expect(readConfig(scratch.configPath)).not.toContain("maxSessionUsd");
      out = await run.answer("2.5");
      emitted.push(out.receipt.title, ...out.receipt.body, out.receipt.close);
      expect(out.ok).toBe(true);
      expect(readConfig(scratch.configPath)).toContain("maxSessionUsd = 2.5");

      // ── 6. sandbox
      out = await run.answer("regular");
      emitted.push(out.receipt.title, ...out.receipt.body, out.receipt.close);
      expect(out.ok).toBe(true);
      expect(readConfig(scratch.configPath)).toContain('mode = "regular"');
      expect(run.done()).toBe(true);

      // Every step is closed, and the ledger says what each one holds.
      const states = run.steps();
      expect(states.map((s) => s.status)).toEqual(Array(6).fill("done"));
      expect(states.find((s) => s.id === "key")!.value).toBe(maskSecret(FAKE_KEY));
      expect(run.restartNote()).toBeUndefined();

      // ── The key is nowhere it should not be.
      const config = readConfig(scratch.configPath);
      expect(config).not.toContain(FAKE_KEY);
      expect(config).not.toContain(FAKE_KEY.slice(-8));
      expect(emitted.join("\n")).not.toContain(FAKE_KEY);
      expect(ledgerRows(states, 38).join("\n")).not.toContain(FAKE_KEY);
      expect(savedActiveRows(run.savedVsActive(), 38).join("\n")).not.toContain(FAKE_KEY);
      // Every file under the home, not only the top level: `logs/` is where the
      // TUI's console sink lands and it is the one nobody looks at.
      for (const file of everyFile(runeHome)) {
        expect(readFileSync(file, "utf8")).not.toContain(FAKE_KEY);
        expect(readFileSync(file, "utf8")).not.toContain(FAKE_KEY.slice(-12));
      }
    } finally {
      server.stop(true);
      scratch.restore();
    }
  });

  test("a rejected key produces a receipt and saves nothing", async () => {
    const scratch = scratchConfig();
    const server = startMockProvider();
    const stored: string[] = [];
    try {
      const run = new FirstRun({
        workspaceRoot: workspace,
        env: {},
        endpointFor: () => `http://127.0.0.1:${server.port}/v1/models`,
        storeSecret: (_id, secret) => {
          stored.push(secret);
          return "the system keychain";
        },
      });
      await run.answer("custom");
      await run.answer(`http://127.0.0.1:${server.port}/v1`);
      await run.answer("mock-small");

      const before = readConfig(scratch.configPath);
      const out = await run.answer("sk-wrong-key-3333-beef");
      expect(out.ok).toBe(false);
      expect(out.receipt.ok).toBe(false);
      expect(out.receipt.title).toContain("check GET");
      expect(out.receipt.body.join(" ")).toContain("401 Unauthorized");
      expect(out.receipt.close).toContain("nothing was saved");
      expect(out.receipt.close).toContain("enter to retry");

      // Nothing moved: no key stored, no config line, and the step is still current.
      expect(stored).toEqual([]);
      expect(readConfig(scratch.configPath)).toBe(before);
      expect(run.current()!.id).toBe("key");
      expect(run.steps().find((s) => s.id === "key")!.status).toBe("current");

      // The provider echoed the key back in its error; the receipt did not.
      expect(out.receipt.body.join(" ")).not.toContain("sk-wrong-key-3333-beef");
      expect(out.receipt.body.join(" ")).toContain("beef");
    } finally {
      server.stop(true);
      scratch.restore();
    }
  });

  test("the production credential path persists a provider key outside config and reloads it", async () => {
    const scratch = scratchConfig();
    const server = startMockProvider();
    const beforeBackend = process.env.RUNE_CREDENTIAL_BACKEND;
    try {
      process.env.RUNE_CREDENTIAL_BACKEND = "file";
      const run = new FirstRun({
        workspaceRoot: workspace,
        env: process.env,
        endpointFor: () => `http://127.0.0.1:${server.port}/v1/models`,
      });
      await run.answer("openai");
      await run.answer("mock-small");
      const out = await run.answer(FAKE_KEY);

      expect(out.ok).toBe(true);
      expect(out.receipt.close).toContain("credentials.json");
      expect(readConfig(scratch.configPath)).not.toContain(FAKE_KEY);
      expect(existsSync(join(runeHome, "secrets.json"))).toBe(false);
      const persisted = JSON.parse(readFileSync(join(runeHome, "credentials.json"), "utf8"));
      expect(persisted["provider:openai"]).toBe(FAKE_KEY);
      expect(out.receipt.title + out.receipt.body.join(" ") + out.receipt.close).not.toContain(
        FAKE_KEY,
      );
    } finally {
      if (beforeBackend === undefined) delete process.env.RUNE_CREDENTIAL_BACKEND;
      else process.env.RUNE_CREDENTIAL_BACKEND = beforeBackend;
      server.stop(true);
      scratch.restore();
    }
  });

  test("a thrown probe error is redacted and leaves the key step retryable", async () => {
    const scratch = scratchConfig();
    try {
      const run = new FirstRun({
        workspaceRoot: workspace,
        env: {},
        endpointFor: () => "http://127.0.0.1.invalid/v1/models",
        probe: async () => {
          throw new Error(`transport rejected ${FAKE_KEY}`);
        },
      });
      await run.answer("openai");
      await run.answer("mock-small");
      const out = await run.answer(FAKE_KEY);
      expect(out.ok).toBe(false);
      expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
      expect(out.receipt.body.join(" ")).toContain(maskSecret(FAKE_KEY));
      expect(run.current()?.id).toBe("key");
    } finally {
      scratch.restore();
    }
  });

  test("a session override reads as active != saved, and names the source", async () => {
    const scratch = scratchConfig();
    try {
      const run = new FirstRun({
        workspaceRoot: workspace,
        env: {},
        applyLive: () => ({ ok: true }),
        // The session is running `strict` while the file is about to say `regular`.
        activeValue: (step) => (step === "sandbox" ? "strict" : undefined),
      });
      for (const answer of ["custom", "mock-small"]) await run.answer(answer);
      run.skip("not set"); // key
      run.skip("not set"); // search
      run.skip("not set"); // spend cap
      await run.answer("regular");

      const rows = run.savedVsActive();
      const sandbox = rows.find((r) => r.label === "sandbox")!;
      expect(sandbox.saved).toBe("regular");
      expect(sandbox.active).toBe("strict");
      expect(sandbox.differs).toBe(true);

      const painted = savedActiveRows(rows, 38).join("\n");
      expect(painted).toContain("saved");
      expect(painted).toContain("active");
      expect(painted).toContain("outranks the file");
      expect(painted).toContain(precedenceLine(38));

      // A row that matches says so, and says it once.
      const provider = rows.find((r) => r.label === "provider")!;
      expect(provider.differs).toBe(false);
    } finally {
      scratch.restore();
    }
  });

  test("conflicting sources resolve by the one-line precedence, and say a restart is required", async () => {
    const scratch = scratchConfig();
    try {
      // The environment already names a sandbox mode. Writing the file is still
      // the right thing to do; claiming it took effect would not be.
      const run = new FirstRun({
        workspaceRoot: workspace,
        env: { RUNE_SANDBOX_MODE: "strict" },
        applyLive: () => ({ ok: true }),
        activeValue: (step) => (step === "sandbox" ? "strict" : undefined),
      });
      for (const answer of ["custom", "mock-small"]) await run.answer(answer);
      run.skip();
      run.skip();
      run.skip();
      const out = await run.answer("regular");

      expect(out.ok).toBe(true);
      expect(out.shadowedBy).toBe("env");
      expect(out.restartRequired).toBe(true);
      expect(out.receipt.close).toContain("RUNE_SANDBOX_MODE");
      expect(out.receipt.close).toContain(CONFIG_PRECEDENCE);
      expect(run.sourceFor("sandbox")).toBe("env");
      expect(run.restartNote()).toContain("restart required");

      // The ledger row says it too, not only the receipt.
      const row = run.steps().find((s) => s.id === "sandbox")!;
      expect(row.restartRequired).toBe(true);
      expect(ledgerRows([row], 38)[0]).toContain("restart required");

      // A flag outranks the environment, and a launch flag is the top rung.
      const flagged = new FirstRun({
        workspaceRoot: workspace,
        env: { RUNE_SANDBOX_MODE: "strict" },
        flags: { sandbox: "off" },
      });
      expect(flagged.sourceFor("sandbox")).toBe("flag");
      expect(CONFIG_PRECEDENCE).toBe("flag > env > session > ~/.rune/config.toml");
    } finally {
      scratch.restore();
    }
  });

  test("a restart-required change is in force in a new process", async () => {
    const scratch = scratchConfig();
    try {
      // No live hook at all: this session cannot take the change, so the wizard
      // must say restart required rather than imply the value is live.
      const run = new FirstRun({ workspaceRoot: workspace, env: {} });
      for (const answer of ["custom", "mock-small"]) await run.answer(answer);
      run.skip();
      run.skip();
      const out = await run.answer("3.5");
      expect(out.appliedLive).toBe(false);
      expect(out.restartRequired).toBe(true);
      expect(out.receipt.close).toContain("restart required");

      // The restart: a brand-new process, reading only the file. It imports the
      // real loader by path — `@rune/shared` is a workspace name that resolves
      // inside `packages/`, and a bare `bun -e` has no package to resolve from.
      const loader = join(repoRoot, "packages", "shared", "src", "config.ts");
      const child = Bun.spawnSync(
        [
          "bun",
          "-e",
          `const { loadConfig } = await import(${JSON.stringify(loader)});` +
            "process.stdout.write(JSON.stringify(loadConfig()?.cost ?? {}));",
        ],
        {
          cwd: repoRoot,
          env: {
            ...(process.env as Record<string, string>),
            RUNE_HOME: runeHome,
            RUNE_CONFIG_PATH: scratch.configPath,
          },
        },
      );
      expect(child.stderr.toString()).toBe("");
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString()).maxSessionUsd).toBe(3.5);
    } finally {
      scratch.restore();
    }
  });

  test("cancelling mid-wizard leaves the previous config intact", async () => {
    const scratch = scratchConfig();
    try {
      const run = new FirstRun({
        workspaceRoot: workspace,
        env: {},
        applyLive: () => ({ ok: true }),
      });
      await run.answer("custom");
      const afterProvider = readConfig(scratch.configPath);
      expect(afterProvider).toContain('defaultProvider = "custom"');

      run.cancel();
      expect(run.done()).toBe(true);
      expect(run.wasCancelled()).toBe(true);
      expect(run.current()).toBeUndefined();

      // Nothing was written, and nothing was taken back.
      expect(readConfig(scratch.configPath)).toBe(afterProvider);
      const states = run.steps();
      expect(states.find((s) => s.id === "provider")!.status).toBe("done");
      // Work that did not happen is still information: the rows stay.
      expect(states).toHaveLength(6);
      expect(states.find((s) => s.id === "sandbox")!.value).toBe("not set");
    } finally {
      scratch.restore();
    }
  });

  test("a skipped step stays in the ledger reading `not set`", async () => {
    const scratch = scratchConfig();
    try {
      const run = new FirstRun({ workspaceRoot: workspace, env: {} });
      await run.answer("custom");
      await run.answer("http://127.0.0.1:9099/v1");
      await run.answer("mock-small");
      // An empty answer is a skip, and it says where to set it later.
      const out = await run.answer("   ");
      expect(out.ok).toBe(true);
      expect(out.receipt.close).toContain("not configured");
      const key = run.steps().find((s) => s.id === "key")!;
      expect(key.status).toBe("skipped");
      expect(key.value).toBe("not configured");
    } finally {
      scratch.restore();
    }
  });

  test("a resize does not disturb the ledger", async () => {
    const scratch = scratchConfig();
    try {
      const run = new FirstRun({
        workspaceRoot: workspace,
        env: {},
        applyLive: () => ({ ok: true }),
      });
      await run.answer("custom");
      await run.answer("http://127.0.0.1:9099/v1");
      await run.answer("mock-small-with-a-very-long-model-identifier");

      const before = run.steps();
      const wide = ledgerRows(before, 38);
      const narrow = ledgerRows(before, 24);
      const after = run.steps();

      // The ledger is data; only its rendering has a width.
      expect(after).toEqual(before);
      expect(wide).toHaveLength(6);
      expect(narrow).toHaveLength(6);
      for (const row of narrow) expect(row.length).toBeLessThanOrEqual(24);
      // Every label survives the squeeze; a shortened value says so.
      for (const step of SETUP_STEPS) {
        expect(narrow.join("\n")).toContain(step.label);
      }
      expect(narrow.join("\n")).toContain("…");
      expect(wide.join("\n")).toContain("mock-small-with-a-very");
    } finally {
      scratch.restore();
    }
  });

  test("a secret is masked to its last four everywhere, and redacted out of quoted bodies", () => {
    expect(maskSecret(FAKE_KEY)).toBe("••••••••7f2a");
    expect(maskSecret(FAKE_KEY)).not.toContain(FAKE_KEY.slice(0, 8));
    // Too short to mask safely: dots only, never the value.
    expect(maskSecret("abcd")).toBe("••••");
    expect(maskSecret("")).toBe("");
    const body = `{"error":{"message":"Incorrect API key provided: ${FAKE_KEY}"}}`;
    expect(redactSecret(body, FAKE_KEY)).not.toContain(FAKE_KEY);
    expect(redactSecret(body, FAKE_KEY)).toContain("••••••••7f2a");
  });

  test("a setting changed after setup persists, and its receipt keeps the gutter", async () => {
    const scratch = scratchConfig();
    try {
      const run = new FirstRun({
        workspaceRoot: workspace,
        env: {},
        applyLive: () => ({ ok: true }),
      });
      for (const answer of ["custom", "mock-small"]) await run.answer(answer);
      run.skip();
      run.skip();
      await run.answer("2.5");
      expect(readConfig(scratch.configPath)).toContain("maxSessionUsd = 2.5");

      // `/config budget 4` — the same validator, live setter and writer the
      // model's `update_config` tool uses, and not a model call.
      const applied: Array<[string, string]> = [];
      const receipt = await runSettingsCommand(
        {
          getWorkspaceRoot: () => workspace,
          readConfigSetting: (key) => (key === "budget" ? "2.5" : undefined),
          applyConfigSetting: (key, value) => {
            applied.push([key, value]);
            return { ok: true };
          },
        },
        "budget 4",
      );
      expect(applied).toEqual([["budget", "4"]]);
      expect(readConfig(scratch.configPath)).toContain("maxSessionUsd = 4");
      expect(receipt).toContain("budget");

      // The one transcript row that used to start at column 0.
      for (const line of transcriptGutter(receipt).split("\n")) {
        if (line !== "") expect(line.startsWith("  ")).toBe(true);
      }

      // An invalid value refuses, says why, and leaves the file alone.
      const before = readConfig(scratch.configPath);
      const refused = await runSettingsCommand(
        {
          getWorkspaceRoot: () => workspace,
          readConfigSetting: () => "4",
          applyConfigSetting: () => ({ ok: true }),
        },
        "budget not-a-number",
      );
      expect(refused.toLowerCase()).toContain("number");
      expect(readConfig(scratch.configPath)).toBe(before);
    } finally {
      scratch.restore();
    }
  });

  test("a probe that cannot reach the host reports that, not a rejection", async () => {
    // Port 1 on loopback answers nothing. A refusal is not a 401 and must not
    // be reported as one.
    const probe = await probeEndpoint({ url: "http://127.0.0.1:1/v1/models", timeoutMs: 2000 });
    expect(probe.ok).toBe(false);
    expect(probe.status).toBe(0);
    expect(probe.statusText.length).toBeGreaterThan(0);
  });
});
