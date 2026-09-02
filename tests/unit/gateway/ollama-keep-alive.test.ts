/**
 * P8.4 — Ollama holds its KV cache between turns, and reports its real window.
 *
 * Two defects, one theme: a local runtime was being treated as if it had no
 * economics.
 *
 * 1. No `keep_alive`. Ollama unloads a model 5 minutes after its last request,
 *    which is shorter than an agent spends reading files and thinking, so the
 *    KV cache was routinely evicted BETWEEN CONSECUTIVE TURNS OF ONE TASK.
 *    Every eviction re-prefills the whole transcript. On a local runtime that
 *    is not a bill, it is wall-clock — the difference between a second and a
 *    minute on a long context.
 *
 * 2. `listModels` returned names only, so every locally pulled model fell to
 *    the tokenizer's conservative default and was compacted far below its real
 *    window.
 */

import { describe, test, expect } from "bun:test";
import { OllamaProvider } from "../../../packages/llm-gateway/src/providers/ollama";
import type { InferenceRequest } from "../../../packages/llm-gateway/src/types";

const request: InferenceRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "llama3.1",
  provider: "ollama",
  maxTokens: 16,
  stream: false,
};

/** Swap in a fetch that records the request body and answers with a canned reply. */
function capturing(): () => Record<string, unknown> {
  let seen: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({
      message: { role: "assistant", content: "ok" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 10,
      eval_count: 2,
    });
  }) as never;
  return () => seen;
}

describe("keep_alive", () => {
  test("every request holds the model and its KV cache for 30 minutes by default", async () => {
    const p = new OllamaProvider("http://localhost:11434");
    const original = globalThis.fetch;
    const body = capturing();
    try {
      await p.infer(request);
    } finally {
      globalThis.fetch = original;
    }
    expect(body().keep_alive).toBe("30m");
  });

  test("the duration is configurable", () => {
    expect(new OllamaProvider("http://localhost:11434", { keepAlive: "2h" }).keepAlive).toBe("2h");
    // "-1" is Ollama's "hold indefinitely"; "0" unloads immediately. Both are
    // legitimate answers for a machine dedicated to one model, or one that is
    // short of VRAM.
    expect(new OllamaProvider("http://localhost:11434", { keepAlive: "-1" }).keepAlive).toBe("-1");
    expect(new OllamaProvider("http://localhost:11434", { keepAlive: "0" }).keepAlive).toBe("0");
  });

  test("an env override wins over the default and loses to an explicit option", () => {
    const prior = process.env.GEAR_OLLAMA_KEEP_ALIVE;
    process.env.GEAR_OLLAMA_KEEP_ALIVE = "45m";
    try {
      expect(new OllamaProvider("http://localhost:11434").keepAlive).toBe("45m");
      expect(new OllamaProvider("http://localhost:11434", { keepAlive: "5m" }).keepAlive).toBe(
        "5m",
      );
    } finally {
      if (prior === undefined) delete process.env.GEAR_OLLAMA_KEEP_ALIVE;
      else process.env.GEAR_OLLAMA_KEEP_ALIVE = prior;
    }
  });
});

describe("the real context window reaches the listing", () => {
  /** /api/tags returns two names; /api/show reports one window each. */
  function fakeRuntime(windows: Record<string, number | undefined>) {
    return async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/api/tags")) {
        return Response.json({ models: Object.keys(windows).map((name) => ({ name })) });
      }
      if (href.endsWith("/api/show")) {
        const { model } = JSON.parse(String(init?.body ?? "{}")) as { model: string };
        const ctx = windows[model];
        if (ctx === undefined) return new Response("nope", { status: 404 });
        return Response.json({ model_info: { "llama.context_length": ctx } });
      }
      return new Response("no", { status: 404 });
    };
  }

  test("listModels carries each model's window, not just its name", async () => {
    const p = new OllamaProvider("http://localhost:11434");
    const original = globalThis.fetch;
    globalThis.fetch = fakeRuntime({ "llama3.1": 131072, "qwen2.5-coder:32b": 32768 }) as never;
    try {
      const models = await p.listModels();
      expect(models).toHaveLength(2);
      expect(models.find((m) => m.id === "llama3.1")?.contextLimit).toBe(131072);
      expect(models.find((m) => m.id === "qwen2.5-coder:32b")?.contextLimit).toBe(32768);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a model whose window cannot be read still appears, with no invented number", async () => {
    const p = new OllamaProvider("http://localhost:11434");
    const original = globalThis.fetch;
    globalThis.fetch = fakeRuntime({ "llama3.1": 131072, "mystery:latest": undefined }) as never;
    try {
      const models = await p.listModels();
      expect(models.map((m) => m.id).sort()).toEqual(["llama3.1", "mystery:latest"]);
      // Undefined, never zero and never a guess: the conservative static floor
      // stands for a model nobody could describe.
      expect(models.find((m) => m.id === "mystery:latest")?.contextLimit).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
