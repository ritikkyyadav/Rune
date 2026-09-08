import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BackgroundShellManager } from "../../packages/tool-registry/src/tools/background";
import { setSandboxMode } from "../../packages/tool-registry/src/sandbox-mode";

const binary = resolve(process.env.RUNE_TOOLS_BINARY ?? "target/debug/rune-tools");
const native = existsSync(binary) && ["darwin", "linux"].includes(process.platform);
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
      const denied = manager.start("printf forbidden > ../outside.txt", workspace, true);
      expect((await finished(manager, denied.shellId)).status).toBe("failed");
      expect(existsSync(join(dir, "outside.txt"))).toBe(false);
      const probe = manager.start("env", workspace, true);
      expect((await finished(manager, probe.shellId)).output).not.toContain("RUNE_TEST_SECRET");
    } finally {
      server.stop(true);
      if (oldSecret === undefined) delete process.env.RUNE_TEST_SECRET;
      else process.env.RUNE_TEST_SECRET = oldSecret;
    }
  },
);

test("a missing native planner cannot silently launch a host background process", () => {
  setSandboxMode("on");
  const manager = new BackgroundShellManager("/nonexistent/rune-tools");
  managers.push(manager);
  expect(() => manager.start("echo never", "/tmp", true)).toThrow();
  expect(manager.list()).toEqual([]);
});
