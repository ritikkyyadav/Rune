/**
 * Pixels a TOOL produced reaching the model.
 *
 * Gear could always see an image the USER pasted; it could never see one it
 * made itself. `image-attach.ts` says so in its own header — "tool results and
 * session replay still carry text only" — and `read_file` on a PNG returned
 * ~327 KB of lossy-decoded mojibake, so the one path that existed was actively
 * destructive.
 *
 * What that cost, in EvoLab-3: the agent built a whole scientific UI it could
 * not look at, ran `open http://127.0.0.1:3001/` to hand the browser to the
 * user, and shipped a phylogenetic tree rendered as a raw Newick string inside
 * a <code> tag. It typechecks. The tests pass. The field IS consumed. Every
 * automated gate goes green, because no automated gate can tell you something
 * looks like garbage.
 *
 * The contract now: a tool attachment becomes a real image block in the next
 * user message — and where the transport cannot carry one, the agent is told
 * plainly that it did NOT see the file, because a silently dropped screenshot
 * is worse than none.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const PIXELS = "iVBORw0KGgoAAAANSUhEUg==";

/** Turn 1 reads a screenshot; turn 2 answers. */
function gateway(sent: any[][]) {
  let i = 0;
  return {
    inferStream: mock(async function* (request: { messages: any[] }) {
      sent.push(request.messages);
      i++;
      if (i === 1) {
        yield ev("tool_use_start", { toolCallId: "c1", toolName: "read_file" });
        yield ev("tool_use_stop", { toolCallId: "c1", toolInput: { path: "shots/home.png" } });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", {
          delta: { type: "text_delta", text: "The header is cut off." },
        });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({ content: [], model: "m", stopReason: "end_turn", usage: {} })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

/** A read_file that behaves like the real one on an image. */
function registry(withAttachment = true) {
  return {
    toLlmTools: mock(() => [{ name: "read_file", description: "", inputSchema: {} }]),
    get: mock(() => ({
      schema: {
        name: "read_file",
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: JSON.stringify({
        path: "shots/home.png",
        kind: "image",
        media_type: "image/png",
        content: "[image] shots/home.png · image/png · 12.0 KB — the pixels are attached below.",
      }),
      durationMs: 1,
      ...(withAttachment && {
        attachments: [
          { kind: "image", mediaType: "image/png", data: PIXELS, label: "shots/home.png" },
        ],
      }),
    })),
  } as any;
}

function makeLoop(gw: any, provider: string, reg = registry()) {
  return new AgentLoop(
    {
      model: "m",
      provider,
      maxTokens: 100,
      maxTurns: 6,
      systemPrompt: "s",
    } as any,
    gw,
    reg,
  );
}

describe("a tool's image reaches the model as pixels", () => {
  test("the next request carries a real image block", async () => {
    const sent: any[][] = [];
    await collect(makeLoop(gateway(sent), "anthropic").run("check the page", "s1", "/tmp"));

    // The second request is the one that has to contain the image.
    const blocks = sent[1]!.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
    const image = blocks.find((b: any) => b.type === "image");

    expect(image).toBeDefined();
    expect(image.mediaType).toBe("image/png");
    expect(image.data).toBe(PIXELS);
  });

  test("the pixels never appear as text in the transcript", async () => {
    // The whole defect in one assertion: base64 in a tool_result is a context
    // bomb, not a picture.
    const sent: any[][] = [];
    await collect(makeLoop(gateway(sent), "anthropic").run("check the page", "s1", "/tmp"));

    const textOnly = sent[1]!
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .filter((b: any) => b.type === "text" || b.type === "tool_result")
      .map((b: any) => b.text ?? b.toolResultContent ?? "")
      .join("\n");

    expect(textOnly).not.toContain(PIXELS);
    // The description still comes through, so the agent knows what it is looking at.
    expect(textOnly).toContain("shots/home.png");
  });

  test("the attachment is captioned as ground truth, not as a description", async () => {
    const sent: any[][] = [];
    await collect(makeLoop(gateway(sent), "anthropic").run("check the page", "s1", "/tmp"));

    const texts = sent[1]!
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    expect(texts).toContain("These are the real pixels");
    expect(texts).toContain("only what you can actually see");
  });

  test("on a transport that drops images, the agent is told it did NOT see the file", async () => {
    // Ollama's native translation understands text and tool calls only. Sending
    // the block anyway would leave the agent describing an interface it never
    // saw — the exact fabrication the doctrine forbids.
    const sent: any[][] = [];
    await collect(makeLoop(gateway(sent), "ollama").run("check the page", "s1", "/tmp"));

    const blocks = sent[1]!.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
    expect(blocks.find((b: any) => b.type === "image")).toBeUndefined();

    const texts = blocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    expect(texts).toContain("you have NOT seen this file");
    expect(texts).toContain("Do not describe its contents");
  });

  test("a tool with no attachment changes nothing", async () => {
    const sent: any[][] = [];
    await collect(
      makeLoop(gateway(sent), "anthropic", registry(false)).run("read it", "s1", "/tmp"),
    );

    const blocks = sent[1]!.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
    expect(blocks.find((b: any) => b.type === "image")).toBeUndefined();
    const texts = blocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    expect(texts).not.toContain("Attached from your last tool call");
    expect(texts).not.toContain("NOT attached");
  });
});
