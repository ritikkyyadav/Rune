// ─── rune detach / attach: runs that survive the terminal ───
//
// `rune detach "<prompt>"` starts a per-run engine host on a unix socket,
// hands it the prompt, prints the session id, and EXITS — the host keeps
// working. `rune attach <session|latest>` reconnects: prior turns replay
// from the session store, live events stream if the run is still going, and
// Ctrl+C detaches again without stopping anything.
//
// Each detached run gets its own host + socket (registry at
// ~/.rune/run/registry.json). With --worktree the run executes in an isolated
// `git worktree` checkout on its own branch, so concurrent runs — and the
// user's own tree — never collide; merge-back is ordinary git.

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join } from "node:path";

import { HostClient } from "../host-client";
import { createRunWorktree } from "../worktree";
import { currentContext, hostSpawnArgv, hostStartFailure, readLogTail } from "./host-spawn";
import { adoptLegacyEnv, getRuneHome, migrateLegacyHome } from "@rune/shared";

adoptLegacyEnv();
migrateLegacyHome();
const RUN_DIR = join(getRuneHome(), "run");
const REGISTRY = join(RUN_DIR, "registry.json");

interface RunEntry {
  sessionId: string;
  socket: string;
  pid: number;
  workspace: string;
  worktreeBranch?: string;
  prompt: string;
  startedAt: string;
}

function loadRegistry(): Record<string, RunEntry> {
  try {
    return JSON.parse(readFileSync(REGISTRY, "utf8"));
  } catch {
    return {};
  }
}

function saveRegistry(reg: Record<string, RunEntry>): void {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
}

function hostAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function connectWithRetry(socket: string, timeoutMs: number): Promise<HostClient> {
  const start = Date.now();
  for (;;) {
    try {
      return await HostClient.connect(socket, 1_000);
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * The route flags a detached run was launched with, as the host's boot-time
 * environment. `rune detach -p ollama-turbo -m gpt-oss:120b --gear 4` parsed
 * all three and forwarded none: the host booted on model.json and the run died
 * on a retired free model nobody had asked for. Session-scoped names, not
 * `RUNE_PROVIDER`/`RUNE_MODEL` — those are machine defaults that the pin is
 * meant to beat; these say "this host, these flags" and beat the pin.
 *
 * Pure, so it can be pinned by a test without spawning a host.
 */
export function detachRouteEnv(values: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  const str = (key: string): string =>
    typeof values[key] === "string" ? (values[key] as string).trim() : "";
  const provider = str("provider");
  const model = str("model");
  if (provider) env.RUNE_SESSION_PROVIDER = provider;
  if (model) env.RUNE_SESSION_MODEL = model;
  // `--gear <1|2|3|4|auto>` and the legacy `--yolo` (4). `RUNE_GEAR` is the
  // documented env spelling of `[permissions] gear`, read by the host's config.
  const gear = str("gear") || (values.yolo === true ? "4" : "");
  if (gear) env.RUNE_GEAR = gear;
  return env;
}

export async function runDetach(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const prompt = positionals.slice(1).join(" ").trim();
  if (!prompt) {
    console.error(
      'Usage: rune detach "<prompt>" [--worktree] [-w <workspace>] [-p <provider>] [-m <model>] [--gear <1-4|auto>]',
    );
    process.exit(2);
  }
  const route = detachRouteEnv(values);

  let workspace = typeof values.workspace === "string" ? values.workspace : process.cwd();
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let worktreeBranch: string | undefined;

  if (values.worktree === true) {
    const wt = createRunWorktree(workspace, runId);
    workspace = wt.path;
    worktreeBranch = wt.branch;
    console.log(`isolated worktree: ${wt.path} (branch ${wt.branch})`);
  }

  mkdirSync(RUN_DIR, { recursive: true });
  const socket = join(RUN_DIR, `${runId}.sock`);
  const logPath = join(RUN_DIR, `${runId}.log`);
  const logFd = openSync(logPath, "a");

  // The host inherits this process's env (keys etc.) but gets its own
  // workspace; stdio goes to a log file so the child never holds a tty.
  //
  // `bun engine-host.ts` from a checkout, `<rune> engine-host` from the
  // compiled binary, where that script path is inside the binary's virtual
  // filesystem and cannot be spawned. See host-spawn.ts (P10.9a). No
  // `--parent-pid`: outliving this process is the whole point of detach.
  const argv = hostSpawnArgv(currentContext(import.meta.dir), ["--socket", socket]);
  const child = Bun.spawn(argv, {
    env: { ...process.env, RUNE_WORKSPACE: workspace, ...route },
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  child.unref(); // our exit must not take the host down

  let client: HostClient;
  try {
    client = await connectWithRetry(socket, 20_000);
  } catch (err) {
    // The log is right there and used to go unmentioned; a detach that cannot
    // reach its own host must say why rather than print a bare Bun error.
    console.error(
      hostStartFailure({
        address: socket,
        pid: child.pid,
        alive: hostAlive(child.pid),
        reason: err instanceof Error ? err.message : String(err),
        log: readLogTail(logPath),
      }),
    );
    process.exit(1);
  }
  const ack = (await client.request("chat_start", {
    sessionId: "detached",
    message: prompt,
  })) as { sessionId: string };
  const sessionId = ack.sessionId;

  const reg = loadRegistry();
  reg[sessionId] = {
    sessionId,
    socket,
    pid: child.pid,
    workspace,
    worktreeBranch,
    prompt: prompt.slice(0, 120),
    startedAt: new Date().toISOString(),
  };
  saveRegistry(reg);
  client.close();

  console.log(`detached run started`);
  console.log(`  session:   ${sessionId}`);
  console.log(`  workspace: ${workspace}`);
  if (route.RUNE_SESSION_PROVIDER || route.RUNE_SESSION_MODEL) {
    console.log(
      `  route:     ${route.RUNE_SESSION_PROVIDER ?? "(pinned provider)"}/${route.RUNE_SESSION_MODEL ?? "(provider default)"}`,
    );
  }
  if (route.RUNE_GEAR) console.log(`  gear:      ${route.RUNE_GEAR}`);
  console.log(`  attach:    rune attach ${sessionId.slice(0, 8)}`);
  console.log(`  host log:  ${logPath}`);
  process.exit(0);
}

export async function runAttach(positionals: string[]): Promise<void> {
  const wanted = (positionals[1] ?? "latest").trim();
  const reg = loadRegistry();
  const entries = Object.values(reg).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (entries.length === 0) {
    console.error('no detached runs recorded — start one with: rune detach "<prompt>"');
    process.exit(1);
  }
  const entry =
    wanted === "latest"
      ? entries[0]
      : entries.find((e) => e.sessionId === wanted || e.sessionId.startsWith(wanted));
  if (!entry) {
    console.error(`no detached run matches "${wanted}". Known:`);
    for (const e of entries.slice(0, 10)) {
      console.error(`  ${e.sessionId.slice(0, 8)}  ${e.startedAt}  ${e.prompt}`);
    }
    process.exit(1);
  }

  let client: HostClient;
  try {
    client = await HostClient.connect(entry.socket, 3_000);
  } catch {
    console.error(
      `host for ${entry.sessionId.slice(0, 8)} is no longer running.\n` +
        `The transcript is in the session store: rune resume ${entry.sessionId}`,
    );
    process.exit(1);
  }

  console.log(`attached to ${entry.sessionId.slice(0, 8)} (${entry.workspace})`);
  console.log(`prompt: ${entry.prompt}`);
  console.log("— replaying prior turns —");
  try {
    const turns = (await client.request("resume_session", {
      sessionId: entry.sessionId,
    })) as Array<{
      content: string;
    }>;
    for (const t of turns) console.log(`  › ${t.content.split("\n")[0]?.slice(0, 120)}`);
  } catch {
    /* replay is best-effort; live events still stream */
  }
  console.log("— live (Ctrl+C detaches; the run keeps going) —");

  client.onStream((frame) => {
    if (frame.stream === "chat_event") {
      const tagged = frame.payload as { sessionId?: string; event?: Record<string, unknown> };
      if (tagged.sessionId && tagged.sessionId !== entry.sessionId) return;
      const ev = (tagged.event ?? frame.payload) as Record<string, unknown>;
      if (ev.type === "text_delta" && typeof ev.text === "string") {
        process.stdout.write(ev.text);
      } else if (ev.type === "tool_call_start") {
        process.stdout.write(`\n  ⚙ ${String(ev.toolName ?? "tool")}\n`);
      } else if (ev.type === "error") {
        process.stdout.write(`\n  ✗ ${String(ev.error ?? "error")}\n`);
      } else if (ev.type === "turn_complete") {
        process.stdout.write("\n— turn complete — (still attached; Ctrl+C to detach)\n");
      }
    }
  });

  process.on("SIGINT", () => {
    client.close();
    console.log(
      "\ndetached — the run continues. Reattach with: rune attach " + entry.sessionId.slice(0, 8),
    );
    process.exit(0);
  });

  // Hold the process open while attached; the socket close ends us.
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (client.isClosed) {
        clearInterval(poll);
        resolve();
      }
    }, 250);
  });
  console.log("\nhost closed the connection.");
  process.exit(0);
}
