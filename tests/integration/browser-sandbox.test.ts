import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.env.RUNE_TOOLS_BINARY ?? "target/debug/rune-tools");
// Opt in with an already installed runtime. This test never downloads browsers.
const playwright = process.env.RUNE_TEST_PLAYWRIGHT;
const available = process.platform === "darwin" && existsSync(binary) && !!playwright;

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const kill = (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {}
      }
    };
    const timeout = setTimeout(() => kill(), 25_000);
    const hardTimeout = setTimeout(() => kill("SIGKILL"), 27_000);
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    // Same bridge as the comparison runner: the installed Bun declarations
    // omit ChildProcess's inherited EventEmitter methods in standalone tsc.
    const events = child as unknown as {
      on(event: "error", listener: (error: Error) => void): void;
      on(event: "close", listener: (code: number | null) => void): void;
    };
    events.on("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(hardTimeout);
      reject(error);
    });
    events.on("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(hardTimeout);
      kill();
      done({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

for (const mode of ["foreground", "background-plan"] as const) {
  test.skipIf(!available)(
    `Chromium verifies a local page under the ${mode} sandbox with path denials intact`,
    async () => {
      // /tmp is intentionally writable by the sandbox. A sibling in HOME proves
      // that browser support does not make the rest of the filesystem writable.
      const root = mkdtempSync(join(homedir(), ".rune-browser-test-"));
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      const denied = join(root, "synthetic-secret.txt");
      const outside = join(root, "outside.txt");
      const controls = join(workspace, "controls");
      mkdirSync(controls);
      writeFileSync(denied, "synthetic-secret-never-readable");
      writeFileSync(
        join(workspace, "verify.mjs"),
        `import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from ${JSON.stringify(playwright)};
assert.equal(process.env.RUNE_BROWSER_TEST_SECRET, undefined);
assert.throws(() => readFileSync(${JSON.stringify(denied)}));
assert.throws(() => writeFileSync(${JSON.stringify(outside)}, 'forbidden'));
assert.throws(() => writeFileSync(${JSON.stringify(join(controls, "policy.txt"))}, 'forbidden'));
const server = createServer((req, res) => res.end(${JSON.stringify("<button onclick=\"this.textContent='Done'\">Run</button>")}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({headless:true, timeout:10_000});
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('button', {name:'Run'}).click();
  assert.equal(await page.getByRole('button').textContent(), 'Done');
  await page.screenshot({path:'desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'mobile.png'});
  assert.throws(() => readFileSync(${JSON.stringify(denied)}));
  assert.throws(() => writeFileSync(${JSON.stringify(outside)}, 'forbidden'));
  console.log('BROWSER_AND_CONTAINMENT_OK');
} finally { if (browser) await browser.close(); server.closeAllConnections(); server.close(); }
`,
      );
      const env = { ...process.env, RUNE_BROWSER_TEST_SECRET: "synthetic-env-secret" };
      const input = JSON.stringify({
        command: "node verify.mjs",
        timeout_ms: 20_000,
        network: false,
        sandbox_paths: { deny_read: [denied], deny_write: [controls] },
      });
      try {
        if (mode === "foreground") {
          const result = await run(
            [binary, "--workspace", workspace, "--sandbox", "bash"],
            workspace,
            env,
            input,
          );
          expect(result.code, result.stderr).toBe(0);
          const reply = JSON.parse(result.stdout);
          expect(reply.success).toBe(true);
          expect(reply.result.sandboxed).toBe(true);
          expect(reply.result.exit_code, String(reply.result.stderr)).toBe(0);
          expect(reply.result.stdout).toContain("BROWSER_AND_CONTAINMENT_OK");
        } else {
          const planned = spawnSync(binary, ["--workspace", workspace, "shell-plan"], {
            input,
            env,
            encoding: "utf8",
            timeout: 5_000,
          });
          expect(planned.status, planned.stderr).toBe(0);
          const plan = JSON.parse(planned.stdout).result;
          expect(plan.sandboxed).toBe(true);
          const result = await run([plan.program, ...plan.args], workspace, plan.env);
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toContain("BROWSER_AND_CONTAINMENT_OK");
        }
        expect(existsSync(join(workspace, "desktop.png"))).toBe(true);
        expect(existsSync(join(workspace, "mobile.png"))).toBe(true);
        expect(existsSync(outside)).toBe(false);
        expect(existsSync(join(controls, "policy.txt"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
}
