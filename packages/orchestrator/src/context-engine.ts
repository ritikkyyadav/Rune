import type { Message, ContentBlock, ToolDefinition } from "@alan/llm-gateway";
import { LlmGateway } from "@alan/llm-gateway";
import type { ProviderName } from "@alan/llm-gateway";
import { TokenCounter, countTokens, getContextLimit } from "./tokenizer";

// ─── Context Budget Configuration ───

export interface ContextBudget {
  /** Maximum total tokens for the prompt. */
  maxTokens: number;
  /** Fraction of budget for the working set (system + recent turns + pinned). */
  workingSetRatio: number;
  /** Fraction of budget for session memory (summaries, discoveries). */
  sessionMemoryRatio: number;
  /** Fraction of budget for retrieved context (index, embeddings). */
  retrievalRatio: number;
}

const DEFAULT_BUDGET: ContextBudget = {
  maxTokens: 100_000,
  workingSetRatio: 0.55,
  sessionMemoryRatio: 0.25,
  retrievalRatio: 0.2,
};

// Safe, cheap default model per provider for the summary fallback path (used
// only when the active provider can't be reached). Keep to broadly-available,
// inexpensive models so a fallback summary never trips a subscription gate.
const SUMMARY_FALLBACK_MODELS: Partial<Record<ProviderName, string>> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  google: "gemini-2.5-flash",
  openrouter: "qwen/qwen3-coder:free",
  groq: "llama-3.3-70b-versatile",
  xai: "grok-2-latest",
  deepseek: "deepseek-chat",
  "ollama-turbo": "qwen3-coder:480b",
  ollama: "llama3",
};

// ─── Context Items ───

export type ContextItemKind =
  | "system_prompt"
  | "tool_schemas"
  | "user_message"
  | "assistant_message"
  | "tool_message"
  | "pinned_file"
  | "session_summary"
  | "discovery"
  | "plan"
  | "retrieved_chunk";

export interface ContextItem {
  kind: ContextItemKind;
  content: string;
  /** Estimated token count. */
  tokens: number;
  /** Relevance score (0-1). Higher = more likely to keep. */
  relevance: number;
  /** Recency: 0 = most recent, higher = older. */
  age: number;
  /** If true, never evict this item. */
  pinned: boolean;
  /** Original message or metadata, for reconstruction. */
  source?: Message | Record<string, unknown>;
}

// ─── Session Memory ───

export interface SessionMemory {
  /** Rolling summaries of older conversation turns. */
  summaries: Array<{
    fromSeq: number;
    toSeq: number;
    summary: string;
    tokens: number;
  }>;
  /** Facts the agent has discovered about the workspace. */
  discoveries: Array<{
    fact: string;
    source: string; // e.g., "read_file services/auth/jwt.go"
    createdAt: number;
  }>;
}

// ─── Built Prompt ───

export interface BuiltPrompt {
  messages: Message[];
  system: string;
  tools: ToolDefinition[];
  /** Tokens used by the built prompt. */
  totalTokens: number;
  /** Items that were evicted to fit budget. */
  evictedCount: number;
}

// ─── Context Engine ───

export class ContextEngine {
  private budget: ContextBudget;
  private memory: SessionMemory;
  private pinnedFiles: Map<string, { content: string; tokens: number }> = new Map();
  private summarizeTurnsThreshold: number;
  private gateway: LlmGateway;
  private summarizerModel: string;
  private summarizerProvider: ProviderName;
  private tokenCounter: TokenCounter;
  private config: {
    budget?: Partial<ContextBudget>;
    summarizeTurnsThreshold?: number;
    summarizerModel?: string;
    summarizerProvider?: ProviderName;
  };
  private lastTokenUsage: { used: number; limit: number } | null = null;
  // Set by requestCompaction() (the compact_context tool / an explicit user
  // ask): forces the next shouldCompact()/compactWorkingSet() pair to run
  // regardless of the usage high-water mark. Consumed by compactWorkingSet.
  private compactRequested = false;

  constructor(
    config: {
      budget?: Partial<ContextBudget>;
      summarizeTurnsThreshold?: number;
      summarizerModel?: string;
      summarizerProvider?: ProviderName;
    },
    gateway: LlmGateway,
  ) {
    this.config = config;
    this.budget = { ...DEFAULT_BUDGET, ...config.budget };
    this.memory = { summaries: [], discoveries: [] };
    this.summarizeTurnsThreshold = config.summarizeTurnsThreshold ?? 10;
    this.gateway = gateway;
    this.summarizerModel = config.summarizerModel ?? "claude-haiku-4-5-20251001";
    this.summarizerProvider = config.summarizerProvider ?? "anthropic";
    this.tokenCounter = new TokenCounter();
  }

  /**
   * Point summarization at a specific provider/model — normally the active
   * session model, which is guaranteed registered and working. Without this the
   * summarizer falls back to its anthropic/claude-haiku default and fails for
   * everyone without an Anthropic key (the root cause of "/compress does
   * nothing"). The Engine calls this whenever the model or provider changes.
   */
  setSummarizer(model: string, provider: ProviderName): void {
    if (model) this.summarizerModel = model;
    if (provider) this.summarizerProvider = provider;
  }

  /**
   * Refresh the gateway reference. The Engine rebuilds its gateway on every key
   * edit / provider toggle, which would otherwise leave this holding a stale one
   * (so a freshly added key never reaches the summarizer).
   */
  setGateway(gateway: LlmGateway): void {
    this.gateway = gateway;
  }

  // ─── Pinned Files ───

  pinFile(path: string, content: string): void {
    this.pinnedFiles.set(path, {
      content,
      tokens: this.tokenCounter.countTokens(content),
    });
  }

  unpinFile(path: string): void {
    this.pinnedFiles.delete(path);
  }

  // ─── Discoveries ───

  addDiscovery(fact: string, source: string): void {
    // Deduplicate by fact content
    const existing = this.memory.discoveries.find((d) => d.fact === fact);
    if (!existing) {
      this.memory.discoveries.push({
        fact,
        source,
        createdAt: Date.now(),
      });
    }
  }

  getDiscoveries(): string[] {
    return this.memory.discoveries.map((d) => d.fact);
  }

  // ─── Build Prompt ───

  /**
   * Assemble the final prompt for an LLM call, respecting the token budget.
   *
   * Priority order (highest first):
   * 1. System prompt + tool schemas (always included)
   * 2. Active plan (if any)
   * 3. Pinned files
   * 4. Last N user/assistant turns (most recent first)
   * 5. Session summaries (compressed older turns)
   * 6. Discoveries
   * 7. Retrieved chunks (from index/embeddings)
   */
  buildPrompt(
    systemPrompt: string,
    tools: ToolDefinition[],
    messages: Message[],
    plan?: { description: string; tokens: number },
    retrievedChunks?: Array<{ content: string; relevance: number }>,
  ): BuiltPrompt {
    // ── Invariants (learned the hard way) ──
    // 1. Conversation messages are NEVER individually evicted. Dropping one
    //    message can orphan a tool_use/tool_result pair, which providers
    //    reject with a 400. Shrinking the history is compactWorkingSet()'s
    //    job — it summarizes at a pair-safe cut point instead of punching
    //    holes in the transcript.
    // 2. The system prompt is returned BYTE-IDENTICAL to what was passed in.
    //    Appending anything time-varying (discoveries, summaries) invalidates
    //    the provider's prompt-prefix cache on every call, re-billing the
    //    whole conversation each turn.
    // Auxiliary context (plan, pinned files, discoveries, retrieved chunks)
    // competes for the leftover budget and is delivered as a single context
    // message BEFORE the conversation, so it stays cache-stable relative to
    // the growing suffix.

    const systemTokens = this.tokenCounter.countTokens(systemPrompt);
    const toolTokens = this.tokenCounter.countTokens(JSON.stringify(tools));
    const messageTokens = messages.reduce(
      (sum, m) => sum + this.tokenCounter.countTokens(messageToString(m)),
      0,
    );

    // ── Auxiliary items compete for whatever budget remains ──
    const aux: ContextItem[] = [];
    if (plan) {
      aux.push({
        kind: "plan",
        content: `[Active plan]\n${plan.description}`,
        tokens: plan.tokens,
        relevance: 0.95,
        age: 0,
        pinned: false,
      });
    }
    for (const [path, file] of this.pinnedFiles) {
      aux.push({
        kind: "pinned_file",
        content: `[Pinned: ${path}]\n${file.content}`,
        tokens: file.tokens,
        relevance: 0.9,
        age: 0,
        pinned: false,
      });
    }
    for (const disc of this.memory.discoveries) {
      aux.push({
        kind: "discovery",
        content: `[Discovery] ${disc.fact} (from: ${disc.source})`,
        tokens: this.tokenCounter.countTokens(disc.fact) + 10,
        relevance: 0.5,
        age: Math.floor((Date.now() - disc.createdAt) / 60000), // minutes
        pinned: false,
      });
    }
    if (retrievedChunks) {
      for (const chunk of retrievedChunks) {
        aux.push({
          kind: "retrieved_chunk",
          content: chunk.content,
          tokens: this.tokenCounter.countTokens(chunk.content),
          relevance: chunk.relevance,
          age: 50,
          pinned: false,
        });
      }
    }

    const auxBudget = Math.max(
      0,
      this.budget.maxTokens - systemTokens - toolTokens - messageTokens,
    );
    const keptAux: ContextItem[] = [];
    let auxUsed = 0;
    const scoredAux = aux
      .map((item) => ({ item, score: item.relevance / (1 + item.age * 0.05) }))
      .sort((a, b) => b.score - a.score);
    for (const { item } of scoredAux) {
      if (auxUsed + item.tokens <= auxBudget) {
        keptAux.push(item);
        auxUsed += item.tokens;
      }
    }
    const evictedCount = aux.length - keptAux.length;

    // ── Assemble: aux context (if any) as one message ahead of the history ──
    const finalMessages: Message[] = [];
    if (keptAux.length > 0) {
      finalMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `[Session context]\n${keptAux.map((i) => i.content).join("\n\n")}`,
          },
        ],
      });
    }
    finalMessages.push(...messages);

    const totalTokens = systemTokens + toolTokens + messageTokens + auxUsed;

    // Heuristic estimate — overwritten by noteRealUsage() as soon as the
    // provider reports authoritative counts for the request we send.
    this.lastTokenUsage = {
      used: totalTokens,
      limit: this.budget.maxTokens,
    };

    return {
      messages: finalMessages,
      system: systemPrompt,
      tools,
      totalTokens,
      evictedCount,
    };
  }

  /**
   * Record REAL token usage reported by the provider for the last request.
   * Authoritative — replaces the buildPrompt() heuristic, and switches the
   * compaction limit to the model's actual context window. Calls with a
   * non-positive input count are ignored (some providers omit usage on
   * streamed responses).
   */
  noteRealUsage(
    usage: { inputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number },
    model: string,
  ): void {
    const used =
      usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
    if (used <= 0) return;
    this.lastTokenUsage = { used, limit: getContextLimit(model) };
  }

  // ─── Rolling Summarization ───

  /**
   * Check if older turns should be summarized and compress them.
   * Call this after each turn to keep the context manageable.
   *
   * @deprecated Callers should prefer compactWorkingSet() which actually
   * removes the summarized messages from the working set instead of only
   * appending a summary to session memory (token bloat).
   */
  async maybeSummarize(messages: Message[]): Promise<boolean> {
    // Only summarize if we have enough messages
    if (messages.length < this.summarizeTurnsThreshold) {
      return false;
    }

    // Summarize the oldest half of messages
    const toSummarize = messages.slice(0, Math.floor(messages.length / 2));
    if (toSummarize.length < 4) return false;

    const summaryText = await this.generateSummary(toSummarize);
    if (!summaryText) return false;

    this.memory.summaries.push({
      fromSeq: 0,
      toSeq: toSummarize.length,
      summary: summaryText,
      tokens: this.tokenCounter.countTokens(summaryText),
    });

    return true;
  }

  /**
   * Compact the working set by summarizing old messages and returning a
   * shorter list that still contains the most-recent verbatim turns.
   *
   * CONTRACT C1 — stable public API for other agents.
   *
   * Algorithm:
   * 1. If messages.length < summarizeTurnsThreshold → return unchanged.
   * 2. Determine the "keep recent" window: the last `recentK` messages
   *    that form a COMPLETE set (no orphaned tool_use/tool_result pairs).
   * 3. Summarize everything before that window using generateSummary().
   * 4. Return [ summaryMessage, ...recentMessages ] so the caller can
   *    replace its message array in-place — the working set SHRINKS.
   *
   * Invariants guaranteed:
   * - Every assistant message with a tool_use block has its matching
   *   tool_result present (same toolCallId).
   * - No orphan tool_result messages appear without their tool_use.
   * - The summary message is role "user" (safe across all providers).
   *
   * @param messages  The current full message history (chronological order).
   * @param recentK   How many of the most-recent messages to keep verbatim.
   *                  Defaults to 6. The cut point is adjusted upward when
   *                  needed to avoid splitting a tool_use/tool_result pair.
   * @returns { messages, compacted }
   *   - messages: the new (shorter) array if compacted, or the original array.
   *   - compacted: true when summarization actually happened.
   */
  async compactWorkingSet(
    messages: Message[],
    recentK: number = 6,
    opts?: {
      /**
       * Compact even below the turn threshold (context-overflow recovery:
       * the request was REJECTED by the provider, so shrinking is mandatory).
       */
      force?: boolean;
    },
  ): Promise<{ messages: Message[]; compacted: boolean }> {
    // An explicit request (compact_context tool) forces this attempt, and is
    // consumed either way so a fruitless compaction can't retrigger forever.
    const force = opts?.force === true || this.compactRequested;
    this.compactRequested = false;

    // ── 1. Below-threshold guard ──
    if (!force && messages.length < this.summarizeTurnsThreshold) {
      return { messages, compacted: false };
    }

    // ── 2. Find a safe cut point ──
    // We want to keep the last `recentK` messages verbatim, but we must not
    // split a tool_use/tool_result pair.  We scan forward from the naive cut
    // point until we land on a boundary that is safe.
    const safeCutPoint = findSafeCutPoint(messages, recentK);

    // If we can't carve off at least 4 messages (2 when forced), bail out.
    if (safeCutPoint < (force ? 2 : 4)) {
      return { messages, compacted: false };
    }

    const toSummarize = messages.slice(0, safeCutPoint);
    const toKeep = messages.slice(safeCutPoint);

    // ── 3. Summarise the old portion ──
    // Comprehensive (resume-grade) summary: after compaction this text is the
    // agent's ONLY record of everything before the kept tail. The old 3-5
    // bullet summary amnesia'd the run — goals, file paths, and decisions
    // vanished mid-task.
    const summaryText = await this.generateSummary(toSummarize, { comprehensive: true });
    if (!summaryText) {
      return { messages, compacted: false };
    }

    // ── 4. Build the summary message (role "user" — safe across providers) ──
    const summaryMessage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `[Earlier conversation summary]\n${summaryText}`,
        },
      ],
    };

    // Also persist to session memory so buildPrompt() can use it.
    this.memory.summaries.push({
      fromSeq: 0,
      toSeq: safeCutPoint,
      summary: summaryText,
      tokens: this.tokenCounter.countTokens(summaryText),
    });

    return {
      messages: [summaryMessage, ...toKeep],
      compacted: true,
    };
  }

  /**
   * Summarize an ENTIRE conversation into one comprehensive summary, used by
   * the manual `/compress` command. Unlike compactWorkingSet (which keeps the
   * most-recent turns verbatim), this collapses everything into a single
   * summary detailed enough to resume the work from the summary alone.
   *
   * @param messages     Full conversation history (chronological).
   * @param instructions Optional user-supplied focus, e.g. "keep API details".
   * @returns the summary plus token counts, or null when there is nothing to
   *          summarize or generation failed.
   */
  async summarizeConversation(
    messages: Message[],
    instructions?: string,
  ): Promise<{ summary: string; sourceTokens: number; summaryTokens: number } | null> {
    if (messages.length === 0) return null;

    const summary = await this.generateSummary(messages, {
      instructions,
      comprehensive: true,
    });
    if (!summary) return null;

    const sourceTokens = this.tokenCounter.countTokens(
      messages.map((m) => messageToString(m)).join("\n"),
    );
    const summaryTokens = this.tokenCounter.countTokens(summary);
    return { summary, sourceTokens, summaryTokens };
  }

  private async generateSummary(
    messages: Message[],
    opts?: { instructions?: string; comprehensive?: boolean },
  ): Promise<string | null> {
    const transcript = messages.map((m) => `${m.role}: ${messageToString(m)}`).join("\n\n");

    const focus = opts?.instructions?.trim()
      ? `\n\nPay special attention to (per the user's request): ${opts.instructions.trim()}`
      : "";

    const comprehensive = opts?.comprehensive ?? false;
    const system = comprehensive
      ? "You are compacting a conversation so it can continue with far less context. Preserve every detail needed to resume the work: the user's goals, decisions made, files and code touched, commands run, errors encountered, and the exact current state and next step. Use short labelled sections. Never drop the most recent task."
      : "You are a conversation summarizer. Be concise — 3-5 bullet points.";

    const instructionText = comprehensive
      ? `Write a structured summary of the conversation below so the work can continue from the summary alone. Cover:
- Goals & requirements the user stated
- Key facts learned about the codebase
- Actions taken (files read/edited, commands run) and their outcomes
- Decisions made and open questions
- Current state and the immediate next step${focus}`
      : `Summarize this conversation segment concisely. Focus on:
- What was discussed and decided
- Key facts learned about the codebase
- Actions taken (files read, edited, commands run)
- Outcomes and current state${focus}`;

    const userText = `${instructionText}\n\nConversation:\n${transcript}`;

    // Try the active provider/model first, then any other registered provider.
    // `infer` (non-streaming) does no cross-provider fallback of its own, so if
    // the summarizer's provider is momentarily unavailable we walk the rest
    // ourselves rather than failing the whole compaction.
    for (const { provider, model } of this.summarizerCandidates()) {
      try {
        const response = await this.gateway.infer({
          messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
          system,
          model,
          provider,
          maxTokens: comprehensive ? 2000 : 500,
          stream: false,
        });
        const textBlock = response.content.find((b) => b.type === "text");
        const out = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
        if (out) return out;
      } catch {
        // Provider not registered / transient failure — try the next candidate.
      }
    }
    return null;
  }

  /**
   * Ordered provider/model pairs to attempt for summarization: the configured
   * (active) one first, then every other registered provider with a safe default
   * model. Defensive — in normal use the first candidate is the active session
   * model and succeeds immediately.
   */
  private summarizerCandidates(): Array<{ provider: ProviderName; model: string }> {
    const candidates: Array<{ provider: ProviderName; model: string }> = [
      { provider: this.summarizerProvider, model: this.summarizerModel },
    ];
    const registered = this.gateway.getRegisteredProviderNames?.() ?? [];
    for (const name of registered) {
      if (name === this.summarizerProvider) continue;
      candidates.push({
        provider: name,
        model: SUMMARY_FALLBACK_MODELS[name] ?? this.summarizerModel,
      });
    }
    return candidates;
  }

  getMemory(): SessionMemory {
    return { ...this.memory };
  }

  /**
   * Return current context window usage statistics.
   * Updated after each buildPrompt() call.
   */
  getContextUsage(): { used: number; limit: number; percent: number } {
    return {
      used: this.lastTokenUsage?.used ?? 0,
      limit:
        this.lastTokenUsage?.limit ??
        getContextLimit(this.config.summarizerModel || "claude-sonnet-4-6"),
      percent: this.lastTokenUsage
        ? Math.round((this.lastTokenUsage.used / this.lastTokenUsage.limit) * 100)
        : 0,
    };
  }

  /**
   * Whether the working set should be compacted now, based on the most recent
   * buildPrompt() token usage. Returns true only once usage crosses the
   * high-water mark, so the agent loop doesn't fire an expensive summarization
   * call every turn. Returns false until at least one buildPrompt() has run.
   */
  shouldCompact(highWaterRatio: number = 0.7): boolean {
    if (this.compactRequested) return true;
    if (!this.lastTokenUsage) return false;
    const { used, limit } = this.lastTokenUsage;
    if (limit <= 0) return false;
    return used / limit >= highWaterRatio;
  }

  /**
   * Force the next shouldCompact()/compactWorkingSet() pair to compact
   * regardless of the usage high-water mark. Backs the model-invocable
   * compact_context tool ("compact the conversation" asked in plain chat):
   * the agent loop picks it up at the next turn boundary.
   */
  requestCompaction(): void {
    this.compactRequested = true;
  }
}

// ─── Helpers ───

/**
 * Find the index at which we can safely cut the message array so that:
 *  - At least `recentK` messages are kept verbatim (i.e., cut ≤ length - recentK).
 *  - The message at index `cut` starts a "clean" boundary — no orphaned
 *    tool_use or tool_result blocks straddle the cut.
 *
 * We walk *backward* from the naive cut point (messages.length - recentK)
 * until we land on a position where:
 *   (a) The message just before the cut is NOT an assistant message that
 *       contains a tool_use whose tool_result falls AFTER the cut.
 *   (b) The message AT the cut is NOT a tool_result whose tool_use is
 *       BEFORE the cut.
 *
 * Returns the safe cut index (0 … messages.length). Returns 0 if no safe
 * cut can be found (caller should treat this as "cannot compact").
 */
function findSafeCutPoint(messages: Message[], recentK: number): number {
  const naiveCut = messages.length - recentK;

  // We try the naive cut first, then walk backward toward 0.
  for (let cut = naiveCut; cut >= 0; cut--) {
    if (isSafeCut(messages, cut)) return cut;
  }

  return 0;
}

/**
 * Returns true when slicing at `cut` (i.e., old = messages[0..cut),
 * recent = messages[cut..]) does not split any tool_use/tool_result pair.
 */
function isSafeCut(messages: Message[], cut: number): boolean {
  if (cut <= 0) return cut === 0; // cut=0 is trivially safe (nothing to summarize)

  // Collect all tool_use IDs in the OLD portion (before cut).
  const toolUseIdsInOld = new Set<string>();
  for (let i = 0; i < cut; i++) {
    for (const block of messages[i].content) {
      if (block.type === "tool_use") {
        toolUseIdsInOld.add(block.toolCallId);
      }
    }
  }

  // Collect all tool_result IDs in the RECENT portion (at/after cut).
  const toolResultIdsInRecent = new Set<string>();
  for (let i = cut; i < messages.length; i++) {
    for (const block of messages[i].content) {
      if (block.type === "tool_result") {
        toolResultIdsInRecent.add(block.toolCallId);
      }
    }
  }

  // A split occurs when a tool_use in old has its tool_result in recent.
  for (const id of toolUseIdsInOld) {
    if (toolResultIdsInRecent.has(id)) return false;
  }

  // Also check the reverse: a tool_result in recent whose tool_use is in old
  // (already covered above, but let's be explicit for orphan tool_result at cut).
  for (const id of toolResultIdsInRecent) {
    if (toolUseIdsInOld.has(id)) return false;
  }

  return true;
}

function messageToString(msg: Message): string {
  return msg.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use")
        return `[tool: ${block.toolName}(${JSON.stringify(block.toolInput).slice(0, 200)})]`;
      if (block.type === "tool_result") return `[result: ${block.toolResultContent.slice(0, 500)}]`;
      return "";
    })
    .join("\n");
}
