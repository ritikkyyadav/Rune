import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { CommandVerifier, detectVerifyCommands } from "../../../packages/orchestrator/src/verifier";

async function tmpWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gear-verify-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

describe("detectVerifyCommands", () => {
  test("package.json typecheck+test scripts + bun.lock → bun run typecheck, bun test", async () => {
    const dir = await tmpWorkspace({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "bun test" } }),
      "bun.lock": "",
    });
    expect(detectVerifyCommands(dir)).toEqual(["bun run typecheck", "bun test"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("tsconfig only, no manifest → npx tsc --noEmit", async () => {
    const dir = await tmpWorkspace({ "tsconfig.json": "{}" });
    expect(detectVerifyCommands(dir)).toEqual(["npx tsc --noEmit"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("raw test files, no manifest → bun test", async () => {
    const dir = await tmpWorkspace({ "thing.test.ts": "// test" });
    expect(detectVerifyCommands(dir)).toEqual(["bun test"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("Cargo.toml → cargo check, then cargo test (P10.4)", async () => {
    const dir = await tmpWorkspace({ "Cargo.toml": "[package]" });
    expect(detectVerifyCommands(dir)).toEqual(["cargo check --quiet", "cargo test --quiet"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("empty workspace → no commands", async () => {
    const dir = await tmpWorkspace({});
    expect(detectVerifyCommands(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * POSIX-only. `CommandVerifier` runs each check through `Bun.spawn(["bash", "-c", …])` (verifier.ts:280).
 *
 * Gear has no Windows shell contract yet — nothing decides whether a command
 * string means cmd.exe, PowerShell or Git Bash — so there is no Windows
 * behaviour to assert, only a decision to make. Logged in
 * docs/program/backlog.md.
 */
const POSIX_SHELL = process.platform !== "win32";

describe.skipIf(!POSIX_SHELL)("CommandVerifier", () => {
  test("passing command → passed:true, ran:true", async () => {
    const dir = await tmpWorkspace({});
    const r = await new CommandVerifier({ workspaceRoot: dir, commands: ["true"] }).verify();
    expect(r.passed).toBe(true);
    expect(r.ran).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("failing command → passed:false with exit code + output in report", async () => {
    const dir = await tmpWorkspace({});
    const r = await new CommandVerifier({
      workspaceRoot: dir,
      commands: ["echo boom >&2; exit 3"],
    }).verify();
    expect(r.passed).toBe(false);
    expect(r.ran).toBe(true);
    expect(r.report).toContain("exit 3");
    expect(r.report).toContain("boom");
    await rm(dir, { recursive: true, force: true });
  });

  test("stops at the first failing command", async () => {
    const dir = await tmpWorkspace({});
    const r = await new CommandVerifier({
      workspaceRoot: dir,
      commands: ["exit 1", "echo SHOULD_NOT_RUN"],
    }).verify();
    expect(r.passed).toBe(false);
    expect(r.report).not.toContain("SHOULD_NOT_RUN");
    await rm(dir, { recursive: true, force: true });
  });

  test("no detected commands → passed:true, ran:false", async () => {
    const dir = await tmpWorkspace({ "readme.md": "# nothing to verify" });
    const r = await new CommandVerifier({ workspaceRoot: dir }).verify();
    expect(r.passed).toBe(true);
    expect(r.ran).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("timeout → passed:false with 'timed out' in report", async () => {
    const dir = await tmpWorkspace({});
    const r = await new CommandVerifier({
      workspaceRoot: dir,
      commands: ["sleep 5"],
      timeoutMs: 200,
    }).verify();
    expect(r.passed).toBe(false);
    expect(r.report).toContain("timed out");
    await rm(dir, { recursive: true, force: true });
  });
});
