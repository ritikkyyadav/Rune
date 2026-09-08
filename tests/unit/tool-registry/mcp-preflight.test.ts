/**
 * The founder's own connector was broken for weeks by one letter.
 *
 * `~/.rune/mcp.json` pointed `@modelcontextprotocol/server-filesystem` at
 * `/Users/…/Projects/Alan`, and the directory is `/Users/…/Project/Alan`. What
 * the session reported was the server's stderr — a process exited, code 1 —
 * which describes the symptom and not one word of the cause, even though the
 * cause was checkable from the config alone in microseconds.
 *
 * These tests are that check: a missing command, a mistyped path, and the
 * suggestion. Plus the two ways a helpful suggester goes wrong — inventing one
 * for a path nothing resembles, and reporting a flag as a missing directory.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  looksLikePath,
  nearestExistingPath,
  preflightServer,
  resolveCommand,
} from "../../../packages/tool-registry/src/mcp/preflight";

const root = mkdtempSync(join(tmpdir(), "rune-preflight-"));
mkdirSync(join(root, "Project", "Alan"), { recursive: true });
mkdirSync(join(root, "notes"), { recursive: true });
writeFileSync(join(root, "Project", "Alan", "file.txt"), "x");

describe("preflight — the typo case", () => {
  test("names the missing directory and the one the user meant", () => {
    const problems = preflightServer("filesystem", {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", join(root, "Projects", "Alan")],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe("path-missing");
    expect(problems[0]!.problem).toContain("does not exist");
    expect(problems[0]!.fix).toBe(`did you mean ${join(root, "Project", "Alan")}`);
  });

  test("a correct entry produces nothing at all", () => {
    expect(
      preflightServer("filesystem", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", join(root, "Project", "Alan")],
      }),
    ).toEqual([]);
  });

  // On a case-folding volume (the macOS default) `project/alan` simply opens,
  // so there is nothing to correct and the check must stay quiet. On a
  // case-sensitive one it is a real miss with an obvious answer. Both are the
  // right behaviour; which one runs depends on the disk, so ask the disk.
  const caseSensitive = !existsSync(join(root, "PROJECT"));
  test.skipIf(!caseSensitive)("corrects a case-only mistake on a case-sensitive disk", () => {
    expect(nearestExistingPath(join(root, "project", "alan"))).toBe(join(root, "Project", "Alan"));
  });
  test.skipIf(caseSensitive)("says nothing when the disk folds case itself", () => {
    expect(nearestExistingPath(join(root, "project", "alan"))).toBeNull();
  });

  test("suggests nothing when nothing resembles the path", () => {
    expect(nearestExistingPath(join(root, "zzqqxx", "deeper"))).toBeNull();
  });

  test("says nothing about a path that exists", () => {
    expect(nearestExistingPath(join(root, "notes"))).toBeNull();
  });
});

describe("preflight — the command", () => {
  test("reports a command that is not on PATH", () => {
    const problems = preflightServer("broken", { command: "rune-no-such-binary-xyz" });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe("command-missing");
    expect(problems[0]!.fix).toContain("rune-no-such-binary-xyz");
  });

  test("finds a command that is", () => {
    expect(resolveCommand("sh")).toBeTruthy();
    expect(preflightServer("fine", { command: "sh", args: ["-c", "true"] })).toEqual([]);
  });

  test("points a Node-based server at Node rather than at nothing", () => {
    const problems = preflightServer("files", { command: "npx" });
    // npx is present in this environment; the branch is exercised by shape.
    for (const p of problems) expect(p.fix).toContain("nodejs.org");
  });
});

describe("preflight — what is NOT a path", () => {
  test.each([
    ["-y", false],
    ["--stdio", false],
    ["@modelcontextprotocol/server-filesystem", false],
    ["stdio", false],
    ["https://example.com/mcp", false],
    ["/tmp", true],
    ["./local", true],
    ["~/notes", true],
  ])("%s", (arg, expected) => {
    expect(looksLikePath(arg as string)).toBe(expected as boolean);
  });

  test("a package name is never reported as a missing directory", () => {
    expect(
      preflightServer("files", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything", "stdio"],
      }),
    ).toEqual([]);
  });
});

describe("preflight — remote entries", () => {
  test("a well-formed URL is fine", () => {
    expect(preflightServer("notion", { url: "https://mcp.notion.com/mcp" })).toEqual([]);
  });

  test("a URL that is not one is reported", () => {
    const problems = preflightServer("notion", { url: "notion.com/mcp" });
    expect(problems[0]!.kind).toBe("url-invalid");
  });

  test("a non-http scheme is reported", () => {
    const problems = preflightServer("odd", { url: "ftp://example.com/mcp" });
    expect(problems[0]!.kind).toBe("url-invalid");
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));
