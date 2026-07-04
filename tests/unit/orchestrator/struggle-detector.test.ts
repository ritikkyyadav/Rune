import { beforeEach, describe, expect, test } from "bun:test";
import { StruggleDetector } from "../../../packages/orchestrator/src/struggle-detector";
import type { IncidentInput } from "../../../packages/shared/src/incident";

let incidents: IncidentInput[];
let det: StruggleDetector;

beforeEach(() => {
  incidents = [];
  det = new StruggleDetector((i) => incidents.push(i));
  det.beginRun();
});

const classes = () => incidents.map((i) => i.class);

describe("read thrash", () => {
  test("fires once at the 3rd read of the same file, not before, not again", () => {
    det.onToolCall("read_file", { path: "a.ts" }, true);
    det.onToolCall("read_file", { path: "a.ts" }, true);
    expect(incidents.length).toBe(0);
    det.onToolCall("read_file", { path: "a.ts" }, true);
    expect(classes()).toEqual(["struggle.thrash_reads"]);
    det.onToolCall("read_file", { path: "a.ts" }, true);
    expect(incidents.length).toBe(1);
  });

  test("an edit resets the same-file read counter (read→edit→read is healthy)", () => {
    det.onToolCall("read_file", { path: "a.ts" }, true);
    det.onToolCall("read_file", { path: "a.ts" }, true);
    det.onToolCall("edit_file", { path: "a.ts" }, true);
    det.onToolCall("read_file", { path: "a.ts" }, true);
    det.onToolCall("read_file", { path: "a.ts" }, true);
    expect(classes()).not.toContain("struggle.thrash_reads");
  });

  test("different files never cross-contaminate", () => {
    for (const p of ["a.ts", "b.ts", "c.ts"]) det.onToolCall("read_file", { path: p }, true);
    expect(incidents.length).toBe(0);
  });
});

describe("edit churn and search thrash", () => {
  test("4th successful edit of one file fires churn", () => {
    for (let i = 0; i < 4; i++) det.onToolCall("edit_file", { path: "x.ts" }, true);
    expect(classes()).toEqual(["struggle.thrash_edits"]);
  });

  test("failed edits do not count toward churn", () => {
    for (let i = 0; i < 6; i++) det.onToolCall("edit_file", { path: "x.ts" }, false);
    expect(incidents.length).toBe(0);
  });

  test("3rd identical grep fires search thrash", () => {
    for (let i = 0; i < 3; i++) det.onToolCall("grep", { pattern: "handleAuth" }, true);
    expect(classes()).toEqual(["struggle.thrash_search"]);
  });
});

describe("rephrase and correction", () => {
  test("near-identical consecutive user messages fire rephrase", () => {
    det.onUserMessage("please fix the failing login test in the auth service");
    det.onUserMessage("fix the failing login test in the auth service please");
    expect(classes()).toEqual(["struggle.rephrase"]);
  });

  test("a correction opener fires correction, not rephrase", () => {
    det.onUserMessage("add a retry to the fetch call");
    det.onUserMessage("no, that's wrong — I meant the upload fetch");
    expect(classes()).toEqual(["struggle.correction"]);
  });

  test("unrelated follow-ups fire nothing; first message never fires", () => {
    det.onUserMessage("add a retry to the fetch call");
    det.onUserMessage("now write a README for the project");
    expect(incidents.length).toBe(0);
  });

  test("short messages are never called rephrases", () => {
    det.onUserMessage("yes do it");
    det.onUserMessage("do it yes");
    expect(incidents.length).toBe(0);
  });
});

describe("interrupts and todos", () => {
  test("second abort in one run fires interrupt burst once", () => {
    det.onAbort();
    expect(incidents.length).toBe(0);
    det.onAbort();
    expect(classes()).toEqual(["struggle.interrupt_burst"]);
    det.onAbort();
    expect(incidents.length).toBe(1);
  });

  test("unfinished todos at run end fire debug-severity signal", () => {
    det.onRunEnd([
      { content: "write tests", status: "completed" },
      { content: "wire the api", status: "in_progress" },
      { content: "update docs", status: "pending" },
    ]);
    expect(classes()).toEqual(["struggle.todo_unfinished"]);
    expect(incidents[0].severity).toBe("debug");
    expect(incidents[0].message).toContain("2/3");
  });

  test("all-done todos and no todos fire nothing", () => {
    det.onRunEnd([{ content: "a", status: "completed" }]);
    det.onRunEnd(null);
    det.onRunEnd([]);
    expect(incidents.length).toBe(0);
  });
});

describe("run isolation", () => {
  test("beginRun resets counters but rephrase still compares across runs", () => {
    det.onToolCall("read_file", { path: "a.ts" }, true);
    det.onToolCall("read_file", { path: "a.ts" }, true);
    det.onUserMessage("please refactor the session manager to use uuids");
    det.beginRun();
    det.onToolCall("read_file", { path: "a.ts" }, true);
    expect(incidents.length).toBe(0); // counter reset — no thrash
    det.onUserMessage("refactor the session manager to use uuids please");
    expect(classes()).toEqual(["struggle.rephrase"]); // prev message survived
  });

  test("a throwing reporter never propagates", () => {
    const bad = new StruggleDetector(() => {
      throw new Error("reporter bug");
    });
    bad.beginRun();
    for (let i = 0; i < 3; i++) bad.onToolCall("read_file", { path: "a.ts" }, true);
    bad.onAbort();
    bad.onAbort();
    bad.onRunEnd([{ content: "x", status: "pending" }]);
    // reaching here without a throw is the assertion
    expect(true).toBe(true);
  });
});
