import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager } from "../../packages/tool-registry/src/tools/background";
import { setSandboxMode } from "../../packages/tool-registry/src/sandbox-mode";
import { describeNativeBinary, resolveRuneToolsBinary } from "../helpers/native-binary";

// An exported RUNE_TOOLS_BINARY/RUNE_TOOLS_BIN wins over anything under
// target/, and a variable pointing nowhere throws instead of skipping.
const nativeBinary = resolveRuneToolsBinary();
const binary = nativeBinary.path;
const native = nativeBinary.exists && ["darwin", "linux"].includes(process.platform);
if (!native)
  console.warn(
    `[background-sandbox] skipped: ${
      nativeBinary.exists
        ? `${process.platform} has no native sandbox backend`
        : describeNativeBinary(nativeBinary)
    }`,
  );
const dirs: string[] = [];
const managers: BackgroundShellManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.killAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  setSandboxMode("on");
});
async function finished(manager: BackgroundShellManager, shell: string) {
  let output = "";
  for (let i = 0; i < 200; i++) {
    const r = manager.read(shell);
    output += r.output ?? "";
    if (r.status !== "running") return { ...r, output };
    await Bun.sleep(20);
  }
  throw new Error("Background command did not finish");
}
test.skipIf(!native)(
  "background network access retains native filesystem and environment containment",
  async () => {
    // OS temporary directories are intentionally writable; use a fixture outside
    // those roots to prove the workspace boundary, without touching user files.
    const dir = mkdtempSync(join(homedir(), ".rune-containment-test-"));
    dirs.push(dir);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const manager = new BackgroundShellManager(binary);
    managers.push(manager);
    setSandboxMode("on");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("local-response"),
    });
    const oldSecret = process.env.RUNE_TEST_SECRET;
    process.env.RUNE_TEST_SECRET = "synthetic-never-forward-this";
    try {
      const started = manager.start(
        `curl -fsS http://127.0.0.1:${server.port}/ && printf inside > allowed.txt`,
        workspace,
        true,
      );
      expect(started.sandboxed).toBe(true);
      const result = await finished(manager, started.shellId);
      expect(result.status).toBe("completed");
      expect(result.output).toContain("local-response");
      expect(existsSync(join(workspace, "allowed.txt"))).toBe(true);
      // The temp root is writable too — a contained command still needs
      // somewhere to put a scratch file, and that is not a leak.
      const temp = manager.start(
        'f="${TMPDIR:-/tmp}/rune-temp-probe-$$.txt"; printf inside > "$f" && cat "$f" && rm -f "$f"',
        workspace,
        true,
      );
      const tempResult = await finished(manager, temp.shellId);
      expect(tempResult.status).toBe("completed");
      expect(tempResult.output).toContain("inside");
      const denied = manager.start("printf forbidden > ../outside.txt", workspace, true);
      expect((await finished(manager, denied.shellId)).status).toBe("failed");
      expect(existsSync(join(dir, "outside.txt"))).toBe(false);
      const probe = manager.start("env", workspace, true);
      expect((await finished(manager, probe.shellId)).output).not.toContain("RUNE_TEST_SECRET");
      if (process.platform === "linux") {
        const pid = manager.start("readlink /proc/self/ns/pid", workspace, true);
        const child = await finished(manager, pid.shellId);
        expect(child.status).toBe("completed");
        expect(child.output.trim()).not.toBe(readlinkSync("/proc/self/ns/pid"));
        const caps = manager.start("grep '^CapEff:' /proc/self/status", workspace, true);
        expect((await finished(manager, caps.shellId)).output).toMatch(/CapEff:\s+0+\s*$/);
      }
    } finally {
      server.stop(true);
      if (oldSecret === undefined) delete process.env.RUNE_TEST_SECRET;
      else process.env.RUNE_TEST_SECRET = oldSecret;
    }
  },
);

test.skipIf(!native)(
  "killing a background shell kills the descendants it left behind, not only the leader",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-bg-cleanup-"));
    dirs.push(dir);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const manager = new BackgroundShellManager(binary);
    managers.push(manager);
    setSandboxMode("on");
    // A grandchild that outlives a leader-only kill and says so by growing a
    // file. `wait` keeps the leader alive so the kill has a real tree to take.
    const started = manager.start(
      "(while true; do printf . >> ticks.txt; sleep 0.05; done) & wait",
      workspace,
      false,
    );
    expect(started.sandboxed).toBe(true);
    const ticks = join(workspace, "ticks.txt");
    for (let i = 0; i < 150 && !existsSync(ticks); i++) await Bun.sleep(20);
    expect(existsSync(ticks)).toBe(true);

    expect(manager.kill(started.shellId).found).toBe(true);
    await Bun.sleep(400);
    const settled = statSync(ticks).size;
    await Bun.sleep(600);
    expect(statSync(ticks).size).toBe(settled);
    expect(manager.read(started.shellId).status).not.toBe("running");
  },
  30_000,
);

test.skipIf(!native)(
  "a foreground sandboxed command that times out leaves no descendant running",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-fg-cleanup-"));
    dirs.push(dir);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const marker = join(workspace, "grandchild-alive");
    // The same shape the crate tests unsandboxed, through the SANDBOXED
    // foreground path: macOS kills the process group, Linux tears down the
    // bwrap PID namespace, and neither may leave this touch to land.
    const proc = Bun.spawnSync([binary, "--sandbox", "--workspace", workspace, "bash"], {
      stdin: new TextEncoder().encode(
        JSON.stringify({ command: `(sleep 2 && touch ${marker}) & wait`, timeout_ms: 400 }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      success?: boolean;
      result?: { sandboxed?: boolean; timed_out?: boolean };
    };
    expect(parsed.success).toBe(true);
    expect(parsed.result?.sandboxed).toBe(true);
    expect(parsed.result?.timed_out).toBe(true);
    await Bun.sleep(2_500);
    expect(existsSync(marker)).toBe(false);
  },
  30_000,
);

// ─── Where a contained shell's Bun keeps its install cache ───
//
// 2026-10-05, a live run: `bun add smol-toml` with a network granted failed
// twice with "unable to write files to tempdir". Bun's cache is under the home
// directory, which no contained shell may write, and Bun names the wrong
// directory when it says why. A contained shell is now told to keep that cache
// inside the workspace — the one place it could always write.

test.skipIf(!native)(
  "a foreground sandboxed shell is given a Bun cache inside the workspace, and can write it",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-bun-cache-"));
    dirs.push(dir);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const proc = Bun.spawnSync([binary, "--sandbox", "--workspace", workspace, "bash"], {
      stdin: new TextEncoder().encode(
        JSON.stringify({
          command:
            'mkdir -p "$BUN_INSTALL_CACHE_DIR" && echo cached > "$BUN_INSTALL_CACHE_DIR/probe" && printf %s "$BUN_INSTALL_CACHE_DIR"',
          timeout_ms: 15_000,
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      success?: boolean;
      result?: { sandboxed?: boolean; exit_code?: number; stdout?: string; stderr?: string };
    };
    expect(parsed.success).toBe(true);
    expect(parsed.result?.sandboxed).toBe(true);
    expect([parsed.result?.exit_code, parsed.result?.stderr]).toEqual([0, ""]);
    expect(parsed.result?.stdout).toEndWith(join("workspace", "node_modules", ".cache", "bun"));
    expect(existsSync(join(workspace, "node_modules", ".cache", "bun", "probe"))).toBe(true);
  },
  30_000,
);

test.skipIf(!native)(
  "a background sandboxed shell is given the same one",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-bun-cache-bg-"));
    dirs.push(dir);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const manager = new BackgroundShellManager(binary);
    managers.push(manager);
    setSandboxMode("on");
    const started = manager.start('printf %s "$BUN_INSTALL_CACHE_DIR"', workspace, false);
    expect(started.sandboxed).toBe(true);
    const done = await finished(manager, started.shellId);
    expect(done.status).toBe("completed");
    expect(done.output).toEndWith(join("workspace", "node_modules", ".cache", "bun"));
  },
  30_000,
);

test("a missing native planner cannot silently launch a host background process", () => {
  setSandboxMode("on");
  for (const unavailable of [undefined, "/nonexistent/rune-tools"]) {
    const manager = new BackgroundShellManager(unavailable);
    managers.push(manager);
    expect(() => manager.start("echo never", "/tmp", true)).toThrow();
    expect(manager.list()).toEqual([]);
  }
});
