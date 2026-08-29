/**
 * Warp's CLI-agent channel.
 *
 * The failure worth catching here is a malformed body. Warp drops one in
 * silence, so a broken payload leaves a feature that looks implemented, emits
 * bytes, and does nothing — which is exactly the kind of thing that survives
 * for months. These assert the wire format rather than that a call was made.
 */

import { describe, expect, test } from "bun:test";
import { warpNotice, isWarp } from "../../../packages/orchestrator/src/bin/ui/warp";

const inWarp = { TERM_PROGRAM: "WarpTerminal" } as NodeJS.ProcessEnv;
const base = { event: "stop" as const, sessionId: "01a04470", cwd: "/Users/r/Project/evolab2" };

describe("the wire format", () => {
  test("is OSC 777 addressed to warp://cli-agent, BEL-terminated", () => {
    const seq = warpNotice(base, "0.3.0", inWarp);
    expect(seq.startsWith("\x1b]777;notify;warp://cli-agent;")).toBe(true);
    expect(seq.endsWith("\x07")).toBe(true);
  });

  test("carries the fields Warp reads, and identifies the agent as gear", () => {
    const seq = warpNotice(base, "0.3.0", inWarp);
    const body = JSON.parse(seq.slice(seq.indexOf("{"), -1));
    expect(body).toMatchObject({
      v: 1,
      agent: "gear",
      event: "stop",
      session_id: "01a04470",
      cwd: "/Users/r/Project/evolab2",
      project: "evolab2", // the basename, which is what a tab has room for
      plugin_version: "0.3.0",
    });
  });

  test("a payload can never terminate its own sequence", () => {
    // User text reaches this. A raw BEL inside the body would end the OSC
    // early and spray the remainder onto the screen as literal text.
    const seq = warpNotice(
      { ...base, event: "prompt_submit", query: "fix \x07 the \x1b]777;evil thing" },
      "0.3.0",
      inWarp,
    );
    expect(seq.split("\x07")).toHaveLength(2); // exactly one, the terminator
    expect(JSON.parse(seq.slice(seq.indexOf("{"), -1)).query).toContain("evil thing");
  });

  test("long user text is clipped before it leaves the process", () => {
    const seq = warpNotice({ ...base, query: "x".repeat(400) }, "0.3.0", inWarp);
    const body = JSON.parse(seq.slice(seq.indexOf("{"), -1));
    expect(body.query.length).toBeLessThanOrEqual(120);
    expect(body.query.endsWith("...")).toBe(true);
  });

  test("whitespace-only text is omitted rather than sent empty", () => {
    const body = JSON.parse(
      warpNotice({ ...base, query: "   \n  " }, "0.3.0", inWarp).slice(
        warpNotice({ ...base, query: "   \n  " }, "0.3.0", inWarp).indexOf("{"),
        -1,
      ),
    );
    expect(body.query).toBeUndefined();
  });
});

describe("the states that pull a person back", () => {
  const body = (n: Parameters<typeof warpNotice>[0]) =>
    JSON.parse(
      warpNotice(n, "0.3.0", inWarp).slice(warpNotice(n, "0.3.0", inWarp).indexOf("{"), -1),
    );

  test("an approval reports the pending call, not just that something stopped", () => {
    // Warp turns this into the blocked badge. Without the tool name the
    // notification says a pane wants something and not what, which is the
    // difference between switching tabs and switching tabs usefully.
    expect(
      body({
        ...base,
        event: "permission_request",
        toolName: "bash",
        summary: "rm -rf build/",
        toolInput: "rm -rf build/",
      }),
    ).toMatchObject({
      event: "permission_request",
      tool_name: "bash",
      summary: "rm -rf build/",
      tool_input: "rm -rf build/",
    });
  });

  test("a question carries the question", () => {
    expect(body({ ...base, event: "idle_prompt", summary: "Which database?" })).toMatchObject({
      event: "idle_prompt",
      summary: "Which database?",
    });
  });

  test("the unblock names the tool that finished", () => {
    expect(body({ ...base, event: "tool_complete", toolName: "edit_file" })).toMatchObject({
      event: "tool_complete",
      tool_name: "edit_file",
    });
  });

  test("summary and tool_input are clipped like every other field carrying user text", () => {
    const b = body({
      ...base,
      event: "permission_request",
      summary: "s".repeat(400),
      toolInput: "i".repeat(400),
    });
    expect(b.summary.length).toBeLessThanOrEqual(120);
    expect(b.tool_input.length).toBeLessThanOrEqual(120);
  });

  test("a blocked payload can no more terminate its own sequence than any other", () => {
    const seq = warpNotice(
      { ...base, event: "permission_request", summary: "run \x07 \x1b]777;evil" },
      "0.3.0",
      inWarp,
    );
    expect(seq.split("\x07")).toHaveLength(2);
  });
});

describe("nobody else hears it", () => {
  test("nothing is emitted outside Warp", () => {
    for (const env of [
      {},
      { TERM_PROGRAM: "Apple_Terminal" },
      { TERM_PROGRAM: "iTerm.app" },
      { TERM: "xterm-256color" },
    ] as NodeJS.ProcessEnv[]) {
      expect(warpNotice(base, "0.3.0", env)).toBe("");
    }
  });

  test("Warp is detected case-insensitively and by nothing else", () => {
    expect(isWarp({ TERM_PROGRAM: "WarpTerminal" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isWarp({ TERM_PROGRAM: "warpterminal" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isWarp({ TERM_PROGRAM: "Warp" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWarp({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
