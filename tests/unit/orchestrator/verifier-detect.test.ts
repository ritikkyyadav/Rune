/**
 * Phase-3 regression tests: verification detection that can actually SEE real
 * projects. The old detection did a NON-recursive readdir of the workspace
 * root — `tests/` and `src/**` test files were invisible, greenfield apps in a
 * subdirectory were invisible, and monorepos risked double-running.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVerifyCommands } from "../../../packages/orchestrator/src/verifier";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gear-verify-detect-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const pkg = (scripts: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "x", version: "0.0.0", scripts, ...extra });

describe("detectVerifyCommands", () => {
  test("finds test files in nested directories (the old root-readdir miss)", () => {
    writeFileSync(join(dir, "package.json"), pkg());
    mkdirSync(join(dir, "tests", "unit"), { recursive: true });
    writeFileSync(join(dir, "tests", "unit", "math.test.ts"), "// t");
    expect(detectVerifyCommands(dir)).toContain("bun test");
  });

  test("never descends into node_modules", () => {
    writeFileSync(join(dir, "package.json"), pkg());
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dep", "x.test.js"), "// t");
    expect(detectVerifyCommands(dir)).not.toContain("bun test");
  });

  test("monorepo root trusts root scripts only — no raw bun test over the tree", () => {
    writeFileSync(
      join(dir, "package.json"),
      pkg({ typecheck: "turbo typecheck" }, { workspaces: ["packages/*"] }),
    );
    mkdirSync(join(dir, "packages", "a"), { recursive: true });
    writeFileSync(join(dir, "packages", "a", "a.test.ts"), "// t");
    const cmds = detectVerifyCommands(dir);
    expect(cmds).toContain("npm run typecheck");
    expect(cmds).not.toContain("bun test");
  });

  test("a lint script is detected, after the functional checks", () => {
    writeFileSync(join(dir, "package.json"), pkg({ test: "bun test", lint: "eslint ." }));
    const cmds = detectVerifyCommands(dir);
    expect(cmds).toContain("npm run lint");
    expect(cmds.indexOf("npm run lint")).toBeGreaterThan(cmds.indexOf("npm test"));
  });

  test("greenfield app in a subdirectory is detected with a cd prefix", () => {
    // No root manifest — the agent built a self-contained app in ./shop/.
    mkdirSync(join(dir, "shop"), { recursive: true });
    writeFileSync(join(dir, "shop", "package.json"), pkg({ test: "bun test" }));
    const cmds = detectVerifyCommands(dir);
    expect(cmds.some((c) => c.startsWith("cd shop && "))).toBe(true);
  });

  test("two nested apps → one check set each (P10.4)", () => {
    // This used to be "ambiguous → detect nothing", which meant a workspace
    // holding two apps verified as `ran: false`. A workspace with several
    // projects now reports one check set per project; the step check picks the
    // one whose files the step touched.
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    writeFileSync(join(dir, "a", "package.json"), pkg({ test: "bun test" }));
    writeFileSync(join(dir, "b", "package.json"), pkg({ test: "bun test" }));
    expect(detectVerifyCommands(dir).sort()).toEqual(["cd a && npm test", "cd b && npm test"]);
  });

  test("go module gets build + vet; go tests only when test files exist", () => {
    writeFileSync(join(dir, "go.mod"), "module x\n");
    expect(detectVerifyCommands(dir)).toEqual(["go build ./...", "go vet ./..."]);
    writeFileSync(join(dir, "main_test.go"), "package main");
    expect(detectVerifyCommands(dir)).toEqual(["go build ./...", "go test ./...", "go vet ./..."]);
  });

  test("build script is the compile-at-least fallback when nothing else exists", () => {
    writeFileSync(join(dir, "package.json"), pkg({ build: "vite build" }));
    expect(detectVerifyCommands(dir)).toContain("npm run build");
  });
});
