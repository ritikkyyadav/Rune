#!/usr/bin/env bun
/**
 * Live prompt-cache verification, per provider.
 *
 * Unit tests can prove we EMIT a breakpoint. They cannot prove the cache is
 * actually read back — a silently-invalidated prefix and a working one look
 * identical from inside the process. The only distinguishing evidence is a
 * cached-token count coming back from a real second request that shares a
 * prefix with the first.
 *
 *   bun run scripts/verify-cache.ts --provider anthropic
 *   bun run scripts/verify-cache.ts --provider openrouter --model anthropic/claude-haiku-4-5
 *   bun run scripts/verify-cache.ts --provider openrouter --force-breakpoints
 *
 * COST. Each run sends exactly TWO short requests on the cheapest model the
 * provider offers, with a ~1.2k-token prefix and a 32-token completion cap.
 * Nothing here loops. A provider with no credential is SKIPPED, loudly, and
 * exits 2 — never silently, and never by inventing a number.
 *
 * Credentials are read from the environment, falling back to ~/.gear/.env.
 * They are never printed, logged, or copied anywhere.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnthropicProvider } from "../packages/llm-gateway/src/providers/anthropic";
import { OpenAIProvider } from "../packages/llm-gateway/src/providers/openai";
import { OpenRouterProvider } from "../packages/llm-gateway/src/providers/openrouter";
import { GoogleProvider } from "../packages/llm-gateway/src/providers/google";
import { OllamaProvider } from "../packages/llm-gateway/src/providers/ollama";
import { CodexProvider } from "../packages/llm-gateway/src/providers/codex";
import { openCredentialStore, oauthAccount } from "../packages/shared/src/credential-store";
import { cacheBreakpointPolicyFor } from "../packages/llm-gateway/src/providers/cache-policy";
import type {
  InferenceRequest,
  LlmProvider,
  Message,
  ProviderName,
} from "../packages/llm-gateway/src/types";

// ── arguments ────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const PROVIDER = (flag("provider") ?? "openrouter") as ProviderName;

// --force-breakpoints: emit explicit cache_control even for a model the
// adapter would normally leave to implicit upstream caching. Use it to test
// whether a given route benefits from explicit markers, or rejects them.
const FORCE = process.argv.includes("--force-breakpoints");

// ── credentials ──────────────────────────────────────────────────────────

/**
 * Find this provider's credential. Three sources, in the order the CLI itself
 * resolves them: the environment, the ~/.gear/.env sidecar, and the saved-keys
 * map in ~/.gear/secrets.json (what `/keys set` writes).
 *
 * The value is returned and never printed, logged, or written anywhere.
 */
function secret(envVar: string, providerId: string): string | undefined {
  if (process.env[envVar]) return process.env[envVar];
  try {
    const env = readFileSync(join(homedir(), ".gear", ".env"), "utf8");
    const hit = env.match(new RegExp(`^${envVar}=(.+)$`, "m"));
    if (hit?.[1]) return hit[1].trim();
  } catch {
    // no sidecar env file; fall through
  }
  try {
    const raw = readFileSync(join(homedir(), ".gear", "secrets.json"), "utf8");
    const saved = (JSON.parse(raw) as { keys?: Record<string, string> }).keys ?? {};
    if (saved[providerId]) return saved[providerId];
  } catch {
    // no secrets sidecar; the caller reports the miss
  }
  return undefined;
}

// ── the provider table ───────────────────────────────────────────────────

interface Target {
  /** Env var holding the credential, or undefined for a keyless local runtime. */
  envVar?: string;
  /** Provider id whose OAuth blob in the secure store holds the credential. */
  fromStore?: string;
  /** Cheapest model that still reaches the provider's cache minimum. */
  cheapestModel: string;
  build(key: string | undefined, meta?: { accountId?: string }): LlmProvider;
}

const TARGETS: Record<string, Target> = {
  anthropic: {
    envVar: "ANTHROPIC_API_KEY",
    cheapestModel: "claude-haiku-4-5",
    build: (k) => new AnthropicProvider(k),
  },
  openai: {
    envVar: "OPENAI_API_KEY",
    cheapestModel: "gpt-4o-mini",
    build: (k) =>
      new OpenAIProvider(k, undefined, "openai", {
        cacheBreakpoints: cacheBreakpointPolicyFor("openai"),
      }),
  },
  google: {
    envVar: "GOOGLE_API_KEY",
    cheapestModel: "gemini-2.5-flash",
    build: (k) => new GoogleProvider(k),
  },
  openrouter: {
    envVar: "OPENROUTER_API_KEY",
    // A free route: the measurement costs nothing and the cache counters are
    // reported the same way.
    cheapestModel: "minimax/minimax-m3:free",
    build: (k) => new OpenRouterProvider(k),
  },
  deepseek: {
    envVar: "DEEPSEEK_API_KEY",
    cheapestModel: "deepseek-chat",
    build: (k) =>
      new OpenAIProvider(k, "https://api.deepseek.com", "deepseek", {
        cacheBreakpoints: cacheBreakpointPolicyFor("deepseek"),
      }),
  },
  groq: {
    envVar: "GROQ_API_KEY",
    cheapestModel: "llama-3.1-8b-instant",
    build: (k) =>
      new OpenAIProvider(k, "https://api.groq.com/openai/v1", "groq", {
        cacheBreakpoints: cacheBreakpointPolicyFor("groq"),
      }),
  },
  xai: {
    envVar: "XAI_API_KEY",
    cheapestModel: "grok-4-fast",
    build: (k) =>
      new OpenAIProvider(k, "https://api.x.ai/v1", "xai", {
        cacheBreakpoints: cacheBreakpointPolicyFor("xai"),
      }),
  },
  "ollama-turbo": {
    envVar: "OLLAMA_API_KEY",
    cheapestModel: "gpt-oss:20b",
    build: (k) =>
      new OpenAIProvider(k, "https://ollama.com/v1", "ollama-turbo", {
        cacheBreakpoints: cacheBreakpointPolicyFor("ollama-turbo"),
      }),
  },
  // Keyless. Nothing is billed here; what is measured is whether the KV cache
  // SURVIVES between turns, which `keep_alive` is what buys (P8.4).
  ollama: {
    cheapestModel: process.env.GEAR_OLLAMA_MODEL ?? "llama3.1",
    build: () => new OllamaProvider(),
  },
  // The ChatGPT subscription backend. Its credential is an OAuth blob in the
  // secure store rather than an env var, so it resolves through `storeSecret`
  // below. Luna is the cheapest weight in the Codex lineup.
  codex: {
    fromStore: "codex",
    cheapestModel: "gpt-5.6-luna",
    build: (k, meta) => new CodexProvider(k!, meta?.accountId),
  },
};

const target = TARGETS[PROVIDER];
if (!target) {
  console.error(`Unknown provider "${PROVIDER}". Known: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(64);
}

const MODEL = flag("model") ?? target.cheapestModel;

// ── skip cleanly when we cannot reach the provider ───────────────────────

let key: string | undefined;
let meta: { accountId?: string } | undefined;
if (target.fromStore) {
  // The secure store (keychain / secret-service / file fallback). Read, used
  // for one request pair, never printed.
  try {
    const store = await openCredentialStore();
    const raw = await store.get(oauthAccount(target.fromStore));
    const blob = raw ? (JSON.parse(raw) as { secret?: string; accountId?: string }) : undefined;
    key = blob?.secret;
    if (blob?.accountId) meta = { accountId: blob.accountId };
  } catch {
    key = undefined;
  }
  if (!key) {
    console.log(`${PROVIDER}: SKIPPED — no credential in the secure store`);
    process.exit(2);
  }
} else if (target.envVar) {
  key = secret(target.envVar, PROVIDER);
  if (!key) {
    console.log(
      `${PROVIDER}: SKIPPED — no credential (${target.envVar} unset, absent from ` +
        `~/.gear/.env and ~/.gear/secrets.json)`,
    );
    process.exit(2);
  }
} else {
  // A local runtime: reachable or not, decided by asking rather than assuming.
  const base = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const reachable = await fetch(`${base}/api/tags`, {
    signal: AbortSignal.timeout(3_000),
  })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    console.log(`${PROVIDER}: SKIPPED — no local runtime answering at ${base}`);
    process.exit(2);
  }
}

// ── the shared prefix ────────────────────────────────────────────────────

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
    provider: PROVIDER,
    maxTokens: 32,
    stream: false,
    // The stable prefix ends at the last shared message; the question after it
    // is the varying suffix — exactly the shape the agent loop produces.
    cacheBreakpointIndex: stable.length - 1,
  };
}

const provider = target.build(key, meta);

if (FORCE) {
  // Reach into the adapter (or the wrapped one) and open the gate for this run.
  const inner =
    (provider as unknown as { inner?: Record<string, unknown> }).inner ??
    (provider as unknown as Record<string, unknown>);
  inner.wantsCacheBreakpoints = () => true;
}

console.log(`provider: ${PROVIDER}`);
console.log(`model: ${MODEL}`);
console.log(`policy: ${cacheBreakpointPolicyFor(PROVIDER)}`);
console.log(`breakpoints: ${FORCE ? "FORCED on" : "adapter default"}`);
console.log(`prefix: ~${Math.round(PREFIX.length / 4)} tokens\n`);

/**
 * Free routes throttle aggressively, and a 429 says nothing about whether the
 * request SHAPE was accepted — which is the whole point of this script. Retry
 * those; surface everything else immediately.
 *
 * The retries do not add requests to the measurement: a 429 was refused, not
 * served. The BUDGET below is what bounds real traffic.
 */
async function inferWithBackoff(question: string, attempts = 3) {
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
console.log(
  `turn 1  input=${first.usage.inputTokens}  cached=${first.usage.cacheReadTokens ?? 0}` +
    `  written=${first.usage.cacheCreationTokens ?? 0}`,
);

// Give the cache a beat to become visible; the write completes with turn 1.
await new Promise((r) => setTimeout(r, 2_000));

const second = await inferWithBackoff("What is rule 12?");
const cached = second.usage.cacheReadTokens ?? 0;
console.log(
  `turn 2  input=${second.usage.inputTokens}  cached=${cached}` +
    `  written=${second.usage.cacheCreationTokens ?? 0}`,
);

// For Ollama there are no cache counters on the wire at all. What the runtime
// DOES report is prompt_eval_count: the tokens it had to evaluate. A held KV
// cache shows up as turn 2 evaluating far fewer prompt tokens than turn 1
// despite a longer prompt. That is the prefix-reuse evidence for a local
// runtime, and it is what `keep_alive` buys.
if (PROVIDER === "ollama") {
  const reused = second.usage.inputTokens < first.usage.inputTokens;
  console.log(
    `\n${reused ? "PASS" : "INCONCLUSIVE"} — turn 2 evaluated ` +
      `${second.usage.inputTokens} prompt tokens against turn 1's ${first.usage.inputTokens}. ` +
      `A held KV cache re-evaluates only the new suffix.`,
  );
  process.exit(reused ? 0 : 1);
}

if (cached > 0) {
  const rate = ((cached / (cached + second.usage.inputTokens)) * 100).toFixed(1);
  console.log(`\nPASS — the shared prefix was served from cache (${cached} tokens, ${rate}%).`);
  process.exit(0);
}

console.log(
  "\nFAIL — turn 2 reported no cached tokens. Either the prefix is being " +
    "invalidated between turns, this model/route does not cache, or the host " +
    "does not report a cached-token count.",
);
process.exit(1);
