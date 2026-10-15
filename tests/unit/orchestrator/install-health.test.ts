/**
 * What `rune doctor` says about the install itself (R7.6 of
 * docs/program/rune-reliability-plan-20261014.md), and the dry-run-first
 * prune of old builds (decision D5: the founder's to apply).
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  applyBuildPrune,
  listOldBuilds,
  planBuildPrune,
  sessionDbCheck,
  verifySignature,
} from "../../../packages/orchestrator/src/install-health";

const made: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "rune-install-health-"));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function binWith(stamps: number[]): string {
  const bin = fresh();
  for (const name of ["rune", "rune-compiled", "rune-tools"]) {
    writeFileSync(join(bin, name), `current ${name}`);
    writeFileSync(join(bin, `${name}.backup`), `rollback ${name}`);
  }
  for (const stamp of stamps) {
    for (const name of ["rune", "rune-compiled", "rune-tools", "rune-compiled.meta"]) {
      writeFileSync(join(bin, `${name}.backup-${stamp}`), "x".repeat(10));
    }
  }
  return bin;
}

describe("old builds", () => {
  test("grouped by install, newest first, and never the plain .backup", () => {
    const builds = listOldBuilds(binWith([100, 300, 200]));
    expect(builds.map((b) => b.stamp)).toEqual(["300", "200", "100"]);
    expect(builds[0]!.files).toHaveLength(4);
    expect(builds[0]!.bytes).toBe(40);
    expect(builds.flatMap((b) => b.files).some((f) => f.endsWith(".backup"))).toBe(false);
  });

  test("a prune keeps the newest and removes the rest, whole installs at a time", () => {
    const bin = binWith([100, 200, 300, 400, 500]);
    const plan = planBuildPrune(listOldBuilds(bin), 3);
    expect(plan.keep.map((b) => b.stamp)).toEqual(["500", "400", "300"]);
    expect(plan.remove.map((b) => b.stamp)).toEqual(["200", "100"]);
    expect(plan.bytes).toBe(80);

    expect(applyBuildPrune(plan.remove)).toEqual([]);
    expect(listOldBuilds(bin).map((b) => b.stamp)).toEqual(["500", "400", "300"]);
    // The rollback target and the running build are untouched.
    for (const name of ["rune", "rune-compiled", "rune-tools"]) {
      expect(existsSync(join(bin, name))).toBe(true);
      expect(existsSync(join(bin, `${name}.backup`))).toBe(true);
    }
  });

  test("nothing kept is nothing listed; a missing folder is an empty one", () => {
    expect(listOldBuilds(binWith([]))).toEqual([]);
    expect(listOldBuilds(join(fresh(), "absent"))).toEqual([]);
  });
});

describe("signatures", () => {
  test("only macOS has one to check", () => {
    expect(verifySignature("/x", "linux")).toBeNull();
  });

  test("valid, or what codesign said", () => {
    const valid = verifySignature("/x", "darwin", (() => ({ status: 0, stderr: "" })) as never);
    expect(valid).toEqual({ ok: true, detail: "valid" });
    const broken = verifySignature("/x", "darwin", (() => ({
      status: 1,
      stderr: "/x: invalid signature (code or signature have been modified)\n",
    })) as never);
    expect(broken?.ok).toBe(false);
    expect(broken?.detail).toContain("invalid signature");
  });
});

describe("the session database", () => {
  test("an intact one is ok", () => {
    const path = join(fresh(), "rune.db");
    const db = new Database(path);
    db.run("CREATE TABLE t (x)");
    db.run("INSERT INTO t VALUES (1)");
    db.close();
    expect(sessionDbCheck(path)).toBe("ok");
  });

  test("one whose pages are damaged says what quick_check found", () => {
    const path = join(fresh(), "rune.db");
    const db = new Database(path);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
    db.run("CREATE INDEX t_body ON t(body)");
    const insert = db.prepare("INSERT INTO t (body) VALUES (?)");
    for (let i = 0; i < 2000; i++) insert.run(`row ${i} ${"x".repeat(50)}`);
    db.close();
    // An invalid page type on page 3: the file opens, and quick_check reports it.
    const fd = openSync(path, "r+");
    writeSync(fd, Buffer.from([0xff]), 0, 1, 4096 * 2);
    closeSync(fd);
    const found = sessionDbCheck(path);
    expect(found).not.toBe("ok");
    expect(found).toContain("page 3");
  });

  test("one that is not a database says so", () => {
    const path = join(fresh(), "rune.db");
    writeFileSync(path, "this is not a database file at all, not even close");
    expect(sessionDbCheck(path)).not.toBe("ok");
  });
});
