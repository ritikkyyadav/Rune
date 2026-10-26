// ─── What `/connectors` writes, and what it refuses to ───
//
// Every action goes to the two config files and the credential store `rune
// mcp` uses. A throwaway RUNE_HOME and the file backend keep the real
// keychain out of it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../../../packages/shared/src/credential-store";
import { resetRuneHomeCache } from "../../../packages/shared/src/paths";
import { directoryEntry, mcpTokenAccount } from "../../../packages/tool-registry/src/mcp/directory";
import { mcpCredentialAccount } from "../../../packages/tool-registry/src/mcp/oauth";
import {
  mcpConfigPath,
  mergedServers,
  upsertServer,
} from "../../../packages/tool-registry/src/mcp/config-file";
import {
  addDirectoryConnector,
  cleanName,
  connectorState,
  customConnector,
  entryFor,
  forgetSignIn,
  hasSignIn,
  moveConnector,
  removeConnector,
  setConnectorEnabled,
  setConnectorOption,
  setConnectorToken,
  signInOf,
  type ConnectorRow,
} from "../../../packages/orchestrator/src/connectors";

const FAKE_TOKEN = "test-only-not-a-real-token";

let home: string;
let workspace: string;
let store: FileCredentialStore;
let saved: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rune-connectors-home-"));
  workspace = mkdtempSync(join(tmpdir(), "rune-connectors-ws-"));
  saved = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  resetRuneHomeCache();
  store = new FileCredentialStore({ ...process.env, RUNE_HOME: home });
});

afterEach(() => {
  if (saved === undefined) delete process.env.RUNE_HOME;
  else process.env.RUNE_HOME = saved;
  resetRuneHomeCache();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** The row a config-file entry reads as, the way the engine lists it. */
function rowOf(name: string): ConnectorRow {
  const s = mergedServers(workspace).servers.find((x) => x.name === name);
  if (!s) throw new Error(`${name} not on file`);
  return { name: s.name, source: s.scope, config: s.config, shadowed: s.shadowed };
}

const userFile = () => readFileSync(mcpConfigPath("user", workspace), "utf8");

describe("adding a checked service", () => {
  test("a token goes to the keychain; the file names the account and never holds it", async () => {
    const out = await addDirectoryConnector(directoryEntry("github")!, {
      workspaceRoot: workspace,
      store,
      token: `  ${FAKE_TOKEN}\n`,
    });
    expect(out).toMatchObject({ name: "github", scope: "user" });
    expect(await store.get(mcpTokenAccount("github"))).toBe(FAKE_TOKEN);
    expect(userFile()).not.toContain(FAKE_TOKEN);
    expect(userFile()).toContain("${keychain:mcp-token:github}");
    expect(signInOf(rowOf("github"))).toBe("token");
  });

  test("a required token that is missing writes nothing", async () => {
    await expect(
      addDirectoryConnector(directoryEntry("github")!, { workspaceRoot: workspace, store }),
    ).rejects.toThrow("personal access token");
    expect(existsSync(mcpConfigPath("user", workspace))).toBe(false);
  });

  test("an optional token left out: no header, no sign-in attempt", async () => {
    await addDirectoryConnector(directoryEntry("context7")!, { workspaceRoot: workspace, store });
    const row = rowOf("context7");
    expect(row.config.headers).toBeUndefined();
    expect(signInOf(row)).toBe("none");
    // Given later, it gains the header and loses the opt-out.
    await setConnectorToken(row, FAKE_TOKEN, workspace, store);
    const after = rowOf("context7");
    expect(signInOf(after)).toBe("token");
    expect(after.config.oauth).toBeUndefined();
    expect(await store.get(mcpTokenAccount("context7"))).toBe(FAKE_TOKEN);
  });

  test("a browser sign-in service is written with no secret at all", async () => {
    await addDirectoryConnector(directoryEntry("vercel")!, { workspaceRoot: workspace, store });
    const row = rowOf("vercel");
    expect(row.config).toEqual({ type: "http", url: "https://mcp.vercel.com" });
    expect(signInOf(row)).toBe("oauth");
    expect(entryFor(row)?.id).toBe("vercel");
  });
});

describe("what a row is", () => {
  test("a hand-added server that only shares a name is not offered the entry's settings", () => {
    upsertServer("user", workspace, "supabase", {
      type: "http",
      url: "https://db.example.com/mcp",
    });
    expect(entryFor(rowOf("supabase"))).toBeUndefined();
    expect(() => setConnectorOption(rowOf("supabase"), "read_only", true, workspace)).toThrow();
  });

  test("its sign-in, read from the config", () => {
    const row = (config: ConnectorRow["config"]): ConnectorRow => ({
      name: "x",
      source: "user",
      config,
    });
    expect(signInOf(row({ command: "npx" }))).toBe("local");
    expect(signInOf(row({ url: "https://a.example/mcp" }))).toBe("oauth");
    expect(signInOf(row({ url: "https://a.example/mcp", oauth: { enabled: false } }))).toBe("none");
    expect(
      signInOf(
        row({ url: "https://a.example/mcp", headers: { Authorization: "Bearer ${TOKEN}" } }),
      ),
    ).toBe("header");
  });

  test("its state, in the person's words", () => {
    const base: ConnectorRow = { name: "x", source: "user", config: { url: "https://a.example" } };
    const status = {
      name: "x",
      kind: "http" as const,
      toolCount: 3,
      tools: [],
      health: "healthy" as const,
    };
    expect(connectorState({ ...base, config: { ...base.config, enabled: false } })).toBe("off");
    expect(connectorState(base)).toBe("not started");
    expect(connectorState({ ...base, status: { ...status, ready: true } })).toBe("connected");
    expect(connectorState({ ...base, status: { ...status, ready: false, needsAuth: true } })).toBe(
      "needs sign-in",
    );
    expect(
      connectorState({
        ...base,
        status: { ...status, ready: false, health: "down", lastError: "boom" },
      }),
    ).toBe("down");
    expect(connectorState({ ...base, status: { ...status, ready: false, lastError: null } })).toBe(
      "connecting",
    );
  });
});

describe("changing settings", () => {
  test("a setting changes only itself in the address on file", async () => {
    await addDirectoryConnector(directoryEntry("supabase")!, { workspaceRoot: workspace, store });
    upsertServer("user", workspace, "supabase", {
      type: "http",
      url: "https://mcp.supabase.com/mcp?features=database",
    });
    const url = setConnectorOption(rowOf("supabase"), "read_only", true, workspace);
    expect(new URL(url).searchParams.get("features")).toBe("database");
    expect(new URL(rowOf("supabase").config.url!).searchParams.get("read_only")).toBe("true");
  });

  test("off keeps the entry; on brings it back", async () => {
    await addDirectoryConnector(directoryEntry("linear")!, { workspaceRoot: workspace, store });
    expect(setConnectorEnabled(rowOf("linear"), false, workspace)).toBe("user");
    expect(rowOf("linear").config.enabled).toBe(false);
    setConnectorEnabled(rowOf("linear"), true, workspace);
    expect(rowOf("linear").config.enabled).toBeUndefined();
  });

  test("a plugin's connector is not edited here", () => {
    const plugin: ConnectorRow = {
      name: "p",
      source: "plugin",
      plugin: "x",
      config: { command: "x" },
    };
    expect(setConnectorEnabled(plugin, false, workspace)).toBeNull();
    expect(moveConnector(plugin, "user", workspace)).toBe(false);
  });

  test("moving between every project and this project", async () => {
    await addDirectoryConnector(directoryEntry("linear")!, { workspaceRoot: workspace, store });
    expect(moveConnector(rowOf("linear"), "workspace", workspace)).toBe(true);
    expect(rowOf("linear").source).toBe("workspace");
    expect(existsSync(join(workspace, ".rune", "mcp.json"))).toBe(true);
  });
});

describe("signing out and removing", () => {
  test("sign-out forgets both kinds of sign-in", async () => {
    await store.set(mcpCredentialAccount("x"), "{}");
    await store.set(mcpTokenAccount("x"), FAKE_TOKEN);
    expect(await hasSignIn("x", store)).toBe(true);
    expect(await forgetSignIn("x", store)).toBe(true);
    expect(await hasSignIn("x", store)).toBe(false);
    expect(await forgetSignIn("x", store)).toBe(false);
  });

  test("remove forgets the sign-in when nothing else uses it", async () => {
    await addDirectoryConnector(directoryEntry("github")!, {
      workspaceRoot: workspace,
      store,
      token: FAKE_TOKEN,
    });
    const out = await removeConnector(rowOf("github"), workspace, store);
    expect(out).toEqual({ removed: true, forgot: true, stillOnFile: null });
    expect(await store.get(mcpTokenAccount("github"))).toBeNull();
  });

  test("remove keeps it while an entry of the same name is still on file", async () => {
    await addDirectoryConnector(directoryEntry("github")!, {
      workspaceRoot: workspace,
      store,
      token: FAKE_TOKEN,
    });
    upsertServer("workspace", workspace, "github", rowOf("github").config);
    const out = await removeConnector(rowOf("github"), workspace, store);
    expect(out.stillOnFile).toBe("user");
    expect(await store.get(mcpTokenAccount("github"))).toBe(FAKE_TOKEN);
  });
});

describe("a server typed by hand", () => {
  test("an address is named for its domain", () => {
    expect(customConnector("https://mcp.example.com/mcp")).toEqual({
      name: "example",
      config: { type: "http", url: "https://mcp.example.com/mcp" },
    });
  });

  test("a command is named for what it runs", () => {
    expect(customConnector("npx -y @acme/thing-mcp@latest")?.name).toBe("thing-mcp");
    expect(customConnector("./tools/server.js --port 3")?.config).toEqual({
      command: "./tools/server.js",
      args: ["--port", "3"],
    });
    expect(customConnector("   ")).toBeNull();
  });

  test("names stay safe as a tool prefix", () => {
    expect(cleanName("My Server!")).toBe("my-server");
    expect(cleanName("---")).toBe("server");
  });
});
