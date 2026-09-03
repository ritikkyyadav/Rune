import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_PLUGIN_INDEX_URL,
  entryFitsThisGear,
  entrySourceSpec,
  findBundledIndexPath,
  loadPluginIndex,
  resolvePluginIndexEntry,
  searchPluginIndex,
  validatePluginIndex,
  verifyIndexIntegrity,
  type PluginIndex,
  type PluginIndexEntry,
} from "../../../packages/orchestrator/src/plugin-index";
import { computeIntegrity } from "../../../packages/orchestrator/src/plugins";

// P10.7 part 1: the index is fetched over the network, so it is exactly the
// input whose SHAPE must not be trusted. These tests pin the schema, the
// resolution order, the integrity check and the offline fallback.

const repoRoot = resolve(import.meta.dir, "../../..");
const repoIndexPath = join(repoRoot, "plugins", "index.json");

function entry(over: Partial<PluginIndexEntry> = {}): PluginIndexEntry {
  return {
    name: "demo",
    description: "A demo plugin",
    source: "https://github.com/example/demo.git",
    version: "1.0.0",
    capabilities: ["skills"],
    maintainer: "Example <a@example.com>",
    ...over,
  } as PluginIndexEntry;
}

function index(...plugins: PluginIndexEntry[]): PluginIndex {
  return { version: 1, plugins };
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gear-plugin-index-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("validatePluginIndex", () => {
  test("the index shipped in this repository is valid", () => {
    const result = validatePluginIndex(JSON.parse(readFileSync(repoIndexPath, "utf8")));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.index.plugins.length).toBeGreaterThan(0);
  });

  test("a non-object, a wrong version and a missing plugins array are each refused", () => {
    expect(validatePluginIndex(null).ok).toBe(false);
    expect(validatePluginIndex([]).ok).toBe(false);
    const wrongVersion = validatePluginIndex({ version: 2, plugins: [] });
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.errors.join(" ")).toContain("version must be 1");
    const noArray = validatePluginIndex({ version: 1 });
    expect(noArray.ok).toBe(false);
    if (!noArray.ok) expect(noArray.errors.join(" ")).toContain("plugins must be an array");
  });

  test("every problem is reported, not only the first", () => {
    const result = validatePluginIndex({
      version: 1,
      plugins: [
        { name: "a" },
        { name: "b", description: "", source: "x", version: "1", maintainer: "m" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // "a" is missing four required strings and its capabilities array.
      expect(result.errors.length).toBeGreaterThanOrEqual(6);
      expect(result.errors.some((e) => e.includes('"a".description'))).toBe(true);
      expect(result.errors.some((e) => e.includes('"b".description'))).toBe(true);
    }
  });

  test("names are constrained and may not repeat", () => {
    const bad = validatePluginIndex({ version: 1, plugins: [{ name: "has space" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toContain("name must be letters");

    const dup = validatePluginIndex({ version: 1, plugins: [entry(), entry()] });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.join(" ")).toContain("listed twice");
  });

  test("capabilities come from a closed vocabulary and may not be empty", () => {
    const unknown = validatePluginIndex(
      index(entry({ capabilities: ["telepathy"] as unknown as PluginIndexEntry["capabilities"] })),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.join(" ")).toContain("allowed:");

    const empty = validatePluginIndex(index(entry({ capabilities: [] })));
    expect(empty.ok).toBe(false);

    const tools = validatePluginIndex(index(entry({ capabilities: ["tools:network"] })));
    expect(tools.ok).toBe(true);
  });

  test("an integrity field that is not a sha256 digest is refused", () => {
    const bad = validatePluginIndex(index(entry({ integrity: "sha256-nope" })));
    expect(bad.ok).toBe(false);
    const good = validatePluginIndex(index(entry({ integrity: `sha256-${"a".repeat(64)}` })));
    expect(good.ok).toBe(true);
  });
});

describe("searchPluginIndex", () => {
  const list = index(
    entry({ name: "alpha", description: "formats code" }),
    entry({ name: "alpha-extra", description: "unrelated" }),
    entry({ name: "zulu", description: "an alpha channel helper" }),
    entry({ name: "netter", description: "fetches things", capabilities: ["tools:network"] }),
  );

  test("an empty query lists everything, alphabetically", () => {
    expect(searchPluginIndex(list, "  ").map((e) => e.name)).toEqual([
      "alpha",
      "alpha-extra",
      "netter",
      "zulu",
    ]);
  });

  test("exact name beats prefix beats description", () => {
    expect(searchPluginIndex(list, "alpha").map((e) => e.name)).toEqual([
      "alpha",
      "alpha-extra",
      "zulu",
    ]);
  });

  test("capabilities are searchable, so 'network' finds the network tools", () => {
    expect(searchPluginIndex(list, "tools:network").map((e) => e.name)).toEqual(["netter"]);
  });

  test("resolution is by exact name only", () => {
    expect(resolvePluginIndexEntry(list, "alpha")?.name).toBe("alpha");
    expect(resolvePluginIndexEntry(list, "alph")).toBeNull();
  });
});

describe("entrySourceSpec", () => {
  test("a git URL passes through untouched", () => {
    const result = entrySourceSpec(entry({ source: "https://github.com/e/d.git" }));
    expect(result).toEqual({ spec: "https://github.com/e/d.git" });
  });

  test("a relative source resolves against the index file's directory", () => {
    const result = entrySourceSpec(entry({ source: "../examples/plugins/x" }), {
      indexDir: "/repo/plugins",
    });
    expect(result).toEqual({ spec: resolve("/repo/plugins", "../examples/plugins/x") });
  });

  test("a relative source from a REMOTE index is refused, not guessed", () => {
    const result = entrySourceSpec(entry({ source: "./somewhere" }));
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("relative source");
  });
});

describe("verifyIndexIntegrity", () => {
  function tree(): string {
    const root = join(workspace, "bundle");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "plugin.json"), JSON.stringify({ name: "bundle" }));
    writeFileSync(join(root, "notes.md"), "hello\n");
    return root;
  }

  test("a matching digest verifies", () => {
    const root = tree();
    const result = verifyIndexIntegrity(entry({ integrity: computeIntegrity(root) }), root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.checked).toBe(true);
  });

  test("a changed file fails the check and reports both digests", () => {
    const root = tree();
    const published = computeIntegrity(root);
    writeFileSync(join(root, "notes.md"), "tampered\n");
    const result = verifyIndexIntegrity(entry({ integrity: published }), root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.expected).toBe(published);
      expect(result.actual).not.toBe(published);
    }
  });

  test("an entry with no digest is not a failure, but says it was not checked", () => {
    const root = tree();
    const result = verifyIndexIntegrity(entry(), root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.checked).toBe(false);
  });

  test("every local entry in this repository's index matches its tree on disk", () => {
    const parsed = validatePluginIndex(JSON.parse(readFileSync(repoIndexPath, "utf8")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const e of parsed.index.plugins) {
      if (/^(https?:|git@|git\+)/.test(e.source)) continue;
      const treeRoot = resolve(dirname(repoIndexPath), e.source);
      const verdict = verifyIndexIntegrity(e, treeRoot);
      if (!verdict.ok) {
        throw new Error(
          `${e.name}: index digest ${verdict.expected} but the tree hashes ${verdict.actual} — ` +
            `run "bun run scripts/plugin-index.ts --write"`,
        );
      }
      expect(verdict.ok).toBe(true);
    }
  });
});

describe("entryFitsThisGear", () => {
  test("a range this build satisfies fits, one it does not is refused", () => {
    expect(entryFitsThisGear(entry({ gearVersion: ">=0.1.0" }), "0.3.0")).toBe(true);
    expect(entryFitsThisGear(entry({ gearVersion: ">=9.0.0" }), "0.3.0")).toBe(false);
    expect(entryFitsThisGear(entry(), "0.3.0")).toBe(true);
  });
});

describe("loadPluginIndex", () => {
  function writeIndex(name: string, body: unknown): string {
    const path = join(workspace, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
    return path;
  }

  test("a configured path is read directly and carries its directory", async () => {
    const path = writeIndex("local.json", index(entry({ name: "local-one" })));
    const load = await loadPluginIndex({ ref: path, useCache: false });
    expect(load.index?.plugins[0]?.name).toBe("local-one");
    expect(load.originKind).toBe("config");
    expect(load.indexDir).toBe(workspace);
    expect(load.stale).toBe(false);
  });

  test("a file:// ref is a path", async () => {
    const path = writeIndex("file-url.json", index(entry({ name: "via-url" })));
    const load = await loadPluginIndex({ ref: `file://${path}`, useCache: false });
    expect(load.index?.plugins[0]?.name).toBe("via-url");
  });

  test("a URL is fetched and validated", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(index(entry({ name: "remote" }))), {
        status: 200,
      })) as unknown as typeof fetch;
    const load = await loadPluginIndex({
      ref: "https://example.invalid/index.json",
      fetchImpl,
      useCache: false,
    });
    expect(load.index?.plugins[0]?.name).toBe("remote");
    expect(load.originKind).toBe("url");
    expect(load.stale).toBe(false);
  });

  test("an unreachable URL falls back to the copy shipped with Gear, marked stale", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const load = await loadPluginIndex({
      ref: DEFAULT_PLUGIN_INDEX_URL,
      fetchImpl,
      useCache: false,
    });
    expect(load.originKind).toBe("bundled");
    expect(load.stale).toBe(true);
    expect(load.index?.plugins.length).toBeGreaterThan(0);
    expect(load.errors.join(" ")).toContain("could not fetch");
  });

  test("a malformed remote index is refused, and the fallback is used instead", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ version: 1, plugins: [{ name: "x" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const load = await loadPluginIndex({
      ref: "https://example.invalid/index.json",
      fetchImpl,
      useCache: false,
    });
    expect(load.errors.join(" ")).toContain("malformed");
    expect(load.originKind).toBe("bundled");
  });

  test("a missing local index degrades rather than throwing", async () => {
    const load = await loadPluginIndex({
      ref: join(workspace, "absent.json"),
      useCache: false,
      bundledFrom: workspace,
    });
    expect(load.index).toBeNull();
    expect(load.errors.join(" ")).toContain("could not read");
  });

  test("the bundled copy is found by walking up from the module", () => {
    expect(findBundledIndexPath()).toBe(repoIndexPath);
  });
});
