import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookStore } from "../../../packages/orchestrator/src/notebook/store";
import { repoKey, stackKey } from "../../../packages/orchestrator/src/notebook/fingerprint";
import {
  captureFromRun,
  commandsAreVariants,
  type ToolObservation,
} from "../../../packages/orchestrator/src/notebook/capture";
import { buildNotebookBlock } from "../../../packages/orchestrator/src/notebook/retrieval";
import { CostGovernor } from "../../../packages/orchestrator/src/notebook/governor";
import { rmTemp } from "../../helpers/tmp";

let dir: string;
let store: NotebookStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gear-notebook-"));
  store = new NotebookStore(join(dir, "nb.db"));
});

afterEach(() => {
  store.close();
  rmTemp(dir);
});

const obs = (toolName: string, command: string, success: boolean): ToolObservation => ({
  toolName,
  args: { command },
  success,
});

describe("NotebookStore", () => {
  test("upsert dedupes on (scope, keys, title) — the notebook converges", () => {
    const a = store.upsert({
      kind: "fact",
      scope: "repo",
      repoKey: "r1",
      title: "test-command",
      body: "test: `npm test`",
      sessionId: "s1",
    });
    const b = store.upsert({
      kind: "fact",
      scope: "repo",
      repoKey: "r1",
      title: "test-command",
      body: "test: `bun test` (verified working here)",
      sessionId: "s2",
    });
    expect(b).toBe(a);
    const all = store.list();
    expect(all.length).toBe(1);
    expect(all[0].body).toContain("bun test");
    expect(all[0].provenance.sessions).toEqual(["s1", "s2"]);
  });

  test("retrieve ranks repo > stack > global and respects win rate", () => {
    store.upsert({ kind: "fact", scope: "global", title: "g", body: "global note" });
    store.upsert({
      kind: "fact",
      scope: "stack",
      stackKey: "bun+ts",
      title: "s",
      body: "stack note",
    });
    store.upsert({ kind: "fact", scope: "repo", repoKey: "r1", title: "r", body: "repo note" });
    // a different repo's entry must never appear
    store.upsert({ kind: "fact", scope: "repo", repoKey: "OTHER", title: "x", body: "other repo" });

    const got = store.retrieve({ repoKey: "r1", stackKey: "bun+ts" });
    expect(got.map((e) => e.body)).toEqual(["repo note", "stack note", "global note"]);
  });

  test("uses/wins attribution and decay retire losing stale entries", () => {
    const id = store.upsert({ kind: "tactic", scope: "repo", repoKey: "r", title: "t", body: "b" });
    for (let i = 0; i < 5; i++) store.touchUses([id]);
    store.recordWins([id]); // 1 win / 5 uses = 20% — a loser
    let e = store.list()[0];
    expect(e.uses).toBe(5);
    expect(e.wins).toBe(1);

    // decay(0): everything is "stale enough"; losing record → retired
    const n = store.decay(0);
    expect(n).toBe(1);
    expect(store.list().length).toBe(0);
    expect(store.list({ includeRetired: true }).length).toBe(1);

    // re-learning the same title revives it
    store.upsert({ kind: "tactic", scope: "repo", repoKey: "r", title: "t", body: "b2" });
    e = store.list()[0];
    expect(e.retired).toBe(false);
    expect(e.body).toBe("b2");
  });
});

describe("fingerprint", () => {
  test("stack key detects bun+rust+ts+turbo shape", () => {
    writeFileSync(join(dir, "bun.lock"), "");
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "Cargo.toml"), '[workspace]\nmembers=["crates/x"]');
    writeFileSync(join(dir, "turbo.json"), "{}");
    expect(stackKey(dir)).toBe("bun+rust+ts+turbo");
  });

  test("package.json deps add framework + monorepo signals; empty dir is unknown", () => {
    const d2 = join(dir, "web");
    mkdirSync(d2);
    writeFileSync(join(d2, "package-lock.json"), "{}");
    writeFileSync(
      join(d2, "package.json"),
      JSON.stringify({ dependencies: { next: "14" }, workspaces: ["apps/*"] }),
    );
    expect(stackKey(d2)).toBe("monorepo+next+npm");
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(stackKey(empty)).toBe("unknown");
  });

  test("repoKey is stable and path-scoped", () => {
    expect(repoKey(dir)).toBe(repoKey(dir));
    expect(repoKey(dir)).not.toBe(repoKey(join(dir, "web")));
    expect(repoKey(dir)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("capture", () => {
  const ctx = () => ({
    store,
    repoKey: "r1",
    stackKey: "bun+ts",
    sessionId: "sess",
    workspaceRoot: dir,
  });

  test("E1: a succeeded runner test command becomes a repo fact; greps do not", () => {
    captureFromRun(ctx(), [
      obs("bash", "grep -rn test src/", true), // not a runner shape
      obs("bash", "bun test tests/unit/", true),
    ]);
    const entries = store.list();
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe("test-command");
    expect(entries[0].body).toContain("`bun test tests/unit/`");
    expect(entries[0].scope).toBe("repo");
  });

  test("E2: failed npm test → succeeded bun test becomes a failover tactic", () => {
    captureFromRun(ctx(), [
      obs("bash", "npm test", false),
      obs("bash", "ls -la", true),
      obs("bash", "bun test", true),
    ]);
    const tactic = store.list().find((e) => e.kind === "tactic");
    expect(tactic).toBeDefined();
    expect(tactic!.body).toBe("Use `bun test` here — `npm test` fails in this repo.");
  });

  test("variant detection: shared-suffix and high-overlap match; unrelated do not", () => {
    expect(commandsAreVariants("npm test", "bun test")).toBe(true);
    expect(commandsAreVariants("cargo build --release", "cargo build")).toBe(true);
    expect(commandsAreVariants("npm test", "cargo doc")).toBe(false);
    expect(commandsAreVariants("bun test", "bun test")).toBe(false);
  });

  test("multi-line and oversized commands are never captured", () => {
    captureFromRun(ctx(), [
      obs("bash", "bun test\nrm -rf /", true),
      obs("bash", `bun test ${"x".repeat(150)}`, true),
    ]);
    expect(store.list().length).toBe(0);
  });

  test("E3: monorepo layout fact from package.json workspaces + cargo members", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    writeFileSync(join(dir, "Cargo.toml"), `[workspace]\nmembers = ["crates/a", "crates/b"]`);
    captureFromRun(ctx(), []);
    const fact = store.list().find((e) => e.title === "monorepo-layout");
    expect(fact).toBeDefined();
    expect(fact!.body).toContain("packages/*");
    expect(fact!.body).toContain("crates/a");
  });
});

describe("retrieval block", () => {
  test("budgeted injection with scope tags; empty store yields empty text", () => {
    expect(buildNotebookBlock(store, { repoKey: "r", stackKey: "s" }).text).toBe("");

    store.upsert({ kind: "fact", scope: "repo", repoKey: "r", title: "a", body: "repo advice" });
    store.upsert({ kind: "fact", scope: "stack", stackKey: "s", title: "b", body: "stack advice" });
    const block = buildNotebookBlock(store, { repoKey: "r", stackKey: "s" });
    expect(block.text).toContain("## Notebook");
    expect(block.text).toContain("verify against reality");
    expect(block.text).toContain("[this repo] repo advice");
    expect(block.text).toContain("[s] stack advice");
    expect(block.injectedIds.length).toBe(2);
  });

  test("a tiny budget truncates instead of overflowing", () => {
    for (let i = 0; i < 20; i++) {
      store.upsert({
        kind: "fact",
        scope: "repo",
        repoKey: "r",
        title: `t${i}`,
        body: `advice number ${i} with some padding text to consume budget`,
      });
    }
    const block = buildNotebookBlock(store, { repoKey: "r", stackKey: "s", maxTokens: 60 });
    expect(block.injectedIds.length).toBeGreaterThan(0);
    expect(block.injectedIds.length).toBeLessThan(20);
    expect(block.text.length).toBeLessThanOrEqual(60 * 4);
  });
});

describe("engine integration", () => {
  test("a pre-seeded notebook is retrieved for the engine's workspace", async () => {
    const { Engine } = await import("../../../packages/orchestrator/src/engine");
    const nbPath = join(dir, "engine-nb.db");
    const seed = new NotebookStore(nbPath);
    seed.upsert({
      kind: "fact",
      scope: "repo",
      repoKey: repoKey(dir),
      title: "test-command",
      body: "test: `bun test` (verified working here)",
    });
    seed.upsert({ kind: "fact", scope: "global", title: "g", body: "a global note" });
    seed.close();

    const engine = new Engine({
      model: "gemini-2.5-flash",
      provider: "google",
      workspaceRoot: dir,
      dbPath: join(dir, "gear.db"),
      toolsBinaryPath: "gear-tools",
      yoloMode: false,
      enableCheckpoints: false,
      enableSecurity: false,
      enableRateLimiting: false,
      enableHooks: false,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
      notebook: { enabled: true, dbPath: nbPath },
    });
    const entries = engine.getNotebookEntries();
    expect(entries.length).toBe(2);
    expect(entries[0].body).toContain("bun test"); // repo scope outranks global
    engine.close();
  });

  test("notebook disabled → no store, no entries", async () => {
    const { Engine } = await import("../../../packages/orchestrator/src/engine");
    const engine = new Engine({
      model: "gemini-2.5-flash",
      provider: "google",
      workspaceRoot: dir,
      dbPath: join(dir, "gear2.db"),
      toolsBinaryPath: "gear-tools",
      yoloMode: false,
      enableCheckpoints: false,
      enableSecurity: false,
      enableRateLimiting: false,
      enableHooks: false,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });
    expect(engine.getNotebookStore()).toBeNull();
    expect(engine.getNotebookEntries()).toEqual([]);
    engine.close();
  });
});

describe("CostGovernor — the ≤2% learning-spend contract", () => {
  test("free jobs always allowed; paid jobs capped at budgetPct of session spend", () => {
    const g = new CostGovernor({ budgetPct: 2 });
    expect(g.allow(0, 0)).toBe(true);
    // session spent $1.00 → learning ceiling $0.02
    expect(g.allow(0.015, 1.0)).toBe(true);
    g.add(0.015);
    expect(g.allow(0.01, 1.0)).toBe(false); // 0.015 + 0.01 > 0.02
    expect(g.spent()).toBeCloseTo(0.015);
    expect(g.ratio(1.0)).toBeCloseTo(0.015);
  });

  test("floor lets one tiny job run on a free/local session; 30%-class jobs never pass", () => {
    const g = new CostGovernor();
    expect(g.allow(0.001, 0)).toBe(true); // under the $0.002 floor
    expect(g.allow(0.3, 1.0)).toBe(false); // 30% of budget — structurally refused
  });
});
