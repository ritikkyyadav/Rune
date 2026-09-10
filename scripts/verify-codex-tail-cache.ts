#!/usr/bin/env bun
/**
 * Does a trailing user message stop the Codex backend from extending the
 * prompt cache through a tool loop?
 *
 * Background (Pilot H, 2026-09-09, gpt-5.6-sol): Rune's request items were a
 * byte-identical prefix of the next request's items, yet `cached_tokens`
 * froze at the last request that had NO ephemeral tail block and never grew
 * again — nine completions re-billed the whole conversation tail. The one
 * thing every stalled request shared was ending in a `user` message (the
 * plan-ledger tail). The Codex CLI, which never ends a tool-loop request on a
 * user message, extends its cache every turn on the same backend.
 *
 * This runs the same four-step tool loop three ways on one model:
 *   control    the loop the Codex CLI sends — ends on function_call_output
 *   user-tail  Rune's current shape — a ledger block as a trailing user message
 *   folded     the candidate fix — the same block appended to the last tool output
 * and prints the cached-token count each request came back with. Each variant
 * has its own system prompt so no variant can hit another's cache.
 *
 *   bun run scripts/verify-codex-tail-cache.ts [--model gpt-5.6-sol] [--turns 4] [--pause 8]
 *
 * COST: 3 × turns short requests at low reasoning effort on the subscription
 * route (about 2k prompt tokens each, tens of output tokens). Nothing loops
 * beyond `--turns`. No credential is printed; a 429 exits 3 and says so.
 */

import { CodexProvider } from "../packages/llm-gateway/src/providers/codex";
import { openCredentialStore, oauthAccount } from "../packages/shared/src/credential-store";
import type {
  ContentBlock,
  InferenceRequest,
  Message,
  ToolDefinition,
} from "../packages/llm-gateway/src/types";
import { ApiError } from "../packages/llm-gateway/src/types";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const MODEL = flag("model") ?? "gpt-5.6-sol";
const TURNS = Math.max(2, Math.min(8, Number(flag("turns") ?? 4)));
// Seconds to wait between requests. The backend writes its cache after the
// response; back-to-back requests can race that write and read as misses that
// have nothing to do with prompt shape. Rune's own turns are 7–30 s apart.
const PAUSE_MS = Math.max(0, Number(flag("pause") ?? 8)) * 1000;

// ── credential: the OAuth blob in the secure store, used and never printed ──
let token: string | undefined;
let accountId: string | undefined;
try {
  const store = await openCredentialStore();
  const raw = await store.get(oauthAccount("codex"));
  const blob = raw ? (JSON.parse(raw) as { secret?: string; accountId?: string }) : undefined;
  token = blob?.secret;
  accountId = blob?.accountId;
} catch {
  token = undefined;
}
if (!token) {
  console.log("codex: SKIPPED — no credential in the secure store");
  process.exit(2);
}
// One provider per variant: each gets its own session id, so its own
// `prompt_cache_key`, and no variant can evict or feed another's cache.
const providerFor = () => new CodexProvider(token!, accountId);

// ── the loop ──────────────────────────────────────────────────────────────
const TOOL: ToolDefinition = {
  name: "probe",
  description: "Records one probe step. Call it with the next integer.",
  inputSchema: {
    type: "object",
    properties: { x: { type: "integer", description: "the step number" } },
    required: ["x"],
  },
};

/** ~1.5k tokens of stable filler so the prompt clears the 1024-token cache floor. */
function systemPrompt(variant: string): string {
  const para =
    "You are a deterministic tool-loop fixture. Respond ONLY with a single call to the tool " +
    "`probe`, with x equal to the next integer starting at 1, until a tool output says STOP. " +
    "Never write prose before STOP. Never call the tool twice in one response. When a tool " +
    "output says STOP, reply with the single word done. ";
  return `[variant ${variant}]\n` + para.repeat(24);
}

const LEDGER =
  "[Task state — maintained by the harness, not a user message]\n" +
  `Goal: call probe ${TURNS} times, one call per response, then say done.\n` +
  "Todos (0/1 done):\n  [ ] every probe step recorded";

type Variant = "control" | "user-tail" | "folded";

/**
 * Each tool output carries ~700 tokens of deterministic log so every turn
 * grows the prompt well past the 128-token cache granularity — a stalled cache
 * then shows as a frozen count under a growing prompt. The output also drives
 * the loop itself, so a low-effort model cannot end it early.
 */
function toolOutput(turn: number): string {
  const next =
    turn < TURNS
      ? `NEXT ACTION (mandatory, no prose): call probe with x=${turn + 1}.`
      : "STOP. Reply with the single word done.";
  const log = Array.from(
    { length: 40 },
    (_, i) => `step ${turn} line ${i + 1}: sample ${(turn * 7919 + i * 104729) % 100000} recorded`,
  ).join("\n");
  return `ok ${turn}. Recorded ${turn} of ${TURNS}. ${next}\n--- log ---\n${log}`;
}

interface Row {
  variant: Variant;
  turn: number;
  prompt: number;
  cached: number;
  calls: number;
  stop: string;
}

async function runVariant(variant: Variant): Promise<Row[]> {
  const rows: Row[] = [];
  const provider = providerFor();
  // The stored transcript — what Rune keeps in `this.messages`.
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "Begin the probe loop now." }] },
  ];
  for (let turn = 1; turn <= TURNS; turn++) {
    if (turn > 1 && PAUSE_MS > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    // Build the request exactly like the agent loop: stored history first,
    // then the ephemeral tail — as a user message (Rune today), folded into
    // the last tool output (the candidate), or nothing (the Codex CLI shape).
    let messages: Message[] = [...history];
    const last = messages[messages.length - 1]!;
    if (variant === "user-tail" && last.role === "tool") {
      messages = [...messages, { role: "user", content: [{ type: "text", text: LEDGER }] }];
    } else if (variant === "folded" && last.role === "tool") {
      const blocks = [...last.content];
      const idx = blocks.length - 1;
      const tail = blocks[idx]!;
      if (tail.type === "tool_result") {
        blocks[idx] = { ...tail, toolResultContent: `${tail.toolResultContent}\n\n${LEDGER}` };
      }
      messages = [...messages.slice(0, -1), { role: "tool", content: blocks }];
    }
    const request: InferenceRequest = {
      messages,
      system: systemPrompt(variant),
      tools: [TOOL],
      model: MODEL,
      provider: "codex",
      maxTokens: 2048,
      stream: true,
      thinking: { enabled: true, effort: "low" },
    };

    // Consume the stream the way the loop does, keeping reasoning items IN
    // ORDER so they replay verbatim before the call they produced.
    const content: ContentBlock[] = [];
    let text = "";
    let stop = "";
    let prompt = 0;
    let cached = 0;
    const toolNames = new Map<string, string>();
    try {
      for await (const ev of provider.inferStream(request)) {
        if (ev.type === "redacted_thinking") {
          if (text) {
            content.push({ type: "text", text });
            text = "";
          }
          content.push({ type: "redacted_thinking", data: ev.data, provider: ev.provider });
        } else if (ev.type === "content_delta") {
          text += ev.delta.text;
        } else if (ev.type === "tool_use_start") {
          toolNames.set(ev.toolCallId, ev.toolName);
        } else if (ev.type === "tool_use_stop") {
          if (text) {
            content.push({ type: "text", text });
            text = "";
          }
          content.push({
            type: "tool_use",
            toolCallId: ev.toolCallId,
            toolName: toolNames.get(ev.toolCallId) ?? "",
            toolInput: ev.toolInput,
          });
        } else if (ev.type === "message_stop") {
          stop = ev.stopReason;
          cached = ev.usage.cacheReadTokens ?? 0;
          prompt = ev.usage.inputTokens + cached;
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        console.log(
          `${variant} turn ${turn}: QUOTA (429) — stopping; rows above are the whole measurement. ${err.message.slice(0, 160)}`,
        );
        process.exit(3);
      }
      throw err;
    }
    if (text) content.push({ type: "text", text });
    const calls = content.filter((b) => b.type === "tool_use");
    rows.push({ variant, turn, prompt, cached, calls: calls.length, stop });
    // Print as we go: a quota refusal on the last request must not take the
    // earlier rows with it.
    const prevRow = rows[rows.length - 2];
    console.log(
      `${variant.padEnd(10)} turn ${turn}  prompt=${prompt}  cached=${cached}` +
        (prevRow
          ? `  prev-prompt=${prevRow.prompt}  ${cached >= prevRow.prompt - 384 ? "extended" : "STALLED"}`
          : ""),
    );
    if (calls.length === 0) {
      const said = content.find((b) => b.type === "text");
      console.log(
        `${variant} turn ${turn}: no tool call (stop=${stop}); model said: ${said && said.type === "text" ? JSON.stringify(said.text.slice(0, 120)) : "<nothing>"}`,
      );
    }
    history.push({ role: "assistant", content });
    if (calls.length === 0) break;
    history.push({
      role: "tool",
      content: calls.map((c) => ({
        type: "tool_result" as const,
        toolCallId: (c as { toolCallId: string }).toolCallId,
        toolResultContent: toolOutput(turn),
      })),
    });
  }
  return rows;
}

const all: Row[] = [];
for (const variant of ["control", "folded", "user-tail"] as Variant[]) {
  all.push(...(await runVariant(variant)));
}

console.log(`\nmodel ${MODEL}, ${TURNS} turns per variant, effort low\n`);
console.log("variant    turn  prompt  cached  hit%   prev-prompt  extended?");
let prev: Row | undefined;
for (const r of all) {
  const samePrev = prev && prev.variant === r.variant ? prev : undefined;
  const pct = r.prompt ? Math.round((100 * r.cached) / r.prompt) : 0;
  const extended =
    samePrev == null ? "-" : r.cached >= samePrev.prompt - 384 ? "yes" : "NO (stalled)";
  console.log(
    `${r.variant.padEnd(10)} ${String(r.turn).padStart(4)}  ${String(r.prompt).padStart(6)}  ${String(r.cached).padStart(6)}  ${String(pct).padStart(3)}%  ${String(samePrev?.prompt ?? "-").padStart(11)}  ${extended}${r.calls !== 1 ? `  (${r.calls} calls, stop=${r.stop})` : ""}`,
  );
  prev = r;
}
console.log(
  "\nRead: a variant whose later turns show 'yes' is being cached through the loop; a variant\n" +
    "whose cached count freezes while prompt grows is re-billing its whole tail every turn.",
);
