// ─── berne detach / attach: runs that survive the terminal ───
//
// `berne detach "<prompt>"` starts a per-run engine host on a unix socket,
// hands it the prompt, prints the session id, and EXITS — the host keeps
// working. `berne attach <session|latest>` reconnects: prior turns replay
// from the session store, live events stream if the run is still going, and
// Ctrl+C detaches again without stopping anything.
//
// Each detached run gets its own host + socket (registry at
// ~/.alan/run/registry.json). With --worktree the run executes in an isolated
// `git worktree` checkout on its own branch, so concurrent runs — and the
// user's own tree — never collide; merge-back is ordinary git.

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HostClient } from "../host-client";
import { createRunWorktree } from "../worktree";

const RUN_DIR = join(homedir(), ".alan", "run");
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

export async function runDetach(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const prompt = positionals.slice(1).join(" ").trim();
  if (!prompt) {
    console.error('Usage: berne detach "<prompt>" [--worktree] [-w <workspace>]');
    process.exit(2);
  }

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
  const hostScript = join(import.meta.dir, "engine-host.ts");
  const child = Bun.spawn(["bun", hostScript, "--socket", socket], {
    env: { ...process.env, ALAN_WORKSPACE: workspace },
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  child.unref(); // our exit must not take the host down

  const client = await connectWithRetry(socket, 20_000);
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
  console.log(`  attach:    berne attach ${sessionId.slice(0, 8)}`);
  console.log(`  host log:  ${logPath}`);
  process.exit(0);
}

export async function runAttach(positionals: string[]): Promise<void> {
  const wanted = (positionals[1] ?? "latest").trim();
  const reg = loadRegistry();
  const entries = Object.values(reg).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (entries.length === 0) {
    console.error('no detached runs recorded — start one with: berne detach "<prompt>"');
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
        `The transcript is in the session store: berne resume ${entry.sessionId}`,
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
      "\ndetached — the run continues. Reattach with: berne attach " + entry.sessionId.slice(0, 8),
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
