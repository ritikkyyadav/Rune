// ─── The processes that boot: engine-host, and the CLI's --provider flag ───
//
// Promoted from tests/verification/v6-p4-engine-host-config-rung.ts,
// v6-p4-disabled-provider-selected.ts and v6-p4-unknown-provider-flag-silent.ts
// (V6 findings 5, 14 and 16).
//
// `a22866b` moved the startup ladder into `../startup-selection` for the
// terminal, and `bin/engine-host.ts` — the process `rune detach`, `rune serve`
// and `rune acp`/Zed actually run on — kept a private copy of the pre-fix
// decision, down to its own five-id `DEFAULT_MODELS`. From one ~/.rune, `rune`
// opened the setup wizard's saved profile on custom/mock-small while
// `engine-host` opened it on google/gemini-2.5-flash. One function, both
// callers — and the only way to see that is to boot the real processes and
// read what they chose.
//
// Zero model calls: stdin is closed or ignored, the host is asked only for its
// boot status, and each scratch home is thrown away.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../../", import.meta.url).pathname;
const HOST = join(root, "packages/orchestrator/src/bin/engine-host.ts");
const CLI = join(root, "packages/orchestrator/src/bin/rune-cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "startup-boot-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A scratch RUNE_HOME, seeded with the profile this case is about. */
function home(name: string, config: string, secrets: unknown): { home: string; ws: string } {
  const dir = join(scratch, name);
  const ws = join(scratch, `${name}-ws`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(dir, "config.toml"), config);
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(secrets));
  return { home: dir, ws };
}

/**
 * The environment a boot sees. `cwd` is OUTSIDE the checkout on purpose: bun
 * auto-loads the repo's own `.env` for any run rooted in it, which would hand
 * the process a GOOGLE_API_KEY nobody configured and confound every one of
 * these cases.
 */
function bootEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(scratch, "fakehome"),
    TMPDIR: scratch,
    RUNE_HOME: dir,
    RUNE_TOOLS_BIN: process.env.RUNE_TOOLS_BIN ?? "rune-tools",
    RUNE_TOOLS_BINARY: process.env.RUNE_TOOLS_BINARY ?? "rune-tools",
    ...extra,
  };
}

test("engine-host opens the wizard's saved custom profile exactly as the terminal does", async () => {
  const { home: dir, ws } = home(
    "wizard",
    '[llm]\ndefaultProvider = "custom"\n\n[llm.custom]\nmodel = "mock-small"\n',
    {
      keys: {},
      custom: { baseUrl: "http://127.0.0.1:64614/v1", model: "mock-small", key: "local" },
    },
  );
  const proc = Bun.spawn(["bun", HOST], {
    cwd: scratch,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    // One unrelated key on the machine — the only thing auto-detect could find,
    // and what the old private rung used to boot on.
    env: bootEnv(dir, { RUNE_WORKSPACE: ws, GOOGLE_API_KEY: "AIza-not-a-real-key" }),
  });
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  proc.kill();
  const ready = text
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((message) => message?.stream === "ready");
  expect(ready).toBeTruthy();
  expect(ready.payload.provider).toBe("custom");
  expect(ready.payload.model).toBe("mock-small");
}, 30_000);

test("the CLI never tells the user a provider they keyed has no key", async () => {
  // `/keys` writes `disabled`. Holding a credential and being usable are
  // different questions, and the selection asked only the first: a disabled
  // provider was chosen, the gateway refused to register it, and the boot
  // printed a false statement about the user's own key before substituting
  // registeredProviders[0].
  const { home: dir, ws } = home("disabled", '[llm]\ndefaultProvider = "mistral"\n', {
    keys: { mistral: "sk-mistral-scratch", google: "AIza-scratch" },
    disabled: ["mistral"],
  });
  const proc = Bun.spawn(["bun", CLI, "--classic", "--new", "--no-browser", "--workspace", ws], {
    cwd: scratch,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: bootEnv(dir),
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).not.toContain("mistral has no API key");
}, 30_000);

async function bootWithProviderFlag(value: string): Promise<string> {
  const { home: dir, ws } = home(
    `flag-${value.replace(/\W/g, "_")}`,
    '[llm]\ndefaultProvider = "google"\n',
    { keys: { google: "AIza-scratch" } },
  );
  const proc = Bun.spawn(
    ["bun", CLI, "--classic", "--new", "--no-browser", "--provider", value, "--workspace", ws],
    { cwd: scratch, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: bootEnv(dir) },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return out + err;
}

test("an unknown --provider is refused by name, not dropped in silence", async () => {
  // A flag that is parsed and discarded is the `rune -p` incident again: the
  // run opened on an auto-detected provider and said nothing at all.
  const typo = await bootWithProviderFlag("nope-xyz");
  expect(typo).toMatch(/nope-xyz/);
  expect(typo).toMatch(/Unknown --provider/);
}, 30_000);

test("a miscased --provider id is the id, and the boot says which provider it is on", async () => {
  const miscased = await bootWithProviderFlag("Anthropic");
  expect(miscased).toMatch(/anthropic/i);
  // Folded, not refused: the registry's ids are lower-case by convention, not
  // by the user's obligation.
  expect(miscased).not.toMatch(/Unknown --provider/);
}, 30_000);
