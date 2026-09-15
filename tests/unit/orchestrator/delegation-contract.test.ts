/**
 * M4 deliverable C — a child gets a bounded contract, and cannot grant itself
 * acceptance.
 *
 * Two exit tests, and they are about opposite things:
 *
 *   R5  a worker that reports "done" with no bound check moves nothing. The
 *       guarantee is MECHANICAL, not a prompt: a worker's registry has no
 *       `record_evidence` and its permission check refuses anything that is
 *       not read or write, so there is no path from a child's prose to a
 *       criterion's rung. The prompt paragraph exists so the child does not
 *       spend its turns trying.
 *   —   the bounded contract itself: the criteria it owns by id and text, its
 *       owned files, its share of the budget, and the sentence that says it
 *       returns evidence rather than a verdict.
 *
 * Zero model calls; nothing here starts a loop.
 */

import { describe, expect, test } from "bun:test";

import {
  WORKER_TOOL_SCHEMA,
  boundedContractBlock,
  buildWorkerRegistry,
  createWorkerPermissionCheck,
  Ownership,
} from "../../../packages/orchestrator/src/worker";
import { criterionStatus } from "../../../packages/orchestrator/src/contract";

// ─── The bounded subset of the contract ───

describe("the bounded contract a child is given", () => {
  const OWNED = [
    { id: "c1", text: "the CSV importer accepts a file with a BOM" },
    { id: "c3", text: "a malformed row is reported with its line number" },
  ];

  test("it carries the criteria the child owns, by id AND text", () => {
    const block = boundedContractBlock(
      ["c1", "c3"],
      OWNED,
      "src/import/",
      { costCapUsd: 0.5, deadlineMs: 300_000 },
      12,
    );
    expect(block).toContain("c1: the CSV importer accepts a file with a BOM");
    expect(block).toContain("c3: a malformed row is reported with its line number");
  });

  test("it carries the owned files and the share of the budget", () => {
    const block = boundedContractBlock(
      ["c1"],
      OWNED,
      "src/import/",
      {
        costCapUsd: 0.5,
        deadlineMs: 300_000,
      },
      12,
    );
    expect(block).toContain("src/import/");
    expect(block).toContain("12 turns");
    expect(block).toContain("$0.50");
    expect(block).toContain("300s");
  });

  test("it says the child returns evidence, never a verdict", () => {
    const block = boundedContractBlock(["c1"], OWNED, "src/", {}, 8);
    expect(block).toContain("Return EVIDENCE, not a verdict");
    expect(block).toContain("you cannot");
    expect(block).toContain("combined");
  });

  test("an id whose text is unavailable is carried as an id, never invented", () => {
    const block = boundedContractBlock(["c1", "c9"], OWNED, "src/", {}, 8);
    expect(block).toContain("c9: (its text was not available here)");
    // And nothing was borrowed from the criterion next to it.
    expect(block.split("c9:")[1]).not.toContain("BOM");
  });

  test("criteria are OPTIONAL on the tool — a dispatch without them is unchanged", () => {
    const required = WORKER_TOOL_SCHEMA.inputSchema.required as string[];
    expect(required).toEqual(["prompt", "files"]);
    const props = WORKER_TOOL_SCHEMA.inputSchema.properties as Record<string, unknown>;
    expect(props.criteria).toBeDefined();
  });
});

// ─── R5 — child prose cannot grant acceptance ───

describe("R5 — a child's report moves no criterion", () => {
  const ownership = new Ownership("/tmp/ws", ["src/a.ts"]);

  test("a worker's registry has no `record_evidence`, and no tool that could reach one", () => {
    const registry = buildWorkerRegistry("rune-tools", ownership);
    const names = registry.list().map((s) => s.name);
    expect(names).not.toContain("record_evidence");
    expect(names).not.toContain("read_back");
    expect(names).not.toContain("todo_write");
    // Not a denylist that someone has to remember to extend: the registry is
    // built from an ALLOWLIST of read and write tools, so a new evidence tool
    // is absent from a worker by construction.
    for (const name of names) {
      const handler = registry.get(name);
      expect(["read", "write", "execute"]).toContain(handler!.schema.category);
    }
  });

  test("the permission check refuses anything that is not a read or a write", async () => {
    const registry = buildWorkerRegistry("rune-tools", ownership);
    const check = createWorkerPermissionCheck(registry);
    const unknown = await check({ callId: "1", toolName: "record_evidence", args: {} });
    expect(unknown.allowed).toBe(false);
    expect(unknown.reason).toContain("Unknown tool");
  });

  test("a criterion with no evidence is `unassessed`, whatever a child reported", () => {
    // The other half of R5, stated where it is actually decided. A worker can
    // write "done, all criteria met" in its report; the rung is derived from
    // the runtime's own records, and there are none.
    expect(criterionStatus({ text: "the importer accepts a BOM", rung: null })).toBe("unassessed");
    // Not even a rung the model somehow set moves it: the status reads the
    // EVIDENCE, and a rung without evidence is a claim about nothing.
    expect(criterionStatus({ text: "the importer accepts a BOM", rung: "verified" })).toBe(
      "unassessed",
    );
  });
});
