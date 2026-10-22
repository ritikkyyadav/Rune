/**
 * The request check (A3, `request-check.ts`): what it is shown, how its
 * answer is read, when it declines to say, and the arbiter's rule for the one
 * re-prompt a missing ask buys.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUEST_DIFF_CAP,
  changeDiff,
  filesChangedSince,
  parseRequestCheck,
  requestCheckPrompt,
  requestRepromptBody,
  runRequestCheck,
} from "../../../packages/orchestrator/src/request-check";
import { requestRepair } from "../../../packages/orchestrator/src/arbiter";
import { FileHistory } from "../../../packages/orchestrator/src/file-history";

const dirs: string[] = [];
const fresh = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("parseRequestCheck: the checker's answer, read strictly", () => {
  test("every ask, and the ones not done with what is missing", () => {
    const outcome = parseRequestCheck(
      JSON.stringify({
        asks: [
          { ask: "add a tags field", done: true, evidence: "notes.ts adds tags" },
          { ask: "quote fields RFC 4180", done: false, evidence: "toCsv never quotes" },
        ],
      }),
    );
    expect(outcome).toEqual({
      asks: 2,
      missing: [{ ask: "quote fields RFC 4180", why: "toCsv never quotes" }],
    });
  });

  test("an answer wrapped in prose or a code fence is still read", () => {
    const text =
      'Here is my answer:\n```json\n{"asks":[{"ask":"a","done":true,"evidence":"x"}]}\n```';
    expect(parseRequestCheck(text)).toEqual({ asks: 1, missing: [] });
  });

  test("not the JSON asked for: null", () => {
    for (const text of [
      "",
      "everything looks done",
      "{not json}",
      '{"asks": "all done"}',
      '{"asks": []}',
      '{"asks":[{"ask":"a","done":"yes"}]}',
      '{"asks":[{"ask":"","done":true}]}',
    ]) {
      expect(parseRequestCheck(text)).toBeNull();
    }
  });

  test("malformed items are skipped, well-formed ones kept", () => {
    expect(
      parseRequestCheck(
        '{"asks":[{"ask":"a","done":true},{"done":false},{"ask":"b","done":false}]}',
      ),
    ).toEqual({ asks: 2, missing: [{ ask: "b", why: "" }] });
  });
});

describe("changeDiff: exactly what the run changed", () => {
  test("a changed file, a new one and a deleted one", () => {
    const { diff, omitted } = changeDiff([
      { path: "src/a.ts", before: "one\ntwo\n", after: "one\n2\n" },
      { path: "src/new.ts", before: null, after: "export {};\n" },
      { path: "src/gone.ts", before: "x\n", after: null },
    ]);
    expect(omitted).toEqual([]);
    expect(diff).toContain("--- a/src/a.ts");
    expect(diff).toContain("-two");
    expect(diff).toContain("+2");
    expect(diff).toContain("(new file)");
    expect(diff).toContain("+export {};");
    expect(diff).toContain("--- a/src/gone.ts\n+++ /dev/null\n(deleted)");
  });

  test("a file written and put back is no change", () => {
    expect(changeDiff([{ path: "a.ts", before: "x\n", after: "x\n" }]).diff).toBe("");
  });

  test("what does not fit under the cap is named, not cut", () => {
    const big = "x\n".repeat(REQUEST_DIFF_CAP);
    const { omitted } = changeDiff([
      { path: "small.ts", before: "a\n", after: "b\n" },
      { path: "huge.ts", before: null, after: big },
    ]);
    expect(omitted).toEqual(["huge.ts"]);
  });
});

describe("runRequestCheck: when it says, and when it declines", () => {
  const files = [{ path: "a.ts", before: "a\n", after: "b\n" }];
  const answer = '{"asks":[{"ask":"change a","done":true,"evidence":"a.ts"}]}';

  test("the request and the change go to the checker; its answer comes back", async () => {
    let sent = "";
    const result = await runRequestCheck({
      request: "change a to b",
      files,
      otherChanged: ["generated.json"],
      ask: async (_system, user) => {
        sent = user;
        return answer;
      },
    });
    expect(result).toEqual({ outcome: { asks: 1, missing: [] } });
    expect(sent).toContain("change a to b");
    expect(sent).toContain("+b");
    expect(sent).toContain("generated.json");
  });

  test("declines: no request, nothing changed, a change too large, a failed call, a bad answer", async () => {
    const ok = async () => answer;
    expect(
      await runRequestCheck({ request: " ", files, otherChanged: [], ask: ok }),
    ).toHaveProperty("skipped");
    expect(
      await runRequestCheck({ request: "r", files: [], otherChanged: [], ask: ok }),
    ).toHaveProperty("skipped");
    const huge = [{ path: "h.ts", before: null, after: "x\n".repeat(REQUEST_DIFF_CAP) }];
    expect(
      await runRequestCheck({ request: "r", files: huge, otherChanged: [], ask: ok }),
    ).toHaveProperty("skipped");
    const throws = async () => {
      throw new Error("503");
    };
    expect(
      await runRequestCheck({ request: "r", files, otherChanged: [], ask: throws }),
    ).toHaveProperty("skipped");
    expect(
      await runRequestCheck({
        request: "r",
        files,
        otherChanged: [],
        ask: async () => "looks good",
      }),
    ).toHaveProperty("skipped");
  });

  test("part of a change is never checked as the whole of it", async () => {
    // One small file and one that does not fit: the checker shown only the
    // first would report the second's asks missing, and buy a re-prompt for it.
    const huge = { path: "h.ts", before: null, after: "x\n".repeat(REQUEST_DIFF_CAP) };
    let asked = false;
    const result = await runRequestCheck({
      request: "r",
      files: [files[0]!, huge],
      otherChanged: [],
      ask: async () => {
        asked = true;
        return answer;
      },
    });
    expect(result).toHaveProperty("skipped");
    expect(asked).toBe(false);
  });

  test("the prompt asks for omissions strictly and forbids invented requirements", () => {
    const prompt = requestCheckPrompt("do x", "diff", []);
    expect(prompt).toContain("Be strict about omissions");
    expect(prompt).toContain("do not invent requirements");
    expect(prompt).not.toContain("These files also changed");
  });

  test("the checks the runtime watched pass are listed, and settle an ask to run them", async () => {
    let sent = "";
    await runRequestCheck({
      request: "add tests and run them",
      files,
      otherChanged: [],
      passedChecks: ["bun run test", "bun test mine.test.ts"],
      ask: async (_system, user) => {
        sent = user;
        return answer;
      },
    });
    expect(sent).toContain("These checks ran during the run and passed");
    expect(sent).toContain("- bun test mine.test.ts");
    expect(sent).toContain(
      "An ask to run tests or checks is done when a check listed above covers it",
    );
    expect(requestCheckPrompt("r", "d", [])).not.toContain("These checks ran during the run");
  });

  test("the re-prompt names each missing ask in the checker's words", () => {
    const body = requestRepromptBody([{ ask: "update the changelog", why: "not in the change" }]);
    expect(body).toContain("- update the changelog — not in the change");
    expect(body).toContain("say so in one line instead");
  });
});

describe("filesChangedSince: what a shell command wrote during the run", () => {
  const git = (root: string, ...args: string[]) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

  test("changed after the run began, not shown, not Rune's own: listed", () => {
    const root = fresh("rune-request-check-git-");
    git(root, "init", "-q");
    writeFileSync(join(root, "old.ts"), "before the run\n");
    writeFileSync(join(root, "shown.ts"), "shown\n");
    const start = Date.now();
    // The person's own uncommitted work, from before the run: dated earlier.
    const past = new Date(start - 60_000);
    utimesSync(join(root, "old.ts"), past, past);
    writeFileSync(join(root, "generated.json"), "{}\n");
    mkdirSync(join(root, ".rune"), { recursive: true });
    writeFileSync(join(root, ".rune", "state.json"), "{}\n");
    const listed = filesChangedSince(root, start - 1_000, new Set(["shown.ts"]));
    expect(listed).toEqual(["generated.json"]);
  });

  test("outside a git repository: nothing", () => {
    expect(filesChangedSince(fresh("rune-request-check-nogit-"), 0, new Set())).toEqual([]);
  });
});

describe("FileHistory.beforeImages: the run's before-images", () => {
  test("what each file held before the turn first wrote it, once per file", () => {
    const home = fresh("rune-request-check-history-");
    const ws = fresh("rune-request-check-ws-");
    const history = new FileHistory(home);
    writeFileSync(join(ws, "a.ts"), "original\n");
    history.snapshot("s1", 7, ws, "a.ts");
    writeFileSync(join(ws, "a.ts"), "edited once\n");
    history.snapshot("s1", 7, ws, "a.ts"); // the same turn: kept once
    history.snapshot("s1", 7, ws, "new.ts"); // did not exist
    history.snapshot("s1", 9, ws, "a.ts"); // a later turn: not this one's
    expect(history.beforeImages("s1", 7)).toEqual([
      { path: join(ws, "a.ts"), before: "original\n" },
      { path: join(ws, "new.ts"), before: null },
    ]);
    expect(history.beforeImages("s1", 8)).toEqual([]);
  });
});

describe("requestRepair: the arbiter's rule for the one re-prompt", () => {
  test("missing asks, budget left: one re-prompt", () => {
    expect(
      requestRepair({ missing: true, repromptsUsed: 0, maxReprompts: 1, turnsLeft: 5 }).transition,
    ).toBe("repairing");
  });

  test("spent, or no turn left: partial with the asks named", () => {
    expect(
      requestRepair({ missing: true, repromptsUsed: 1, maxReprompts: 1, turnsLeft: 5 }).transition,
    ).toBe("complete(partial)");
    expect(
      requestRepair({ missing: true, repromptsUsed: 0, maxReprompts: 1, turnsLeft: 0 }).transition,
    ).toBe("complete(partial)");
  });

  test("nothing missing: work goes on; an input absent: unknown, never a guess", () => {
    expect(
      requestRepair({ missing: false, repromptsUsed: 0, maxReprompts: 1, turnsLeft: 5 }).transition,
    ).toBe("working");
    expect(requestRepair({ missing: true }).transition).toBe("unknown");
  });
});

describe("a small change to a long file is read, not left out (2026-10-22)", () => {
  test("a 9-line edit to a 7,802-line file fits, with room to spare", () => {
    // The live re-run on 1.4.13: the end-of-turn checks all passed, then the
    // request check skipped ("1 file(s) would be left out") because this edit
    // to agent-loop.ts came out as a 737,609-character whole-file rewrite.
    const before = Array.from({ length: 7802 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const after = before
      .replace("const line3600 = 3600;", "const line3600 = 'model_unavailable';")
      .replace("const line3655 = 3655;", "const line3655 = 3655; // handoff reason");
    const { diff, omitted } = changeDiff([
      { path: "packages/orchestrator/src/agent-loop.ts", before, after },
    ]);
    expect(omitted).toEqual([]);
    expect(diff.length).toBeLessThan(2_000);
    expect(diff).toContain("+const line3600 = 'model_unavailable';");
  });
});
