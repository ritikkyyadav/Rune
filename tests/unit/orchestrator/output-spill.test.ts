/**
 * R5.2 of docs/program/rune-reliability-plan-20261014.md: a tool result over
 * the transcript cap is saved whole, and the marker for the elided middle says
 * where — so the model reads it with read_file instead of re-running a
 * four-minute suite to see one stack trace.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop, truncateForTranscript } from "../../../packages/orchestrator/src/agent-loop";
import {
  pruneSpills,
  SPILL_KEEP,
  spillOutput,
} from "../../../packages/orchestrator/src/output-spill";

const made: string[] = [];
const fresh = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `rune-spill-${tag}-`));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const big = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");

describe("spillOutput", () => {
  test("saves the whole text, ignored by git, and returns a workspace-relative path", () => {
    const ws = fresh("ws");
    const dir = join(ws, ".rune", "outputs");
    const text = big(2_000);
    const rel = spillOutput(ws, dir, "s1-call/1", text);
    expect(rel).toBe(join(".rune", "outputs", "s1-call_1.txt"));
    expect(readFileSync(join(ws, rel!), "utf8")).toBe(text);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("*");
  });

  test("leaves a git work tree clean", () => {
    const ws = fresh("git");
    execFileSync("git", ["init", "-q"], { cwd: ws });
    spillOutput(ws, join(ws, ".rune", "outputs"), "s1-c1", big(1_000));
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: ws,
      encoding: "utf8",
    });
    expect(status).toBe("");
  });

  test("keeps only the newest", () => {
    const dir = join(fresh("prune"), "outputs");
    for (let i = 0; i < 5; i++) {
      spillOutput(dir, dir, `o${i}`, `output ${i}`);
      // Distinct, ordered modification times.
      utimesSync(join(dir, `o${i}.txt`), new Date(), new Date(Date.now() + i * 1000));
    }
    pruneSpills(dir, 2);
    const left = readdirSync(dir)
      .filter((f) => f.endsWith(".txt"))
      .sort();
    expect(left).toEqual(["o3.txt", "o4.txt"]);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
  });

  test("saving prunes as it goes", () => {
    const ws = fresh("keep");
    const dir = join(ws, "out");
    for (let i = 0; i < SPILL_KEEP + 3; i++) spillOutput(ws, dir, `o${i}`, `output ${i}`);
    expect(readdirSync(dir).filter((f) => f.endsWith(".txt"))).toHaveLength(SPILL_KEEP);
  });

  test("a place it cannot write gives null, not an error", () => {
    expect(spillOutput("/", "/dev/null/outputs", "x", "text")).toBeNull();
  });
});

describe("truncateForTranscript", () => {
  const text = big(2_000);

  test("under the cap, untouched", () => {
    expect(truncateForTranscript("short", () => "never")).toBe("short");
  });

  test("with a saved copy, the marker says where to read the middle", () => {
    const out = truncateForTranscript(text, () => ".rune/outputs/s1-c1.txt");
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain("is saved at .rune/outputs/s1-c1.txt");
    expect(out).toContain("read_file");
    expect(out).not.toContain("Re-run with a narrower pattern");
    expect(out.startsWith(text.slice(0, 1_000))).toBe(true);
    expect(out.endsWith(text.slice(-1_000))).toBe(true);
  });

  test("when the save fails, or there is none, the old advice stands", () => {
    expect(truncateForTranscript(text, () => null)).toContain("Re-run with a narrower pattern");
    expect(truncateForTranscript(text)).toContain("Re-run with a narrower pattern");
  });
});

describe("the loop saves a long result and points the model at it", () => {
  test("the next request carries the path, and the file holds every line", async () => {
    const ws = fresh("loop");
    const spillDir = join(ws, ".rune", "outputs");
    const long = big(3_000);
    const requests: string[] = [];
    let calls = 0;
    const gateway = {
      inferStream: async function* (req: unknown) {
        calls++;
        requests.push(JSON.stringify(req));
        if (calls === 1) {
          yield { type: "tool_use_start", toolCallId: "suite", toolName: "bash" };
          yield { type: "tool_use_stop", toolCallId: "suite", toolInput: { command: "bun test" } };
          yield {
            type: "message_stop",
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        yield { type: "content_start", contentIndex: 0 };
        yield { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text: "ok" } };
        yield { type: "content_stop", contentIndex: 0 };
        yield {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as any;
    const registry = {
      toLlmTools: () => [],
      get: (name: string) => ({
        schema: {
          name,
          version: "0.1.0",
          description: "",
          inputSchema: { type: "object", properties: {} },
          category: "read",
          permissionLevel: "auto",
        },
      }),
      execute: async (i: { toolName: string; callId: string }) => ({
        callId: i.callId,
        toolName: i.toolName,
        success: true,
        result: long,
        durationMs: 1,
      }),
    } as any;
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 5,
        maxConsecutiveErrors: 3,
        systemPrompt: "s",
        suspendClock: false,
        outputSpillDir: spillDir,
      } as any,
      gateway,
      registry,
    );
    for await (const _ of loop.run("run the suite", "sess", ws)) {
      // drain
    }
    const saved = join(".rune", "outputs", "sess-suite.txt");
    expect(requests[1]).toContain(`is saved at ${saved}`);
    expect(readFileSync(join(ws, saved), "utf8")).toBe(long);
  });
});
