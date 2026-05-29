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
    const items: ContextItem[] = [];
    let evictedCount = 0;

    // 1. System prompt (always pinned)
    items.push({
      kind: "system_prompt",
      content: systemPrompt,
      tokens: this.tokenCounter.countTokens(systemPrompt),
      relevance: 1,
      age: 0,
      pinned: true,
    });

    // Tool schemas (always pinned)
    const toolSchemaStr = JSON.stringify(tools);
    items.push({
      kind: "tool_schemas",
      content: toolSchemaStr,
      tokens: this.tokenCounter.countTokens(toolSchemaStr),
      relevance: 1,
      age: 0,
      pinned: true,
    });

    // 2. Active plan
    if (plan) {
      items.push({
        kind: "plan",
        content: plan.description,
        tokens: plan.tokens,
        relevance: 0.95,
        age: 0,
        pinned: true,
      });
    }

    // 3. Pinned files
    for (const [path, file] of this.pinnedFiles) {
      items.push({
        kind: "pinned_file",
        content: `[Pinned: ${path}]\n${file.content}`,
        tokens: file.tokens,
        relevance: 0.9,
        age: 0,
        pinned: true,
      });
    }

    // 4. Conversation messages (recent first = lowest age)
    const totalMessages = messages.length;
    for (let i = 0; i < totalMessages; i++) {
      const msg = messages[i];
      const content = messageToString(msg);
      const age = totalMessages - i;
      items.push({
        kind: roleToKind(msg.role),
        content,
        tokens: this.tokenCounter.countTokens(content),
        relevance: 1 / (1 + age * 0.1), // decay with age
        age,
        pinned: false,
        source: msg,
      });
    }

    // 5. Session summaries
    for (const summary of this.memory.summaries) {
      items.push({
        kind: "session_summary",
        content: summary.summary,
        tokens: summary.tokens,
        relevance: 0.6,
        age: 100, // old by definition
        pinned: false,
      });
    }

    // 6. Discoveries
    for (const disc of this.memory.discoveries) {
      items.push({
        kind: "discovery",
        content: `[Discovery] ${disc.fact} (from: ${disc.source})`,
        tokens: this.tokenCounter.countTokens(disc.fact) + 10,
        relevance: 0.5,
        age: Math.floor((Date.now() - disc.createdAt) / 60000), // minutes
        pinned: false,
      });
    }

    // 7. Retrieved chunks
    if (retrievedChunks) {
      for (const chunk of retrievedChunks) {
        items.push({
          kind: "retrieved_chunk",
          content: chunk.content,
          tokens: this.tokenCounter.countTokens(chunk.content),
          relevance: chunk.relevance,
          age: 50,
          pinned: false,
        });
      }
    }

    // ─── Budget Pass ───
    const budgetTokens = this.budget.maxTokens;
    const sorted = budgetPass(items, budgetTokens);

    // Reconstruct messages from the surviving items
    const finalMessages: Message[] = [];
    let systemContent = "";

    for (const item of sorted) {
      if (item.kind === "system_prompt") {
        systemContent = item.content;
      } else if (item.kind === "tool_schemas") {
        // Tools are passed separately, not in messages
      } else if (item.kind === "session_summary" || item.kind === "discovery") {
        // Prepend summaries/discoveries to system prompt
        systemContent += `\n\n${item.content}`;
      } else if (item.source && "role" in item.source) {
        finalMessages.push(item.source as Message);
      }
    }

    const totalTokens = sorted.reduce((sum, item) => sum + item.tokens, 0);
    evictedCount = items.length - sorted.length;

    // Track token usage for getContextUsage()
    this.lastTokenUsage = {
      used: totalTokens,
      limit: this.budget.maxTokens,
    };

    return {
      messages: finalMessages,
      system: systemContent,
      tools,
      totalTokens,
      evictedCount,
    };
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
  ): Promise<{ messages: Message[]; compacted: boolean }> {
    // ── 1. Below-threshold guard ──
    if (messages.length < this.summarizeTurnsThreshold) {
      return { messages, compacted: false };
    }

    // ── 2. Find a safe cut point ──
    // We want to keep the last `recentK` messages verbatim, but we must not
    // split a tool_use/tool_result pair.  We scan forward from the naive cut
    // point until we land on a boundary that is safe.
    const safeCutPoint = findSafeCutPoint(messages, recentK);

    // If we can't carve off at least 4 messages to summarise, bail out.
    if (safeCutPoint < 4) {
      return { messages, compacted: false };
    }

    const toSummarize = messages.slice(0, safeCutPoint);
    const toKeep = messages.slice(safeCutPoint);

    // ── 3. Summarise the old portion ──
    const summaryText = await this.generateSummary(toSummarize);
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

  private async generateSummary(messages: Message[]): Promise<string | null> {
    const transcript = messages.map((m) => `${m.role}: ${messageToString(m)}`).join("\n\n");

    try {
      const response = await this.gateway.infer({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Summarize this conversation segment concisely. Focus on:
- What was discussed and decided
- Key facts learned about the codebase
- Actions taken (files read, edited, commands run)
- Outcomes and current state

Conversation:
${transcript}`,
              },
            ],
          },
        ],
        system: "You are a conversation summarizer. Be concise — 3-5 bullet points.",
        model: this.summarizerModel,
        provider: this.summarizerProvider,
        maxTokens: 500,
        stream: false,
      });

      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock && textBlock.type === "text" ? textBlock.text : null;
    } catch {
      return null;
    }
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
        getContextLimit(this.config.summarizerModel || "claude-sonnet-4-20250514"),
      percent: this.lastTokenUsage
        ? Math.round((this.lastTokenUsage.used / this.lastTokenUsage.limit) * 100)
        : 0,
    };
  }
}

// ─── Budget Pass Algorithm ───

/**
 * Score and filter context items to fit within the token budget.
 * Pinned items are always kept. Non-pinned items are scored by
 * `relevance / (1 + age * 0.05)` and dropped lowest-first.
 */
function budgetPass(items: ContextItem[], maxTokens: number): ContextItem[] {
  const pinned = items.filter((i) => i.pinned);
  const unpinned = items.filter((i) => !i.pinned);

  let pinnedTokens = pinned.reduce((sum, i) => sum + i.tokens, 0);
  if (pinnedTokens > maxTokens) {
    // Even pinned items exceed budget — drop oldest pinned items
    // (except system prompt and tool schemas)
    const essential = pinned.filter((i) => i.kind === "system_prompt" || i.kind === "tool_schemas");
    const rest = pinned
      .filter((i) => i.kind !== "system_prompt" && i.kind !== "tool_schemas")
      .sort((a, b) => b.relevance - a.relevance);

    const result: ContextItem[] = [...essential];
    let budget = maxTokens - essential.reduce((s, i) => s + i.tokens, 0);
    for (const item of rest) {
      if (item.tokens <= budget) {
        result.push(item);
        budget -= item.tokens;
      }
    }
    return result;
  }

  // Score unpinned items
  const scored = unpinned
    .map((item) => ({
      item,
      score: item.relevance / (1 + item.age * 0.05),
    }))
    .sort((a, b) => b.score - a.score);

  let remainingBudget = maxTokens - pinnedTokens;
  const kept: ContextItem[] = [...pinned];

  for (const { item } of scored) {
    if (item.tokens <= remainingBudget) {
      kept.push(item);
      remainingBudget -= item.tokens;
    }
  }

  // Re-sort by original order (messages should stay in conversation order)
  // Higher age = older message; chronological order = oldest first = descending by age
  return kept.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.age - a.age;
  });
}

// ─── Helpers ───

/**
 * @deprecated Use TokenCounter.countTokens() instead. This naive estimate
 * (text.length / 4) can be off by 30-50%. Kept for backward compatibility.
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English text
  return Math.ceil(text.length / 4);
}

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

function roleToKind(role: string): "user_message" | "assistant_message" | "tool_message" {
  if (role === "assistant") return "assistant_message";
  if (role === "tool") return "tool_message";
  return "user_message";
}
