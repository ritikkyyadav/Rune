/**
 * The rig a process-level lifecycle scenario needs: a repository, a home, a
 * spawned `rune`, a way to kill it, and the artifacts to read afterwards.
 *
 * Everything here exists because `docs/program/phase-2-lifecycle.md` §2.8 is
 * true: no test in this repository SIGKILLs a Rune engine mid-turn and then
 * re-reads the database. The two that come closest kill an IDLE host
 * (`engine-host-tcp.test.ts:223`) and pass a cooperative `--stop-after` flag
 * (`workflow-examples.test.ts:130`).
 *
 * Three rules shape the design, all from §7:
 *
 *   * **Nothing real is in scope.** The child's environment is BUILT, never
 *     inherited: no `~/.rune`, no `~/.gitconfig`, and — the point — no API key
 *     of any provider. `curatedEnv` is the whole allowlist and
 *     `assertNoLiveCredentials` is the assertion that it held.
 *   * **Assert on sets, not counts.** A kill says nothing about what the child
 *     had flushed, so these readers return whole rows and whole file contents
 *     and let the test ask "is step 2 open", never "are there 47 rows".
 *   * **Deadlines live in code.** macOS has no `timeout(1)`, so every wait here
 *     takes a budget and reports what it was waiting for when it expires, and
 *     every spawn is force-killed in `dispose()` whatever the test did.
 */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import { describeNativeBinary, resolveRuneToolsBinary } from "./native-binary";

const repoRoot = join(import.meta.dir, "..", "..");
export const RUNE_CLI = join(repoRoot, "packages", "orchestrator", "src", "bin", "rune-cli.ts");

// ─── The native binary ───

/**
 * The `rune-tools` this scenario grades — and a hard failure when it is absent.
 *
 * §7: `skipIf(!HAS_RUST_BIN)` silently deletes coverage, and three worker
 * isolation tests already vanish on a checkout that never ran `cargo build`.
 * The scenario's acceptance check is a real `bash` call, so a missing binary
 * means the scenario did not run — which must read as a failure with a name,
 * not as a green suite with fewer tests in it.
 */
export function requireNativeBinary(): string {
  const bin = resolveRuneToolsBinary();
  if (!bin.exists) {
    throw new Error(
      "the lifecycle scenario needs the native tools binary and there is none: " +
        `${describeNativeBinary(bin)}. This is a FAILURE, not a skip — the scenario's ` +
        "acceptance check is a real `bash` call.",
    );
  }
  return bin.path;
}

// ─── The fixture repository ───

export interface Fixture {
  /** The workspace root — a real git repository. */
  root: string;
  /** The commit the run starts from. */
  head: string;
  /** The user's uncommitted edit to `src/api.ts`, verbatim. */
  userEdit: string;
  /** The untracked file that must survive everything. */
  untracked: string;
  /** The acceptance check, as the model would run it. */
  checkCommand: string;
  /** Where `check.mjs` appends one line per invocation. */
  runsLog: string;
  /**
   * A command that runs long enough to still be in flight when a kill lands,
   * and that is FINDABLE in the process table.
   *
   * `sleep 20 # marker` is not: measured on macOS, the shell drops the comment
   * and `ps` shows a bare `sleep 20`, so a scenario looking for its own marker
   * finds nothing and a cleanup pass matching on it kills nothing (this suite
   * leaked two `sleep 20` processes learning that). Passing the marker as an
   * ARGUMENT to a script the fixture owns puts it in argv, where `ps` shows it.
   */
  longCommand: (marker: string, seconds?: number) => string;
  /**
   * Committed filler, workspace-relative, ~40 KB each.
   *
   * §5.2 forces compaction with "four large `read_file` calls returning ~40 KB
   * each". Compaction is not a message count: `compactWorkingSet` sizes the
   * verbatim tail in TOKENS against the model's window
   * (`context-engine.ts:619-633`), so a transcript of small reads is entirely
   * tail and is correctly left alone. These files are what makes a head exist.
   */
  bulkFiles: string[];
}

const API_TS = `export interface Api {
  hello(): string;
}

export function makeApi(): Api {
  return {
    hello: () => "hello",
  };
}
`;

const CLIENT_TS = `import { makeApi } from "./api";

export function run(): string {
  return makeApi().hello();
}
`;

/**
 * `check.mjs` — the independent acceptance check of §5.6.
 *
 * Two jobs. It decides whether the change is done, by reading the files rather
 * than by asking the model; and it APPENDS ONE LINE PER INVOCATION to
 * `runs.log`, which is how "no duplicated side effects on replay" becomes a
 * countable fact on disk instead of a claim. Paths resolve against the script's
 * own directory so the answer does not depend on the tool's cwd.
 */
const CHECK_MJS = `import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
appendFileSync(join(here, "runs.log"), \`check \${new Date().toISOString()}\\n\`);

const read = (p) => {
  try {
    return readFileSync(join(here, p), "utf8");
  } catch {
    return "";
  }
};
const api = read("src/api.ts");
const client = read("src/client.ts");
const ok = api.includes("version") && client.includes("version");
console.log(ok ? "check: version endpoint wired" : "check: version endpoint missing");
process.exit(ok ? 0 : 1);
`;

/**
 * The environment probe: what a child can see of its own environment, written
 * from inside a real tool call.
 *
 * NAMES only, never values — the assertion is that a credential variable is
 * not there at all, and a test artifact is the last place to write one if it
 * were. This is the half of the zero-spend claim a ledger cannot make: not
 * "nothing was billed" but "nothing COULD have been", measured in the process
 * that would have done the billing rather than argued about from its config.
 */
const ENV_PROBE_MJS = `import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const names = Object.keys(process.env).sort();
writeFileSync(
  join(here, "env-probe.json"),
  JSON.stringify({ names, home: process.env.HOME ?? "", runeHome: process.env.RUNE_HOME ?? "" }),
);
console.log(\`env-probe: \${names.length} variables, no values recorded\`);
`;

/** Install the probe in a fixture, and return the command that runs it. */
export function installEnvProbe(fixture: Fixture): { command: string; resultPath: string } {
  writeFileSync(join(fixture.root, "env-probe.mjs"), ENV_PROBE_MJS);
  return { command: "node env-probe.mjs", resultPath: join(fixture.root, "env-probe.json") };
}

/** Sleeps, with its marker in argv so the process table can be searched for it. */
const LONG_MJS = `const marker = process.argv[2] ?? "no-marker";
const seconds = Number(process.argv[3] ?? "20");
console.log(\`long: \${marker} for \${seconds}s\`);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
console.log("long: finished");
`;

function git(root: string, args: string[]): string {
  const res = spawnSync(
    "git",
    [
      "-c",
      "user.name=Scenario",
      "-c",
      "user.email=scenario@localhost",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/**
 * §5.1: a tiny project, committed, then left DIRTY — an uncommitted edit and an
 * untracked file. Both are what a worker's snapshot has to carry
 * (`worker-worktree.ts:172-186`) and what "no lost edits" is measured against.
 */
export function makeFixture(baseDir: string): Fixture {
  const root = join(baseDir, "workspace");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "api.ts"), API_TS);
  writeFileSync(join(root, "src", "client.ts"), CLIENT_TS);
  writeFileSync(join(root, "check.mjs"), CHECK_MJS);
  writeFileSync(join(root, "long.mjs"), LONG_MJS);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "scenario-fixture" }, null, 2));

  const bulkFiles: string[] = [];
  mkdirSync(join(root, "docs"), { recursive: true });
  for (let i = 1; i <= 8; i++) {
    const rel = join("docs", `note-${i}.md`);
    const lines: string[] = [`# note ${i}`, ""];
    for (let n = 0; n < 700; n++) {
      lines.push(
        `${n}. the ${i}th note records that the api and the client are separate modules, ` +
          "and that the version endpoint has to appear in both before the check can pass.",
      );
    }
    writeFileSync(join(root, rel), `${lines.join("\n")}\n`);
    bulkFiles.push(rel);
  }

  git(root, ["init", "--initial-branch=main"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "scenario fixture"]);
  const head = git(root, ["rev-parse", "HEAD"]).trim();

  // The user's own uncommitted work, and an untracked note beside it.
  const userEdit = "// USER-EDIT: keep this line, it is not committed\n";
  appendFileSync(join(root, "src", "api.ts"), userEdit);
  const untracked = "notes the user has not committed\n";
  writeFileSync(join(root, "src", "notes.md"), untracked);

  return {
    root,
    head,
    userEdit,
    untracked,
    checkCommand: "node check.mjs",
    runsLog: join(root, "runs.log"),
    longCommand: (marker: string, seconds = 20) => `node long.mjs ${marker} ${seconds}`,
    bulkFiles,
  };
}

// ─── The scratch home ───

export interface ScratchHome {
  /** `RUNE_HOME`. */
  path: string;
  /** `HOME` — a different directory, so nothing can reach the founder's. */
  osHome: string;
  /** `RUNE_DB_PATH` — the session store this scenario reads back. */
  dbPath: string;
  /** `~/.rune/team.db` under the scratch home, when `[team] enabled`. */
  teamDbPath: string;
}

export interface ScratchHomeOptions {
  baseUrl: string;
  model: string;
  /** Appended verbatim to the generated `config.toml`. */
  extraConfig?: string;
  /** `[reliability] maxTurns`. §5.1 uses 12. */
  maxTurns?: number;
  /** `[subagents] maxParallel`. §5.1 uses 1. */
  maxParallel?: number;
  /** `[team] enabled`. §5.1 turns it on so the lease path is exercised. */
  team?: boolean;
}

/**
 * A home whose ONLY provider is the loopback mock.
 *
 * `secrets.json` carries the `custom` endpoint and nothing else — the seam six
 * existing process-level tests already use (`acp-conformance.test.ts:128-141`)
 * — and `model.json` pins that provider, so there is no configured route to
 * anything that bills.
 */
export function makeScratchHome(baseDir: string, opts: ScratchHomeOptions): ScratchHome {
  const osHome = join(baseDir, "home");
  const path = join(osHome, ".rune");
  mkdirSync(path, { recursive: true });

  writeFileSync(
    join(path, "model.json"),
    JSON.stringify({ provider: "custom", model: opts.model }),
  );
  writeFileSync(
    join(path, "secrets.json"),
    JSON.stringify({
      custom: { baseUrl: opts.baseUrl, model: opts.model, key: "the-mock-server-ignores-this" },
    }),
    { mode: 0o600 },
  );
  // A git identity for the scratch HOME. The worker passes its own `-c
  // user.name` when it commits (`worker-worktree.ts:189-193`), but anything
  // else that shells out to git in this home should not stop to ask who we are.
  writeFileSync(
    join(osHome, ".gitconfig"),
    "[user]\n\tname = Scenario\n\temail = scenario@localhost\n[commit]\n\tgpgSign = false\n[init]\n\tdefaultBranch = main\n",
  );

  const config =
    `[reliability]\nmaxTurns = ${opts.maxTurns ?? 12}\n\n` +
    `[git]\nautoCommit = false\n\n` +
    `[team]\nenabled = ${opts.team === false ? "false" : "true"}\n\n` +
    `[subagents]\nmaxParallel = ${opts.maxParallel ?? 1}\n\n` +
    `[sandbox]\nmode = "off"\n` +
    (opts.extraConfig ? `\n${opts.extraConfig}\n` : "");
  writeFileSync(join(path, "config.toml"), config);

  return {
    path,
    osHome,
    dbPath: join(path, "rune.db"),
    teamDbPath: join(path, "team.db"),
  };
}

// ─── The child's environment ───

/** Every variable name that could carry a real provider credential. */
export const CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "RUNE_API_KEY",
] as const;

/**
 * A PATH the child can work with, built from where the tools it needs actually
 * are rather than from the developer's whole shell environment.
 */
function curatedPath(): string {
  const needed = ["bun", "node", "git"]
    .map((exe) => spawnSync("which", [exe], { encoding: "utf8" }).stdout.trim())
    .filter(Boolean)
    .map((p) => dirname(p));
  return [...new Set([...needed, "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
}

/**
 * The child's whole environment, built from nothing.
 *
 * `process.env` is deliberately NOT spread. Every existing process-level test
 * in this repository spreads it — which is fine when the child has a configured
 * `custom` route it will use anyway, and not fine here: this suite's claim is
 * that it makes zero live model calls, and the cheapest way to make that true
 * is for the child to hold no credential to make one with.
 */
export function curatedEnv(
  home: ScratchHome,
  fixture: Fixture,
  toolsBin: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: curatedPath(),
    HOME: home.osHome,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    // Git needs an identity for the worker's snapshot commit even with the
    // scratch .gitconfig, on a machine whose global config is out of reach.
    GIT_AUTHOR_NAME: "Scenario",
    GIT_AUTHOR_EMAIL: "scenario@localhost",
    GIT_COMMITTER_NAME: "Scenario",
    GIT_COMMITTER_EMAIL: "scenario@localhost",
    RUNE_HOME: home.path,
    RUNE_WORKSPACE: fixture.root,
    RUNE_DB_PATH: home.dbPath,
    RUNE_TOOLS_BIN: toolsBin,
    RUNE_TOOLS_BINARY: toolsBin,
    // The OS sandbox is not what this scenario measures, and a Seatbelt profile
    // that denies the temp workspace would fail every write for the wrong
    // reason. `tests/integration/*-sandbox.test.ts` is where containment is graded.
    RUNE_SANDBOX_MODE: "off",
    RUNE_ROUNDTRIP_TIMEOUT_MS: "120000",
    ...extra,
  };
  return env;
}

/** Fail loudly if a curated environment ever grew a real credential. */
export function assertNoLiveCredentials(env: Record<string, string>): void {
  const leaked = CREDENTIAL_VARS.filter((name) => (env[name] ?? "") !== "");
  if (leaked.length > 0) {
    throw new Error(
      `the scenario child would have been given real credentials: ${leaked.join(", ")}`,
    );
  }
  const secrets = Object.keys(env).filter((k) => /_API_KEY$|_TOKEN$/.test(k) && env[k]);
  if (secrets.length > 0) {
    throw new Error(
      `unexpected credential-shaped variables in the child env: ${secrets.join(", ")}`,
    );
  }
}

// ─── Spawning, watching, killing ───

export interface RunOptions {
  home: ScratchHome;
  fixture: Fixture;
  toolsBin: string;
  prompt: string;
  /** `--resume <id>`: continue the session a previous run wrote. */
  resume?: string;
  /** Extra CLI arguments. Never a provider or a model — see the class comment. */
  args?: string[];
  env?: Record<string, string>;
  /**
   * Run a COMPILED binary instead of `bun rune-cli.ts` — the installed
   * `~/.rune/bin/rune`, say. Defaults to `RUNE_SCENARIO_CLI`, then to source.
   */
  cli?: string;
}

export interface HeadlessEnvelope {
  ok: boolean;
  sessionId?: string;
  text: string;
  error?: string;
  stopReason?: string;
  toolCalls: number;
  toolErrors: number;
  filesChanged: string[];
  permissionsDenied: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  durationMs: number;
  /** Present once the lifecycle projection reaches the envelope (G17). */
  lifecycle?: Record<string, unknown>;
}

/** One NDJSON line off `--stream-json`, kept loose on purpose. */
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export class Run {
  readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly startedAt = Date.now();
  private out = "";
  private err = "";
  private lines: StreamEvent[] = [];
  private pending = "";
  private eventWaiters: Array<{
    pred: (e: StreamEvent) => boolean;
    resolve: (e: StreamEvent) => void;
  }> = [];
  private exitCode: number | null = null;
  private signalled: string | null = null;

  constructor(
    proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
    readonly command: string[],
  ) {
    this.proc = proc;
    void this.drain(proc.stdout, (chunk) => {
      this.out += chunk;
      this.ingest(chunk);
    });
    void this.drain(proc.stderr, (chunk) => {
      this.err += chunk;
    });
    void proc.exited.then((code) => {
      this.exitCode = code;
    });
  }

  private async drain(
    stream: ReadableStream<Uint8Array>,
    sink: (s: string) => void,
  ): Promise<void> {
    // A reader rather than `for await`: the DOM lib's ReadableStream has no
    // async iterator, and this file is typechecked with it.
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) sink(decoder.decode(value, { stream: true }));
    }
  }

  /** Parse `--stream-json` NDJSON as it arrives, so a waiter can react live. */
  private ingest(chunk: string): void {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let parsed: StreamEvent;
      try {
        parsed = JSON.parse(trimmed) as StreamEvent;
      } catch {
        continue;
      }
      if (typeof parsed.type !== "string") continue;
      this.lines.push(parsed);
      for (const waiter of this.eventWaiters.filter((w) => w.pred(parsed))) {
        this.eventWaiters = this.eventWaiters.filter((w) => w !== waiter);
        waiter.resolve(parsed);
      }
    }
  }

  get pid(): number {
    return this.proc.pid;
  }

  get stdout(): string {
    return this.out;
  }

  get stderr(): string {
    return this.err;
  }

  get events(): StreamEvent[] {
    return this.lines;
  }

  get killed(): boolean {
    return this.signalled !== null;
  }

  /** Wait for one streamed event, with a deadline that says what it wanted. */
  waitForEvent(
    pred: (e: StreamEvent) => boolean,
    opts: { timeoutMs?: number; label?: string } = {},
  ): Promise<StreamEvent> {
    const seen = this.lines.find(pred);
    if (seen) return Promise.resolve(seen);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise<StreamEvent>((resolve, reject) => {
      const entry = {
        pred,
        resolve: (e: StreamEvent) => {
          clearTimeout(timer);
          resolve(e);
        },
      };
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((w) => w !== entry);
        reject(
          new Error(
            `waited ${timeoutMs}ms for ${opts.label ?? "an event"}; saw ` +
              `${this.lines.map((l) => l.type).join(", ") || "nothing"}`,
          ),
        );
      }, timeoutMs);
      this.eventWaiters.push(entry);
    });
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (this.exitCode !== null) return;
    this.signalled = signal;
    try {
      this.proc.kill(signal);
    } catch {
      // Already gone: nothing to do, and nothing to report.
    }
  }

  /** Wait for exit, killing the child rather than hanging the suite. */
  async wait(timeoutMs = 180_000): Promise<number> {
    const timer = setTimeout(() => {
      this.signalled ??= "SIGKILL(deadline)";
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const code = await this.proc.exited;
    clearTimeout(timer);
    // Give the reader loops a tick to flush the last chunk.
    await new Promise((r) => setTimeout(r, 25));
    return code;
  }

  /**
   * The envelope, which is the LAST JSON object on stdout.
   *
   * With `--stream-json` every line is an event and the envelope is the tail
   * (`rune-cli.ts:1496-1501`), so it is found by looking for the object that
   * carries the envelope's own keys rather than by counting lines.
   */
  envelope(): HeadlessEnvelope | null {
    const all = `${this.out}\n${this.pending}`.split("\n");
    for (let i = all.length - 1; i >= 0; i--) {
      const line = all[i]!.trim();
      if (!line.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if ("ok" in parsed && "toolCalls" in parsed) return parsed as unknown as HeadlessEnvelope;
      } catch {
        continue;
      }
    }
    return null;
  }
}

/**
 * Which binary `spawnRun` should drive: the source CLI, or a compiled one.
 *
 * Returns `""` for the default — `bun packages/orchestrator/src/bin/rune-cli.ts`,
 * which is what every suite in this repository gets and what they got before
 * this hook existed. A non-empty answer is an explicit request, from the
 * `cli` option or from `RUNE_SCENARIO_CLI`, for the COMPILED binary instead.
 *
 * It is deliberately loud. A verification pass that asks for the installed
 * binary and silently gets the source one back would produce a measurement
 * labelled with the wrong subject, which is worse than no measurement, so a
 * path that does not exist or cannot be executed throws here rather than at
 * whatever the child fails to do later.
 */
function resolveScenarioCli(explicit?: string): string {
  const requested = (explicit ?? process.env.RUNE_SCENARIO_CLI ?? "").trim();
  if (!requested) return "";
  if (!existsSync(requested)) {
    throw new Error(
      `RUNE_SCENARIO_CLI / RunOptions.cli points at a binary that does not exist: ${requested}`,
    );
  }
  try {
    accessSync(requested, fsConstants.X_OK);
  } catch {
    throw new Error(`RUNE_SCENARIO_CLI / RunOptions.cli is not executable: ${requested}`);
  }
  return requested;
}

/**
 * Spawn the real CLI, headless, against the mock.
 *
 * `--stream-json` is not decoration: it is the only way to observe the child's
 * progress from outside while it runs, which is what an event-timed kill needs.
 * Nothing here ever passes `-p`/`--provider` or `-m`/`--model`: the route comes
 * from the scratch home's `model.json`, and passing a real provider name is how
 * a test like this bills someone.
 */
export function spawnRun(opts: RunOptions): Run {
  const env = { ...curatedEnv(opts.home, opts.fixture, opts.toolsBin, opts.env ?? {}) };
  assertNoLiveCredentials(env);
  const args = [
    "-P",
    opts.prompt,
    "--stream-json",
    "--auto-approve",
    "--workspace",
    opts.fixture.root,
    ...(opts.resume ? ["--resume", opts.resume] : []),
    ...(opts.args ?? []),
  ];
  // Source by default. `RUNE_SCENARIO_CLI` (or `opts.cli`) points the same rig
  // at a COMPILED binary instead — the one a verification pass needs when the
  // question is "does the thing the founder actually runs still do this", and
  // the shape V4b drove by hand. Everything else is unchanged: the same fixture,
  // the same scratch home whose only route is the loopback mock, and
  // `assertNoLiveCredentials` before the process starts.
  const cli = resolveScenarioCli(opts.cli);
  const argv = cli ? [cli, ...args] : ["bun", RUNE_CLI, ...args];
  const proc = Bun.spawn(argv, {
    cwd: opts.fixture.root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return new Run(proc as Bun.Subprocess<"ignore", "pipe", "pipe">, argv);
}

// ─── Artifacts ───

export interface SessionEventRow {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Read a session log back, read-only, without importing the engine. */
export function readEvents(dbPath: string, sessionId?: string): SessionEventRow[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = (
      sessionId
        ? db
            .query(
              "SELECT seq, type, payload_json, created_at FROM events WHERE session_id = ? ORDER BY seq",
            )
            .all(sessionId)
        : db.query("SELECT seq, type, payload_json, created_at FROM events ORDER BY seq").all()
    ) as Array<{ seq: number; type: string; payload_json: string; created_at: string }>;
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      createdAt: r.created_at,
      payload: unwrapPayload(safeJson(r.payload_json)),
    }));
  } finally {
    db.close();
  }
}

export function listSessions(
  dbPath: string,
): Array<{ id: string; status: string; title: string | null }> {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT id, status, title FROM sessions ORDER BY created_at").all() as Array<{
      id: string;
      status: string;
      title: string | null;
    }>;
  } finally {
    db.close();
  }
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * `payload_json` holds the WHOLE `SessionEvent`, not its payload.
 *
 * `appendEvent` serialises `{type, payload}` into the column beside the `type`
 * column that repeats the same value (`packages/shared/src/session.ts:279-289`),
 * so a reader that takes `payload_json` at its word finds every field one level
 * deeper than the schema suggests. Measured on a scratch database, not assumed:
 * a `cost` row's tokens live at `payload.payload.inputTokens`.
 */
function unwrapPayload(parsed: Record<string, unknown>): Record<string, unknown> {
  const inner = parsed.payload;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return parsed;
}

/** The latest `task_state` snapshot — the spine a restart would inherit. */
export function latestTaskState(rows: SessionEventRow[]): Record<string, unknown> | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.type !== "task_state") continue;
    const state = rows[i]!.payload.state;
    if (state && typeof state === "object") return state as Record<string, unknown>;
  }
  return null;
}

export interface TodoLike {
  content?: string;
  status?: string;
  evidence?: Record<string, unknown>;
  [key: string]: unknown;
}

export function todosOf(state: Record<string, unknown> | null): TodoLike[] {
  const todos = state?.todos;
  return Array.isArray(todos) ? (todos as TodoLike[]) : [];
}

/** Rows a consumer would bill from, with their role when the build records one. */
export function costRows(rows: SessionEventRow[]): Array<{
  seq: number;
  role: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  priced: boolean;
}> {
  return rows
    .filter((r) => r.type === "cost")
    .map((r) => ({
      seq: r.seq,
      role: String(r.payload.role ?? "primary"),
      inputTokens: Number(r.payload.inputTokens ?? 0),
      outputTokens: Number(r.payload.outputTokens ?? 0),
      cacheReadTokens: Number(r.payload.cacheReadTokens ?? 0),
      costUsd: Number(r.payload.costUsd ?? 0),
      priced: r.payload.priced === true,
    }));
}

// ─── Git and the worktrees ───

export function gitStatus(root: string): string {
  return spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout ?? "";
}

export function gitBranches(root: string): string[] {
  const out = spawnSync("git", ["branch", "--list", "--format=%(refname:short)"], {
    cwd: root,
    encoding: "utf8",
  }).stdout;
  return (out ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function gitWorktrees(root: string): string[] {
  const out = spawnSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).stdout;
  return (out ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function readFileOr(path: string, fallback = ""): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

export function countLines(path: string): number {
  const text = readFileOr(path);
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

// ─── The team bus ───

/** Path claims the bus is holding. Empty is the answer after a reap. */
export function teamClaims(teamDbPath: string): Array<Record<string, unknown>> {
  if (!existsSync(teamDbPath)) return [];
  const db = new Database(teamDbPath, { readonly: true });
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    if (!tables.some((t) => t.name === "claims")) return [];
    return db.query("SELECT * FROM claims").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

export function teamInstances(teamDbPath: string): Array<Record<string, unknown>> {
  if (!existsSync(teamDbPath)) return [];
  const db = new Database(teamDbPath, { readonly: true });
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    if (!tables.some((t) => t.name === "instances")) return [];
    return db.query("SELECT * FROM instances").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

// ─── The process table ───

/**
 * `ps -eo pid,ppid,command`, or null on a machine without `ps`.
 *
 * Returning null rather than throwing keeps the shape
 * `zz-no-leaked-hosts.test.ts:45-53` established: a machine with no `ps` has
 * nothing to assert, and a hard failure there would be a false alarm.
 */
export function psLines(): string | null {
  const p = spawnSync("ps", ["-eo", "pid,ppid,command"], { encoding: "utf8" });
  if (p.status !== 0) return null;
  return p.stdout;
}

export function matchingProcesses(needle: string, ps = psLines()): string[] {
  if (ps === null) return [];
  return ps
    .split("\n")
    .filter((line) => line.includes(needle))
    .filter((line) => !line.includes("ps -eo"))
    .map((l) => l.trim());
}

/**
 * Poll for a process to disappear: 24 attempts at 250 ms, the exact retry shape
 * `zz-no-leaked-hosts.test.ts:49-53` uses, because `ps` immediately after a
 * kill still shows the child.
 */
export async function waitForNoProcess(
  needle: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<string[]> {
  const attempts = opts.attempts ?? 24;
  const delayMs = opts.delayMs ?? 250;
  let last: string[] = [];
  for (let i = 0; i < attempts; i++) {
    const ps = psLines();
    if (ps === null) return [];
    last = matchingProcesses(needle, ps);
    if (last.length === 0) return [];
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

/**
 * Wait for a process to APPEAR, which is how a kill lands inside a tool call.
 *
 * The native executor is a fresh child per call (`rust-bridge.ts:137`) whose
 * pid is proc-local and never recorded, so the only way to know a tool is
 * genuinely in flight — rather than merely requested by the model — is to see
 * it in the process table. Waiting on the request instead would race the
 * spawn and produce a kill at a MODEL boundary while claiming a tool one.
 */
export async function waitForProcess(
  needle: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<string[]> {
  const attempts = opts.attempts ?? 40;
  const delayMs = opts.delayMs ?? 100;
  for (let i = 0; i < attempts; i++) {
    const ps = psLines();
    if (ps === null) return [];
    const found = matchingProcesses(needle, ps);
    if (found.length > 0) return found;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return [];
}

/** Last-resort cleanup: nothing this suite started may outlive it. */
export function killMatching(needle: string): number {
  const found = matchingProcesses(needle);
  let killed = 0;
  for (const line of found) {
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!Number.isFinite(pid) || pid <= 1) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      // Already gone, or not ours to kill.
    }
  }
  return killed;
}

// ─── The founder's own ledger ───

export interface LedgerFingerprint {
  path: string;
  rows: number;
  newest: string | null;
}

/**
 * Cost rows in the REAL ledger that this suite could be responsible for.
 *
 * Identity, not arithmetic. The count of `cost` rows in `~/.rune/rune.db` is
 * not a measurement of this process: that database is written and
 * WAL-checkpointed by whatever else the founder is running — an `engine-host`
 * alive for days, in the case that made two of three verification runs fail
 * while spending nothing. So the question asked here is the one this suite can
 * actually answer: does any row NAME this suite's model or provider since it
 * started, and does any row belong to a session this suite created?
 */
export function ledgerRowsAttributable(opts: {
  since: string;
  needles: string[];
  sessionIds: string[];
  path?: string;
}): { naming: number; sessions: number } | null {
  const path = opts.path ?? join(process.env.HOME ?? "", ".rune", "rune.db");
  if (!path || !existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    let naming = 0;
    for (const needle of opts.needles) {
      const row = db
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE type = 'cost' AND created_at > ? AND payload_json LIKE ?",
        )
        .get(opts.since, `%${needle}%`) as { n: number };
      naming += row.n;
    }
    let sessions = 0;
    for (const id of opts.sessionIds) {
      const row = db.query("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(id) as {
        n: number;
      };
      sessions += row.n;
    }
    return { naming, sessions };
  } finally {
    db.close();
  }
}

/**
 * The `cost` rows in the REAL `~/.rune/rune.db`, read-only.
 *
 * The suite records this before and after and asserts it did not move. That is
 * the proof that a rig which spawns a real `rune` spent nothing: not an
 * argument about how it was configured, a measurement of the founder's own
 * ledger. Returns null when the database is absent, and the caller states that
 * as the reason it skipped rather than passing silently.
 */
export function ledgerFingerprint(
  path = join(process.env.HOME ?? "", ".rune", "rune.db"),
): LedgerFingerprint | null {
  if (!path || !existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .query("SELECT COUNT(*) AS rows, MAX(created_at) AS newest FROM events WHERE type = 'cost'")
      .get() as { rows: number; newest: string | null };
    return { path, rows: row.rows, newest: row.newest };
  } finally {
    db.close();
  }
}
