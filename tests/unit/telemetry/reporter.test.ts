import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncidentInput, IncidentRecord } from "../../../packages/shared/src/incident";
import { Recorder } from "../../../packages/telemetry/src/recorder";
import {
  TelemetryReporter,
  toIncidentWire,
  type WireReport,
} from "../../../packages/telemetry/src/reporter";
import {
  ensureInstallId,
  loadTelemetryState,
  resetTelemetryState,
  setConsent,
  telemetryStatePath,
} from "../../../packages/telemetry/src/consent";
import { bumpUsage, peekUsage } from "../../../packages/telemetry/src/counters";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alan-telemetry-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const record = (over: Partial<IncidentRecord> = {}): IncidentRecord => ({
  id: "id-1",
  ts: "2026-07-08T00:00:00.000Z",
  version: "0.1",
  sessionId: "sess-1",
  turn: 2,
  class: "tool.exec_failure",
  severity: "error",
  component: "tool:bash",
  where: "agent-loop#phaseC",
  message: "boom",
  stack: undefined,
  trail: [{ seq: 1, kind: "user_msg", summary: "do the thing" }],
  outcome: "turn_failed",
  fingerprint: "abcd1234abcd1234",
  context: { provider: "example", model: "m", status: 500 },
  ...over,
});

function readQueue(queuePath: string): WireReport[] {
  if (!existsSync(queuePath)) return [];
  return readFileSync(queuePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as WireReport);
}

/** Controllable fake fetch: records calls, returns ok/!ok on demand. */
function fakeFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  let ok = true;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(null, { status: ok ? 200 : 500 });
  }) as unknown as typeof fetch;
  return {
    impl,
    calls,
    setOk(v: boolean) {
      ok = v;
    },
  };
}

function makeReporter(over: Partial<ConstructorParameters<typeof TelemetryReporter>[0]> = {}) {
  const fetcher = fakeFetch();
  const reporter = new TelemetryReporter({
    home: dir,
    endpoint: "https://collector.example/ingest",
    installId: "install-xyz",
    version: "0.1",
    os: "testos",
    arch: "testarch",
    queuePath: join(dir, "queue.jsonl"),
    fetchImpl: fetcher.impl,
    now: () => new Date("2026-07-08T12:00:00.000Z"),
    ...over,
  });
  return { reporter, fetcher, queuePath: join(dir, "queue.jsonl") };
}

// ─── consent / identity gate ───

describe("consent gate", () => {
  test("no install id until consent is granted", () => {
    expect(loadTelemetryState(dir).decision).toBeNull();
    expect(ensureInstallId(dir)).toBeNull(); // denied-by-default

    const st = setConsent(dir, "granted");
    expect(st.decision).toBe("granted");
    expect(st.installId).toBeTruthy();
    // stable across calls
    expect(ensureInstallId(dir)).toBe(st.installId);
  });

  test("denied consent mints no id; reset clears everything", () => {
    setConsent(dir, "denied");
    expect(ensureInstallId(dir)).toBeNull();

    setConsent(dir, "granted");
    expect(ensureInstallId(dir)).toBeTruthy();
    resetTelemetryState(dir);
    expect(loadTelemetryState(dir).decision).toBeNull();
    expect(loadTelemetryState(dir).installId).toBeNull();
  });

  test("a corrupt state file fails SAFE (treated as never-consented)", () => {
    writeFileSync(telemetryStatePath(dir), "{ not json");
    expect(loadTelemetryState(dir).decision).toBeNull();
    expect(ensureInstallId(dir)).toBeNull();
  });
});

// ─── payload allowlist ───

describe("wire payload allowlist", () => {
  test("only vetted fields ship; context is filtered; trail is dropped; secrets redacted", () => {
    const wire = toIncidentWire(
      record({
        message: "auth failed token=sk-abcdefghijklmnop stack trace",
        context: {
          provider: "p",
          model: "m",
          status: 429,
          // arbitrary field a tap site could attach — must NOT survive
          secretUserField: "should-be-dropped",
        } as never,
      }),
      { installId: "iid", os: "o", arch: "a" },
    );

    // no trail, no sessionId under a leaky name, only the allowlisted keys
    expect((wire as Record<string, unknown>).trail).toBeUndefined();
    expect(wire.run).toBe("sess-1"); // sessionId is deliberately kept (non-identifying)
    expect(Object.keys(wire.ctx).sort()).toEqual(["model", "provider", "status"]);
    expect((wire.ctx as Record<string, unknown>).secretUserField).toBeUndefined();
    // secret in the message is redacted
    expect(wire.msg).not.toContain("sk-abcdefghijklmnop");
    expect(wire.msg).toContain("[redacted");
    expect(wire.os).toBe("o");
  });
});

// ─── reporter: durable sink + gating ───

describe("reporter.onIncident", () => {
  test("appends exactly one durable line, no network", () => {
    const { reporter, fetcher, queuePath } = makeReporter();
    reporter.onIncident(record());
    const q = readQueue(queuePath);
    expect(q).toHaveLength(1);
    expect(q[0].t).toBe("incident");
    expect(fetcher.calls).toHaveLength(0); // sink never touches the network
  });

  test("crash stream off ⇒ nothing enqueued", () => {
    const { reporter, queuePath } = makeReporter({ streams: { crash: false } });
    reporter.onIncident(record());
    expect(readQueue(queuePath)).toHaveLength(0);
  });
});

// ─── reporter: flush semantics ───

describe("reporter.flush", () => {
  test("success drains the queue and POSTs a batch to the endpoint", async () => {
    const { reporter, fetcher, queuePath } = makeReporter();
    reporter.onIncident(record({ id: "a" }));
    reporter.onIncident(record({ id: "b" }));
    await reporter.flush();

    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0].url).toContain("/ingest");
    const body = fetcher.calls[0].body as { reports: WireReport[] };
    expect(body.reports).toHaveLength(2);
    expect(readQueue(queuePath)).toHaveLength(0); // cleared on 2xx
  });

  test("failure keeps the queue for the next launch", async () => {
    const { reporter, fetcher, queuePath } = makeReporter();
    fetcher.setOk(false);
    reporter.onIncident(record());
    await reporter.flush();
    expect(readQueue(queuePath)).toHaveLength(1); // retained

    // recovers on the next attempt, sending everything
    fetcher.setOk(true);
    await reporter.flush();
    expect(readQueue(queuePath)).toHaveLength(0);
  });

  test("no endpoint reachable / offline never throws", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { reporter, queuePath } = makeReporter({ fetchImpl: throwingFetch });
    reporter.onIncident(record());
    await reporter.flush(); // must resolve, not reject
    expect(readQueue(queuePath)).toHaveLength(1);
  });
});

// ─── reporter: daily heartbeat ───

describe("reporter.maybeHeartbeat", () => {
  test("enqueues one usage report per day and resets counters", () => {
    const { reporter, queuePath } = makeReporter();
    bumpUsage(dir, "sessions", 3);
    bumpUsage(dir, "incidents", 1);

    const first = reporter.maybeHeartbeat(loadTelemetryState(dir));
    expect(first).toBe(true);

    const q = readQueue(queuePath);
    const usage = q.find((r) => r.t === "usage") as Extract<WireReport, { t: "usage" }>;
    expect(usage).toBeTruthy();
    expect(usage.counters.sessions).toBe(3);
    expect(usage.day).toBe("2026-07-08");
    // counters were taken (reset)
    expect(peekUsage(dir)).toEqual({});

    // same day again ⇒ no duplicate
    const second = reporter.maybeHeartbeat(loadTelemetryState(dir));
    expect(second).toBe(false);
    expect(readQueue(queuePath).filter((r) => r.t === "usage")).toHaveLength(1);
  });

  test("usage stream off ⇒ no heartbeat", () => {
    const { reporter, queuePath } = makeReporter({ streams: { usage: false } });
    bumpUsage(dir, "sessions", 1);
    expect(reporter.maybeHeartbeat(loadTelemetryState(dir))).toBe(false);
    expect(readQueue(queuePath)).toHaveLength(0);
  });
});

// ─── recorder → sink seam ───

describe("Recorder.setSink", () => {
  const input: IncidentInput = {
    class: "tool.exec_failure",
    severity: "error",
    component: "tool:bash",
    where: "agent-loop#phaseC",
    message: "boom",
  };

  test("forwards each stored, redacted record to the sink", () => {
    const rec = new Recorder({ dbPath: join(dir, "bb.db"), version: "0.1" });
    const seen: IncidentRecord[] = [];
    rec.setSink((r) => seen.push(r));
    const id = rec.record(input);
    expect(id).toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(seen[0].class).toBe("tool.exec_failure");
    expect(seen[0].fingerprint).toBeTruthy();
    rec.close();
  });

  test("a throwing sink never disables local recording", () => {
    const rec = new Recorder({ dbPath: join(dir, "bb2.db"), version: "0.1" });
    rec.setSink(() => {
      throw new Error("sink blew up");
    });
    const id = rec.record(input);
    expect(id).toBeTruthy(); // record still succeeded
    expect(rec.getStore()?.list({ limit: 10 })).toHaveLength(1); // stored locally
    expect(rec.health().ok).toBe(true); // recorder NOT disabled by sink failure
    rec.close();
  });
});
