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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
