// ─── /connectors: the rows each screen shows, and the actions each row gets ───

import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import {
  SHELVES,
  detailScreen,
  homeScreen,
  mergeHits,
  sameActionIndex,
  searchScreen,
  shelfScreen,
} from "../../../packages/orchestrator/src/bin/ui/connectors-picker";
import type { ConnectorRow } from "../../../packages/orchestrator/src/connectors";
import {
  CONNECTOR_DIRECTORY,
  directoryEntry,
} from "../../../packages/tool-registry/src/mcp/directory";
import type { McpServerStatus } from "../../../packages/tool-registry/src/mcp/discovery";

const up = (name: string, tools: string[] = ["a", "b"]): McpServerStatus => ({
  name,
  ready: true,
  kind: "http",
  toolCount: tools.length,
  tools,
  health: "healthy",
});

const vercel: ConnectorRow = {
  name: "vercel",
  source: "user",
  config: { type: "http", url: "https://mcp.vercel.com" },
  status: up("vercel", ["list_projects", "get_deployment", "search_docs"]),
};
const github: ConnectorRow = {
  name: "github",
  source: "workspace",
  config: {
    type: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer ${keychain:mcp-token:github}" },
  },
  status: { ...up("github", []), ready: false, needsAuth: true, health: "down" },
};
const supabaseOff: ConnectorRow = {
  name: "supabase",
  source: "user",
  config: { type: "http", url: "https://mcp.supabase.com/mcp?read_only=true", enabled: false },
};

const labels = (items: Array<{ label: string }>) => items.map((i) => i.label);

describe("home", () => {
  test("lists what is on file, then the four shelves, search, and by-address", () => {
    const screen = homeScreen([vercel, github]);
    expect(labels(screen.items)).toEqual([
      "Vercel",
      "GitHub",
      "Developer tools",
      "Docs and search",
      "Work and planning",
      "Design",
      "Search everything",
      "By address or command",
    ]);
    expect(screen.choices.map((c) => c.kind)).toEqual([
      "connector",
      "connector",
      ...SHELVES.map(() => "shelf"),
      "search",
      "custom",
    ]);
    expect(screen.title).toBe("Connectors · 1 connected · 1 needs attention");
  });

  test("each row says its state, its tools and where it applies", () => {
    const [v, g] = homeScreen([vercel, github]).items;
    expect(v!.hint).toBe("connected · 3 tools");
    expect(v!.tags).toEqual(["every project"]);
    expect(g!.hint).toBe("needs sign-in");
    expect(g!.tags).toEqual(["this project"]);
    expect(g!.description).toBe("enter, then sign in");
  });

  test("an empty home still offers every way in", () => {
    const screen = homeScreen([]);
    expect(screen.title).toBe("Connectors · none yet");
    expect(screen.items).toHaveLength(SHELVES.length + 2);
  });
});

describe("a shelf", () => {
  test("lists that category's checked services and how each signs in", () => {
    const screen = shelfScreen("developer", [vercel]);
    const ids = screen.choices.map((e) => e.id);
    expect(ids).toEqual(
      CONNECTOR_DIRECTORY.filter((e) => e.category === "developer").map((e) => e.id),
    );
    const gh = screen.items[ids.indexOf("github")]!;
    expect(gh.hint).toContain("paste a personal access token");
    expect(screen.items[ids.indexOf("render")]!.hint).toContain("paste an API key");
    const v = screen.items[ids.indexOf("vercel")]!;
    expect(v.current).toBe(true);
    expect(v.tags).toEqual(["connected"]);
    // A vendor that may refuse the sign-in says so before anyone tries.
    expect(v.description).toContain("only lets AI apps it has reviewed");
  });
});

describe("search", () => {
  test("a bundled entry with a checked twin is dropped for the checked one", () => {
    const hits = mergeHits(
      [directoryEntry("notion")!],
      [
        { name: "notion", url: "https://mcp.notion.com/mcp", source: "vendored" },
        { name: "acme", url: "https://acme.example/mcp", source: "registry" },
        { name: "slack", source: "vendored", closed: "partner apps only" },
      ],
    );
    expect(hits.map((h) => (h.kind === "checked" ? h.entry.id : h.entry.name))).toEqual([
      "notion",
      "acme",
      "slack",
    ]);
    const screen = searchScreen("x", hits);
    expect(screen.items.map((i) => i.tags?.[0])).toEqual([
      "checked",
      "registry, not checked",
      "closed",
    ]);
    expect(screen.items[2]!.description).toBe("partner apps only");
  });
});

describe("one connector's actions", () => {
  test("a browser sign-in service: reconnect, sign in, its tools, the file moves", () => {
    const screen = detailScreen(vercel, true);
    expect(labels(screen.items)).toEqual([
      "Reconnect",
      "Sign in again",
      "Sign out",
      "Turn off",
      "Use in this project only",
      "Tools",
      "Remove",
    ]);
    expect(stripAnsi(screen.footnote)).toBe("every project · https://mcp.vercel.com");
  });

  test("a token service replaces its token instead of opening a browser", () => {
    const items = labels(detailScreen(github, false).items);
    expect(items).toContain("Replace personal access token");
    expect(items).not.toContain("Sign in");
    expect(items).toContain("Use in every project");
  });

  test("settings read from the address; an off connector cannot be reconnected", () => {
    const items = labels(detailScreen(supabaseOff, false).items);
    expect(items).toContain("Read-only: on");
    expect(items).toContain("Project: every project");
    expect(items).toContain("Turn on");
    expect(items).not.toContain("Reconnect");
  });

  test("a plugin's or the built-in browser's connector is managed elsewhere", () => {
    const plugin: ConnectorRow = {
      name: "acme",
      source: "plugin",
      plugin: "acme-tools",
      config: { command: "acme-mcp" },
      status: up("acme"),
    };
    const items = labels(detailScreen(plugin, false).items);
    expect(items).toContain("Managed by plugin acme-tools");
    expect(items).not.toContain("Remove");
    expect(items).not.toContain("Turn off");
    const browser: ConnectorRow = {
      name: "browser",
      source: "built-in",
      config: { command: "bunx" },
    };
    expect(labels(detailScreen(browser, false).items)).toContain("Managed by /browser");
  });
});

describe("after an action, the cursor stays on it", () => {
  test("even when the rows above it went away", () => {
    // Signed in: "Sign out" is there. Signed out: it is gone, and every row
    // below it moves up one.
    const before = detailScreen(vercel, true);
    const turnOff = before.choices.findIndex((a) => a.kind === "enable");
    const after = detailScreen(vercel, false);
    const i = sameActionIndex(after.choices, before.choices[turnOff]!);
    expect(after.items[i]!.label).toBe("Turn off");
    expect(i).toBe(turnOff - 1);
  });

  test("a setting is found by its own id, and a vanished action starts at the top", () => {
    const supabaseOn: ConnectorRow = {
      ...supabaseOff,
      config: { ...supabaseOff.config, enabled: true },
    };
    const screen = detailScreen(supabaseOn, false);
    const project = screen.choices.find(
      (a) => a.kind === "option" && a.option.id === "project_ref",
    )!;
    expect(screen.items[sameActionIndex(screen.choices, project)]!.label).toBe(
      "Project: every project",
    );
    expect(sameActionIndex(detailScreen(github, false).choices, { kind: "tools" })).toBe(0);
    expect(sameActionIndex(screen.choices, null)).toBe(0);
  });
});
