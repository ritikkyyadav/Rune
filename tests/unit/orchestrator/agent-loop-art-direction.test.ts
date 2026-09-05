/**
 * The art-direction tripwire.
 *
 * The complaint it answers, from building real sites with Rune: ask for "a
 * comprehensive report with an interactive view" and you get one of the worst
 * interactive views — because the agent says "I'll handle the design" and
 * applies its house style (one accent on a neutral ground) to a scientific lab,
 * a poem, and a music festival alike.
 *
 * The doctrine had said "commit to ONE art direction" for a long time and lost
 * every time, because "commit" reads as "decide" rather than "decide WITH
 * them". So the first screen of anything a person looks at now stops and asks:
 * name the genre, look up how that genre reads today, then put two or three
 * concrete directions to the user — ground, type, and one signature move each.
 *
 * It fires on CREATION only. Editing an existing screen means a look already
 * exists to match, and a run whose look is already pinned is left alone.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** One write of `path` with `tool`, then a wrap-up. */
function gateway(tool: string, path: string) {
  let step = 0;
  return {
    inferStream: mock(async function* () {
      step++;
      if (step === 1) {
        yield ev("tool_use_start", { toolCallId: "w1", toolName: tool });
        yield ev("tool_use_stop", {
          toolCallId: "w1",
          toolInput: { path, content: "<main>hi</main>" },
        });
        yield ev("message_stop", { stopReason: "tool_use" });
        return;
      }
      yield ev("content_delta", { delta: { type: "text_delta", text: "built it" } });
      yield ev("message_stop", { stopReason: "end_turn" });
    }),
    infer: mock(async () => ({ content: [], model: "m", stopReason: "end_turn", usage: {} })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

function registry(withAskUser = true) {
  const tools: Record<string, unknown> = {};
  return {
    toLlmTools: mock(() => [{ name: "write_file", description: "", inputSchema: {} }]),
    get: mock((name: string) => {
      if (name === "ask_user" && !withAskUser) return undefined;
      return {
        schema: {
          name,
          version: "0.1.0",
          description: "",
          inputSchema: { type: "object", properties: {} },
          category: name === "ask_user" ? "execute" : "write",
          permissionLevel: "auto",
        },
        ...(tools[name] ?? {}),
      };
    }),
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: JSON.stringify({ path: "x", hash: "h" }),
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gw: any, taskState: TaskStateStore, withAskUser = true) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 6,
      systemPrompt: "s",
      taskState,
    } as any,
    gw,
    registry(withAskUser),
  );
}

/**
 * The note is prefixed to the write's own tool_result IN THE TRANSCRIPT — the
 * emitted `tool_call_end` event carries the raw tool output, which is the point:
 * the agent reads the note, the UI does not have to render it.
 */
function transcript(loop: AgentLoop): string {
  return loop
    .takePendingPersist()
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((b: any) => b?.toolResultContent ?? b?.text ?? "")
    .join("\n");
}

function freshState(): TaskStateStore {
  const ts = new TaskStateStore();
  ts.beginTurn("build me a report on TP53 with an interactive view");
  return ts;
}

describe("art-direction tripwire", () => {
  test("creating the first screen with no question asked is called out", async () => {
    const loop = makeLoop(gateway("write_file", "index.html"), freshState());
    await collect(loop.run("build it", "s1", "/tmp"));
    const note = transcript(loop);

    expect(note).toContain("its art direction is");
    // It has to be actionable, not a scolding.
    expect(note).toContain("TWO OR THREE concrete");
    expect(note).toContain("ask_user");
    expect(note).toContain("art-directions.md");
    // And it must rule out the non-answer the agent reaches for.
    expect(note).toContain("never bare adjectives");
  });

  test.each([
    ["styles.css"],
    ["app/page.tsx"],
    ["Panel.jsx"],
    ["theme.scss"],
    ["App.vue"],
    ["Card.svelte"],
  ])("it covers %s", async (path) => {
    const loop = makeLoop(gateway("write_file", path), freshState());
    await collect(loop.run("build it", "s1", "/tmp"));
    expect(transcript(loop)).toContain("its art direction is");
  });

  test("non-visual files are none of its business", async () => {
    for (const path of ["server.ts", "data.json", "README.md", "main.py"]) {
      const loop = makeLoop(gateway("write_file", path), freshState());
      await collect(loop.run("build it", "s1", "/tmp"));
      expect({ path, fired: transcript(loop).includes("its art direction is") }).toEqual({
        path,
        fired: false,
      });
    }
  });

  test("editing an existing screen is left alone — a look already exists", async () => {
    const loop = makeLoop(gateway("edit_file", "index.html"), freshState());
    await collect(loop.run("tweak it", "s1", "/tmp"));
    expect(transcript(loop)).not.toContain("its art direction is");
  });

  test("an agent that asked FIRST is left alone", async () => {
    // The sequence the tripwire is trying to produce: ask, then build. Once it
    // has happened, the note would be nagging.
    let step = 0;
    const asked = {
      inferStream: mock(async function* () {
        step++;
        if (step === 1) {
          yield ev("tool_use_start", { toolCallId: "a1", toolName: "ask_user" });
          yield ev("tool_use_stop", {
            toolCallId: "a1",
            toolInput: { question: "Swiss, Editorial, or minimal dark?" },
          });
          yield ev("message_stop", { stopReason: "tool_use" });
          return;
        }
        if (step === 2) {
          yield ev("tool_use_start", { toolCallId: "w1", toolName: "write_file" });
          yield ev("tool_use_stop", {
            toolCallId: "w1",
            toolInput: { path: "index.html", content: "<main/>" },
          });
          yield ev("message_stop", { stopReason: "tool_use" });
          return;
        }
        yield ev("content_delta", { delta: { type: "text_delta", text: "built to Swiss" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }),
      infer: mock(async () => ({ content: [], model: "m", stopReason: "end_turn", usage: {} })),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;

    const loop = makeLoop(asked, freshState());
    await collect(loop.run("build it", "s1", "/tmp"));
    expect(transcript(loop)).not.toContain("its art direction is");
  });

  test("with no ask_user available it stays quiet rather than demanding the impossible", async () => {
    // 4th gear with nobody present. The doctrine still asks for a stated
    // direction there; a harness note telling it to call a tool it does not
    // have would be noise.
    const loop = makeLoop(gateway("write_file", "index.html"), freshState(), false);
    await collect(loop.run("build it", "s1", "/tmp"));
    expect(transcript(loop)).not.toContain("its art direction is");
  });

  test("it fires at most once", async () => {
    let step = 0;
    const gw = {
      inferStream: mock(async function* () {
        step++;
        if (step <= 3) {
          yield ev("tool_use_start", { toolCallId: `w${step}`, toolName: "write_file" });
          yield ev("tool_use_stop", {
            toolCallId: `w${step}`,
            toolInput: { path: `page${step}.html`, content: "<i/>" },
          });
          yield ev("message_stop", { stopReason: "tool_use" });
          return;
        }
        yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }),
      infer: mock(async () => ({ content: [], model: "m", stopReason: "end_turn", usage: {} })),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;

    const loop = makeLoop(gw, freshState());
    await collect(loop.run("build it", "s1", "/tmp"));
    const hits = transcript(loop).split("its art direction is").length - 1;
    expect(hits).toBe(1);
  });
});
