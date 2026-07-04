import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncidentInput } from "../../../packages/shared/src/incident";
import { Recorder } from "../../../packages/telemetry/src/recorder";
import { BlackboxStore } from "../../../packages/telemetry/src/store";
import { containsSecret, redactText } from "../../../packages/telemetry/src/redact";
import {
  armSentinel,
  consumeDirtyExit,
  disarmSentinel,
} from "../../../packages/telemetry/src/sentinel";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alan-blackbox-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sample = (over: Partial<IncidentInput> = {}): IncidentInput => ({
  class: "tool.exec_failure",
  severity: "error",
  component: "tool:bash",
  where: "agent-loop#phaseC",
  message: "Command failed with exit 1: npm test",
  ...over,
});

describe("BlackboxStore", () => {
  test("insert + get roundtrip, fingerprint aggregation", () => {
    const store = new BlackboxStore(join(dir, "bb.db"));
    const rec = {
      ...sample(),
      id: "01900000-0000-7000-8000-000000000001",
      ts: new Date().toISOString(),
      version: "0.1.0",
      sessionId: "s1",
      turn: 1,
      trail: [{ seq: 1, kind: "user_msg", summary: "fix tests" }],
      outcome: "pending" as const,
      fingerprint: "aaaaaaaaaaaaaaaa",
    };
    store.insert(rec);
    store.insert({ ...rec, id: "01900000-0000-7000-8000-000000000002", version: "0.2.0" });

    const got = store.get(rec.id);
    expect(got?.message).toContain("npm test");
    expect(got?.trail[0].summary).toBe("fix tests");

    const top = store.top();
    expect(top.length).toBe(1);
    expect(top[0].count).toBe(2);
    expect(top[0].versions.sort()).toEqual(["0.1.0", "0.2.0"]);
  });

  test("list filters: severity floor, family prefix, session", () => {
    const store = new BlackboxStore(join(dir, "bb.db"));
    const base = {
      ts: new Date().toISOString(),
      version: "0.1.0",
      sessionId: "s1",
      turn: 1,
      trail: [],
      outcome: "pending" as const,
      fingerprint: "f",
    };
    store.insert({ ...sample({ severity: "debug", class: "provider.malformed_tool_json_salvaged" }), ...base, id: "a" });
    store.insert({ ...sample({ severity: "warn", class: "provider.fallback_triggered" }), ...base, id: "b" });
    store.insert({ ...sample({ severity: "error" }), ...base, id: "c", sessionId: "s2" });

    expect(store.list({ minSeverity: "warn" }).length).toBe(2);
    expect(store.list({ class: "provider." }).length).toBe(2);
    expect(store.list({ sessionId: "s2" }).length).toBe(1);
  });

  test("resolve marks only pending; sweep resolves stale pendings", () => {
    const store = new BlackboxStore(join(dir, "bb.db"));
    const old = {
      ...sample(),
      id: "old",
      ts: new Date(Date.now() - 3_600_000).toISOString(),
      version: "0.1.0",
      sessionId: "s1",
      turn: 1,
      trail: [],
      outcome: "pending" as const,
      fingerprint: "f1",
    };
    store.insert(old);
    store.resolve(["old"], "recovered");
    expect(store.get("old")?.outcome).toBe("recovered");
    // resolving again must not clobber
    store.resolve(["old"], "turn_failed");
    expect(store.get("old")?.outcome).toBe("recovered");

    store.insert({ ...old, id: "stale", fingerprint: "f2" });
    const swept = store.sweepPending(new Date().toISOString(), "abandoned");
    expect(swept).toBe(1);
    expect(store.get("stale")?.outcome).toBe("abandoned");
  });

  test("short-id lookup matches the random SUFFIX (uuidv7 prefixes collide)", () => {
    const store = new BlackboxStore(join(dir, "bb.db"));
    const base = {
      ...sample(),
      ts: new Date().toISOString(),
      version: "0.1.0",
      sessionId: null,
      turn: null,
      trail: [],
      outcome: "pending" as const,
    };
    // same-millisecond uuidv7 shape: identical prefix, distinct suffix
    store.insert({ ...base, id: "01900000-0000-7000-8000-aaaaaaaa1111", fingerprint: "f1" });
    store.insert({ ...base, id: "01900000-0000-7000-8000-bbbbbbbb2222", fingerprint: "f2" });
    expect(store.getByPrefix("01900000")).toBeNull(); // ambiguous prefix
    expect(store.getByPrefix("aaaa1111")?.id).toContain("aaaaaaaa1111"); // suffix wins
    expect(store.getByPrefix("bbbb2222")?.fingerprint).toBe("f2");
  });

  test("prune deletes raw incidents but keeps aggregates", () => {
    const store = new BlackboxStore(join(dir, "bb.db"));
    store.insert({
      ...sample(),
      id: "x",
      ts: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      version: "0.1.0",
      sessionId: null,
      turn: null,
      trail: [],
      outcome: "pending",
      fingerprint: "keepme",
    });
    expect(store.prune({ maxAgeDays: 30 })).toBe(1);
    expect(store.get("x")).toBeNull();
    expect(store.top()[0].fingerprint).toBe("keepme");
  });
});

describe("Recorder", () => {
  test("records with trail snapshot, redaction, run-scoped resolution", () => {
    const rec = new Recorder({ dbPath: join(dir, "bb.db"), version: "0.1.0-test" });
    rec.beginRun("sess-1", 3);
    rec.note("user_msg", "please use key sk-abcdefghijklmnop to call the api");
    rec.note("tool:bash", "npm test");
    const id = rec.record(sample({ message: "boom with token ghp_abcdefghijklmnopqrstuv" }));
    expect(id).not.toBeNull();

    const store = rec.getStore()!;
    const got = store.get(id!)!;
    expect(got.sessionId).toBe("sess-1");
    expect(got.turn).toBe(3);
    expect(got.version).toBe("0.1.0-test");
    expect(got.message).not.toContain("ghp_");
    expect(got.trail.length).toBe(2);
    expect(got.trail[0].summary).not.toContain("sk-abcdefghijklmnop");
    expect(got.outcome).toBe("pending");

    rec.endRun("recovered");
    expect(store.get(id!)?.outcome).toBe("recovered");
    rec.close();
  });

  test("never throws when the store cannot open; writes last-resort log", () => {
    // a directory path that cannot be a db file (path exists as dir)
    const bad = join(dir, "as-dir");
    // create the path as a directory so sqlite open fails
    rmSync(bad, { recursive: true, force: true });
    require("node:fs").mkdirSync(bad, { recursive: true });
    const rec = new Recorder({
      dbPath: bad,
      version: "v",
      lastResortPath: join(dir, "last-resort.log"),
    });
    expect(rec.record(sample())).toBeNull();
    expect(rec.health().ok).toBe(false);
    expect(existsSync(join(dir, "last-resort.log"))).toBe(true);
    rec.close();
  });

  test("recordFatal resolves itself and pending run incidents to crash", () => {
    const rec = new Recorder({ dbPath: join(dir, "bb.db"), version: "v" });
    rec.beginRun("s", 1);
    const a = rec.record(sample({ severity: "warn", class: "provider.fallback_triggered" }))!;
    const b = rec.recordFatal({
      class: "crash.uncaught_exception",
      severity: "critical",
      component: "cli",
      where: "process#uncaughtException",
      message: "TypeError: x is not a function",
    })!;
    const store = rec.getStore()!;
    expect(store.get(a)?.outcome).toBe("crash");
    expect(store.get(b)?.outcome).toBe("crash");
    rec.close();
  });

  test("trail ring buffer caps growth", () => {
    const rec = new Recorder({ dbPath: join(dir, "bb.db"), version: "v", maxTrail: 5 });
    for (let i = 0; i < 50; i++) rec.note("text", `line ${i}`);
    const snap = rec.getTrailSnapshot();
    expect(snap.length).toBe(5);
    expect(snap[4].summary).toBe("line 49");
    rec.close();
  });
});

describe("redaction", () => {
  const secrets = [
    "sk-abc123def456ghi789",
    "sk-ant-api03-verylongkeymaterial123",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456",
    "github_pat_11ABCDEFGHIJKLMNOPQRST",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-123456789-abcdefghij",
    "AIzaSyA-1234567890abcdefghijklmnopqrstu",
    "Bearer abcdef123456789.tokenmaterial",
    "api_key=supersecretvalue123",
    "password: hunter2hunter2",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456",
  ];

  test("known secret shapes never survive", () => {
    for (const s of secrets) {
      const out = redactText(`context before ${s} context after`);
      // the secret material itself must be gone
      const material = s.replace(/^(Bearer\s+|api_key=|password: )/, "");
      expect(out).not.toContain(material);
      expect(out).toContain("redacted");
    }
  });

  test("private key blocks are removed wholesale", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow_fake_material\n-----END RSA PRIVATE KEY-----`;
    expect(redactText(pem)).toBe("[redacted:private-key]");
  });

  test("home directory collapses to ~ and plain text passes through", () => {
    const home = require("node:os").homedir();
    expect(redactText(`${home}/projects/x`)).toBe("~/projects/x");
    expect(redactText("just a normal error message")).toBe("just a normal error message");
    expect(containsSecret("nothing to see")).toBe(false);
  });
});

describe("sentinel", () => {
  test("arm → consume returns meta + spooled trail; second consume is null", () => {
    const sentinel = join(dir, "sentinel.json");
    const spool = join(dir, "spool.json");
    writeFileSync(
      spool,
      JSON.stringify({ trail: [{ seq: 1, kind: "tool:bash", summary: "cargo build" }] }),
    );
    armSentinel(sentinel, {
      pid: 123,
      version: "0.1.0",
      sessionId: "s9",
      startedAt: new Date().toISOString(),
      spoolPath: spool,
    });
    const dirty = consumeDirtyExit(sentinel);
    expect(dirty?.meta.sessionId).toBe("s9");
    expect(dirty?.trail[0].summary).toBe("cargo build");
    expect(consumeDirtyExit(sentinel)).toBeNull();
    expect(existsSync(spool)).toBe(false);
  });

  test("disarm removes the sentinel; corrupt sentinel never blocks", () => {
    const sentinel = join(dir, "sentinel.json");
    armSentinel(sentinel, {
      pid: 1,
      version: "v",
      sessionId: null,
      startedAt: "now",
      spoolPath: null,
    });
    disarmSentinel(sentinel);
    expect(consumeDirtyExit(sentinel)).toBeNull();

    writeFileSync(sentinel, "not json {{{");
    expect(consumeDirtyExit(sentinel)).toBeNull();
    expect(existsSync(sentinel)).toBe(false);
  });
});
