#!/usr/bin/env bun
/**
 * Live prompt-cache verification against OpenRouter.
 *
 * Unit tests can prove we EMIT a breakpoint. They cannot prove the cache is
 * actually read back — a silently-invalidated prefix and a working one look
 * identical from inside the process. The only distinguishing evidence is
 * `cached_tokens` coming back from a real second request that shares a prefix
 * with the first.
 *
 * Sends two small requests through the real OpenRouterProvider (a few cents at
 * most) and asserts the second reports a cache read.
 *
 *   bun run scripts/verify-cache.ts [--model stealth/ox-alpha] [--force-breakpoints]
 *
 * The key is read from OPENROUTER_API_KEY, falling back to ~/.gear/.env.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenRouterProvider } from "../packages/llm-gateway/src/providers/openrouter";
import type { InferenceRequest, Message } from "../packages/llm-gateway/src/types";

function resolveKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const env = readFileSync(join(homedir(), ".gear", ".env"), "utf8");
    const hit = env.match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (hit?.[1]) return hit[1].trim();
  } catch {
    // fall through to the explicit error below
  }
  throw new Error("No OPENROUTER_API_KEY in the environment or ~/.gear/.env");
}

const modelArg = process.argv.indexOf("--model");
const MODEL = modelArg > -1 ? process.argv[modelArg + 1]! : "stealth/ox-alpha";

// --force-breakpoints: emit explicit cache_control even for a model the
// adapter would normally leave to implicit upstream caching. Use it to test
// whether a given route benefits from explicit markers, or rejects them.
const FORCE = process.argv.includes("--force-breakpoints");

// Every run gets a unique prefix. Without this, a previous run's cache is
// still warm and turn 1 reports a hit — which makes the turn-1 → turn-2
// comparison meaningless and can flatter a change that did nothing.
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// The cacheable prefix must clear the provider's minimum (~1024 tokens) or it
// silently will not cache and the run proves nothing.
const PREFIX = [
  `Session ${RUN_ID}.`,
  ...Array.from(
    { length: 220 },
    (_, i) =>
      `Rule ${i}: when the analyzer encounters directive ${i}, it records the span and continues.`,
  ),
].join("\n");

const stable: Message[] = [
  { role: "user", content: [{ type: "text", text: `Reference material:\n${PREFIX}` }] },
  { role: "assistant", content: [{ type: "text", text: "Understood. Ready." }] },
];

function request(question: string): InferenceRequest {
  return {
    messages: [...stable, { role: "user", content: [{ type: "text", text: question }] }],
    system: "You answer in at most five words.",
    model: MODEL,
    provider: "openrouter",
    maxTokens: 32,
    stream: false,
    // The stable prefix ends at the last shared message; the question after it
    // is the varying suffix — exactly the shape the agent loop produces.
    cacheBreakpointIndex: stable.length - 1,
  };
}

const provider = new OpenRouterProvider(resolveKey());

if (FORCE) {
  // Reach into the wrapped OpenAI adapter and open the gate for this run only.
  const inner = (provider as unknown as { inner: Record<string, unknown> }).inner;
  inner.wantsCacheBreakpoints = () => true;
}

console.log(`model: ${MODEL}`);
console.log(`breakpoints: ${FORCE ? "FORCED on" : "adapter default"}`);
console.log(`prefix: ~${Math.round(PREFIX.length / 4)} tokens\n`);

/**
 * Free OpenRouter routes throttle aggressively, and a 429 says nothing about
 * whether the request SHAPE was accepted — which is the whole point of this
 * script. Retry those; surface everything else immediately.
 */
async function inferWithBackoff(question: string, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      return await provider.infer(request(question));
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 429 || i >= attempts - 1) throw err;
      const waitMs = 15_000 * (i + 1);
      console.log(`  (429 rate-limited, retrying in ${waitMs / 1000}s)`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

const first = await inferWithBackoff("What is rule 7?");
console.log(`turn 1  input=${first.usage.inputTokens}  cached=${first.usage.cacheReadTokens ?? 0}`);

// Give the cache a beat to become visible; the write completes with turn 1.
await new Promise((r) => setTimeout(r, 2_000));

const second = await inferWithBackoff("What is rule 12?");
const cached = second.usage.cacheReadTokens ?? 0;
console.log(`turn 2  input=${second.usage.inputTokens}  cached=${cached}`);

if (cached > 0) {
  console.log(`\nPASS — the shared prefix was served from cache (${cached} tokens).`);
  process.exit(0);
}

console.log(
  "\nFAIL — turn 2 reported no cached tokens. Either the prefix is being " +
    "invalidated between turns, this model/route does not cache, or the host " +
    "does not report prompt_tokens_details.cached_tokens.",
);
process.exit(1);
