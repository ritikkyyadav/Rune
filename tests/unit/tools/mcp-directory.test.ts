// ─── The connector directory: what `/connectors` offers, and the rules it keeps ───

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATEGORY_LABELS,
  CLOSED_CONNECTORS,
  CONNECTOR_DIRECTORY,
  addressWith,
  claudeOnlyAddress,
  closedConnector,
  directoryConfig,
  directoryEntry,
  fillKeychainRefs,
  isEntryAddress,
  keychainAccountsIn,
  keychainRef,
  mcpTokenAccount,
  optionsIn,
  searchDirectory,
} from "../../../packages/tool-registry/src/mcp/directory";
import {
  loadVendoredCatalog,
  resolveConnector,
} from "../../../packages/tool-registry/src/mcp/catalog";

describe("every directory entry is well-formed", () => {
  test("ids are unique, lowercase, and safe as a tool prefix", () => {
    const ids = CONNECTOR_DIRECTORY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  test("each has exactly one of an https address or a command, and a known shelf", () => {
    for (const e of CONNECTOR_DIRECTORY) {
      expect(Boolean(e.url) !== Boolean(e.command)).toBe(true);
      if (e.url) expect(e.url.startsWith("https://")).toBe(true);
      expect(CATEGORY_LABELS[e.category]).toBeTruthy();
      expect(e.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (e.docs) expect(e.docs.startsWith("https://")).toBe(true);
    }
  });

  test("a token entry says what the token is and where to make one", () => {
    for (const e of CONNECTOR_DIRECTORY) {
      if (e.auth.kind !== "token") continue;
      expect(e.auth.header).toBe("Authorization");
      expect(e.auth.noun.length).toBeGreaterThan(2);
      expect(e.auth.createAt.startsWith("https://")).toBe(true);
    }
  });

  test("nothing closed is also offered", () => {
    for (const c of CLOSED_CONNECTORS) expect(directoryEntry(c.id)).toBeUndefined();
  });
});

describe("Claude-only addresses", () => {
  test("are recognised by host, not by name", () => {
    expect(claudeOnlyAddress("https://gmail.mcp.claude.com/mcp")).toBe(true);
    expect(claudeOnlyAddress("https://mcp.claude.com/x")).toBe(true);
    expect(claudeOnlyAddress("https://mcp.hubspot.com/anthropic")).toBe(true);
    expect(claudeOnlyAddress("https://mcp.hubspot.com/anthropic/")).toBe(true);
  });

  test("a look-alike host or another path is not one", () => {
    expect(claudeOnlyAddress("https://mcp.claude.com.example.org/mcp")).toBe(false);
    expect(claudeOnlyAddress("https://notmcp.claude.com/mcp")).toBe(false);
    expect(claudeOnlyAddress("https://mcp.hubspot.com/mcp")).toBe(false);
    expect(claudeOnlyAddress("not a url")).toBe(false);
    expect(claudeOnlyAddress(undefined)).toBe(false);
  });

  test("every bundled entry pointing at one is closed, whatever it is called", () => {
    const bundled = loadVendoredCatalog();
    const claude = bundled.filter((e) => claudeOnlyAddress(e.url));
    expect(claude.length).toBeGreaterThan(0);
    for (const e of claude) expect(e.closed).toBeTruthy();
  });

  test("a new skill pack's Claude-only entry is closed by its address alone", () => {
    // A name no list knows: only the host can close it.
    const root = mkdtempSync(join(tmpdir(), "rune-skills-"));
    try {
      mkdirSync(join(root, "new-pack"));
      writeFileSync(
        join(root, "new-pack", ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "brand-new-thing": { type: "http", url: "https://newthing.mcp.claude.com/mcp" },
            "open-thing": { type: "http", url: "https://mcp.open.example/mcp" },
          },
        }),
      );
      const bundled = loadVendoredCatalog({ ...process.env, RUNE_SKILLS_DIR: root });
      expect(bundled.find((e) => e.name === "brand-new-thing")?.closed).toContain("Claude");
      expect(bundled.find((e) => e.name === "open-thing")?.closed).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolving a name", () => {
  test("the checked entry wins over the bundled one", async () => {
    const github = await resolveConnector("github", { includeRegistry: false });
    expect(github?.source).toBe("directory");
    expect(github?.url).toBe("https://api.githubcopilot.com/mcp/");
    // The bundled catalog still carries Atlassian's retiring /v1 address.
    const atlassian = await resolveConnector("Atlassian", { includeRegistry: false });
    expect(atlassian?.url).toBe("https://mcp.atlassian.com/v2/mcp");
  });

  test("a closed name resolves to its reason, not an entry to write", async () => {
    const slack = await resolveConnector("slack", { includeRegistry: false });
    expect(slack?.closed).toContain("Slack");
    expect(closedConnector("gmail")?.reason).toContain("Claude");
  });
});

describe("settings live in the address", () => {
  const supabase = directoryEntry("supabase")!;
  const github = directoryEntry("github")!;

  test("off gives back exactly the address the vendor documents", () => {
    expect(addressWith(supabase, {})).toBe("https://mcp.supabase.com/mcp");
    expect(addressWith(github, { readonly: false })).toBe("https://api.githubcopilot.com/mcp/");
    expect(addressWith(directoryEntry("vercel")!, {})).toBe("https://mcp.vercel.com");
  });

  test("a flag, a value and a path suffix each round-trip", () => {
    const url = addressWith(supabase, { read_only: true, project_ref: "abc123" });
    expect(new URL(url).searchParams.get("read_only")).toBe("true");
    expect(optionsIn(supabase, url)).toEqual({ read_only: true, project_ref: "abc123" });
    const ro = addressWith(github, { readonly: true });
    expect(ro).toBe("https://api.githubcopilot.com/mcp/readonly");
    expect(optionsIn(github, ro)).toEqual({ readonly: true });
    expect(addressWith(github, { readonly: false }, ro)).toBe("https://api.githubcopilot.com/mcp/");
  });

  test("changing one setting leaves the rest of the address alone", () => {
    const handTuned = "https://mcp.supabase.com/mcp?features=database,docs&project_ref=abc123";
    const on = addressWith(supabase, { read_only: true }, handTuned);
    const params = new URL(on).searchParams;
    expect(params.get("features")).toBe("database,docs");
    expect(params.get("project_ref")).toBe("abc123");
    expect(params.get("read_only")).toBe("true");
    const cleared = addressWith(supabase, { project_ref: undefined }, on);
    expect(new URL(cleared).searchParams.get("project_ref")).toBeNull();
    expect(new URL(cleared).searchParams.get("features")).toBe("database,docs");
  });

  test("an address is the entry's whatever its settings, and not when pointed elsewhere", () => {
    expect(isEntryAddress(github, "https://api.githubcopilot.com/mcp/readonly")).toBe(true);
    expect(isEntryAddress(supabase, "https://mcp.supabase.com/mcp?read_only=true")).toBe(true);
    expect(isEntryAddress(github, "https://github.example.com/mcp/")).toBe(false);
    expect(isEntryAddress(supabase, "https://mcp.supabase.com/other")).toBe(false);
  });
});

describe("pasted tokens are named, never written", () => {
  test("a token entry's config points at the keychain account", () => {
    const config = directoryConfig(directoryEntry("github")!);
    expect(config.headers?.Authorization).toBe(`Bearer ${keychainRef(mcpTokenAccount("github"))}`);
    expect(keychainAccountsIn(config)).toEqual(["mcp-token:github"]);
  });

  test("an optional token left out means no header and no sign-in attempt", () => {
    const config = directoryConfig(directoryEntry("context7")!, { withToken: false });
    expect(config.headers).toBeUndefined();
    expect(config.oauth).toEqual({ enabled: false });
  });

  test("filling replaces every reference and reports the missing ones", () => {
    const missing = new Set<string>();
    const out = fillKeychainRefs(
      { headers: { A: "Bearer ${keychain:mcp-token:a}", B: "${keychain:mcp-token:b}" } },
      new Map([["mcp-token:a", "AAA"]]),
      missing,
    );
    expect(out.headers.A).toBe("Bearer AAA");
    expect(out.headers.B).toBe("");
    expect([...missing]).toEqual(["mcp-token:b"]);
  });

  test("an ordinary ${VAR} is not a keychain reference", () => {
    expect(keychainAccountsIn({ headers: { A: "Bearer ${GITHUB_TOKEN}" } })).toEqual([]);
  });
});

describe("search", () => {
  test("ranks an exact name first and matches what a service is for", () => {
    expect(searchDirectory("neon")[0]?.id).toBe("neon");
    expect(searchDirectory("postgres").map((e) => e.id)).toContain("neon");
    expect(searchDirectory("zzzz-nothing")).toEqual([]);
  });
});
