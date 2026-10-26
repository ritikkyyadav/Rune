// ─── `rune mcp` and the checked directory ───
//
// The shell command and `/connectors` write the same files and the same
// keychain accounts; these drive `runMcp`, the function `rune mcp` dispatches
// to, with the terminal's token prompt replaced by a value handed in.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcp } from "../../packages/orchestrator/src/bin/mcp-cli";
import { FileCredentialStore } from "../../packages/shared/src/credential-store";
import { resetRuneHomeCache } from "../../packages/shared/src/paths";
import { mcpTokenAccount } from "../../packages/tool-registry/src/mcp/directory";

const FAKE_TOKEN = "test-only-not-a-real-token";

let home: string;
let workspace: string;
let output: string[];
let writeSpy: typeof process.stdout.write;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rune-mcp-dir-home-"));
  workspace = mkdtempSync(join(tmpdir(), "rune-mcp-dir-ws-"));
  for (const k of ["RUNE_HOME", "RUNE_CREDENTIAL_BACKEND", "RUNE_MCP_REGISTRY"])
    saved[k] = process.env[k];
  process.env.RUNE_HOME = home;
  process.env.RUNE_CREDENTIAL_BACKEND = "file";
  process.env.RUNE_MCP_REGISTRY = "off";
  resetRuneHomeCache();
  output = [];
  writeSpy = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = writeSpy;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetRuneHomeCache();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const printed = () => output.join("");
const store = () => new FileCredentialStore({ ...process.env, RUNE_HOME: home });

describe("services Rune cannot connect to", () => {
  test("are refused with the reason, and nothing is written", async () => {
    for (const name of ["slack", "gmail"]) {
      output.length = 0;
      expect(await runMcp(["add", name], { workspace, scope: "user" })).toBe(1);
      expect(printed()).toContain("cannot be connected from Rune");
    }
    expect(printed()).toContain("Anthropic for Claude");
    expect(existsSync(join(home, "mcp.json"))).toBe(false);
  });
});

describe("a checked service", () => {
  test("a token service names its keychain account and the next step", async () => {
    expect(await runMcp(["add", "github"], { workspace, scope: "user" })).toBe(0);
    const file = readFileSync(join(home, "mcp.json"), "utf8");
    expect(file).toContain("${keychain:mcp-token:github}");
    expect(file).toContain("https://api.githubcopilot.com/mcp/");
    expect(printed()).toContain("checked 2026-10-26");
    expect(printed()).toContain("rune mcp login github");
    expect(printed()).toContain("github.com/settings/personal-access-tokens");
  });

  test("login stores the pasted token; the file still only names it", async () => {
    await runMcp(["add", "github"], { workspace, scope: "user" });
    output.length = 0;
    const code = await runMcp(
      ["login", "github"],
      { workspace },
      { readSecret: async () => FAKE_TOKEN },
    );
    expect(code).toBe(0);
    expect(await store().get(mcpTokenAccount("github"))).toBe(FAKE_TOKEN);
    expect(readFileSync(join(home, "mcp.json"), "utf8")).not.toContain(FAKE_TOKEN);
    expect(printed()).not.toContain(FAKE_TOKEN);

    output.length = 0;
    expect(await runMcp(["logout", "github"], { workspace })).toBe(0);
    expect(printed()).toContain("forgot the stored sign-in");
    expect(await store().get(mcpTokenAccount("github"))).toBeNull();
  });

  test("an empty paste changes nothing", async () => {
    await runMcp(["add", "github"], { workspace, scope: "user" });
    const code = await runMcp(["login", "github"], { workspace }, { readSecret: async () => "" });
    expect(code).toBe(1);
    expect(await store().get(mcpTokenAccount("github"))).toBeNull();
  });

  test("a vendor that reviews apps is named before the sign-in", async () => {
    expect(await runMcp(["add", "vercel"], { workspace, scope: "user" })).toBe(0);
    expect(printed()).toContain("only lets AI apps it has reviewed");
    expect(printed()).toContain("rune mcp login vercel");
  });
});

describe("the catalog listing", () => {
  test("puts the checked list first and says what is closed", async () => {
    expect(await runMcp(["list"], { workspace, catalog: true })).toBe(0);
    const text = printed();
    const checked = text.indexOf("Checked");
    const closed = text.indexOf("Not available from Rune");
    const bundled = text.indexOf("Bundled catalog");
    expect(checked).toBeGreaterThan(-1);
    expect(closed).toBeGreaterThan(checked);
    expect(bundled).toBeGreaterThan(closed);
    expect(text.slice(checked, closed)).toContain("vercel");
    expect(text.slice(closed, bundled)).toContain("slack");
    // A checked or closed name is not listed again as "not checked".
    expect(text.slice(bundled)).not.toMatch(/\bnotion\b/);
    expect(text.slice(bundled)).not.toMatch(/\bgmail\b/);
  });
});
