import type { Message, ContentBlock, ToolDefinition } from "@gear/llm-gateway";
import { LlmGateway, isModelGoneError } from "@gear/llm-gateway";
import type { ProviderName } from "@gear/llm-gateway";
import { PROVIDER_TIER_DEFAULTS } from "@gear/shared";
import { TokenCounter, tokenCounter, countTokens, getContextLimit } from "./tokenizer";

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

// Cheap summarizer fallback per provider = that provider's LIGHT tier default
// (shared/tiers.ts). One source of truth: when a free model is retired
// upstream, fixing the tier table fixes compaction too. The previous private
// copy here rotted independently and still pointed at models retired in July —
// so the "fallback" summarizer was guaranteed dead exactly when it was needed.
function summaryFallbackModel(provider: ProviderName): string | undefined {
  return PROVIDER_TIER_DEFAULTS[provider]?.light;
}

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

/** A bounded, relevance-ranked piece of workspace context. */
export interface RetrievedChunk {
  content: string;
  relevance: number;
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
  private summarizeTurnsThreshold: number;
  private gateway: LlmGateway;
  private summarizerModel: string;
  private summarizerProvider: ProviderName;
  // The active session pair, used as a summarizer fallback candidate: it is
  // serving the main loop RIGHT NOW, so it is alive even when the light-tier
  // table has rotted to a retired id (which is exactly when it's needed).
  private sessionModel: string | null = null;
  private sessionProvider: ProviderName | null = null;
  // provider/model pairs that already failed as summarizers this session
  // (retired ids, gated models). A corpse does not resurrect mid-session, so
  // later candidate walks skip these instead of re-spending a doomed round
  // trip on every high-water crossing.
  private deadSummarizers = new Set<string>();
  private tokenCounter: TokenCounter;
  private config: {
    budget?: Partial<ContextBudget>;
    summarizeTurnsThreshold?: number;
    summarizerModel?: string;
    summarizerProvider?: ProviderName;
  };
  private lastTokenUsage: { used: number; limit: number } | null = null;
  // Whether the user explicitly configured maxTokens. When they didn't, the
  // build budget tracks the active model's real context window instead of the
  // one-size default (an 8k local model must never be sent a 100k prompt).
  private budgetExplicit: boolean;
  // The heuristic total from the most recent buildPrompt(), held until the
  // provider reports the request's REAL count — the pair calibrates the
  // token counter for this model (see TokenCounter.noteCalibration).
  private lastHeuristicTotal: number | null = null;
  // Set by requestCompaction() (the compact_context tool / an explicit user
  // ask): forces the next shouldCompact()/compactWorkingSet() pair to run
  // regardless of the usage high-water mark. Consumed by compactWorkingSet.
  private compactRequested = false;
  // Why the most recent generateSummary() failed (null when it succeeded).
  private lastSummaryFailure: string | null = null;

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
    this.budgetExplicit = config.budget?.maxTokens != null;
    this.memory = { summaries: [], discoveries: [] };
    this.summarizeTurnsThreshold = config.summarizeTurnsThreshold ?? 10;
    this.gateway = gateway;
    this.summarizerModel = config.summarizerModel ?? "claude-haiku-4-5-20251001";
    this.summarizerProvider = config.summarizerProvider ?? "anthropic";
    // The SHARED counter, not a private one: calibration learned here from
    // real provider usage must apply everywhere tokens are estimated
    // (working memory, system-memory budgets), or the subsystems drift apart.
    this.tokenCounter = tokenCounter;
  }

  /**
   * Point summarization at a specific provider/model — normally the LIGHT
   * model tier. Without this the summarizer falls back to its anthropic/
   * claude-haiku default and fails for everyone without an Anthropic key (the
   * root cause of "/compress does nothing"). The Engine calls this whenever
   * the model or provider changes, and passes the ACTIVE SESSION pair as
   * `session`: the one model guaranteed alive (it is serving the main loop),
   * kept as a fallback candidate for when the light-tier pick has rotted to a
   * retired id — the failure that once left a session unable to ever compact
   * while its main model worked fine.
   */
  setSummarizer(
    model: string,
    provider: ProviderName,
    session?: { model: string; provider: ProviderName },
  ): void {
    if (model) this.summarizerModel = model;
    if (provider) this.summarizerProvider = provider;
    if (session?.model && session.provider) {
      this.sessionModel = session.model;
      this.sessionProvider = session.provider;
    }
  }

  /**
   * Refresh the gateway reference. The Engine rebuilds its gateway on every key
   * edit / provider toggle, which would otherwise leave this holding a stale one
   * (so a freshly added key never reaches the summarizer).
   */
  setGateway(gateway: LlmGateway): void {
    this.gateway = gateway;
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
    retrievedChunks?: RetrievedChunk[],
    model?: string,
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

    if (model) this.tokenCounter.setActiveModel(model);
    const maxTokens = this.effectiveMaxTokens(model);

    const systemTokens = this.tokenCounter.countTokens(systemPrompt);
    const toolTokens = this.tokenCounter.countTokens(JSON.stringify(tools));
    const messageTokens = messages.reduce(
      (sum, m) => sum + this.tokenCounter.countTokens(messageTokenText(m)),
      0,
    );

    // ── Auxiliary items compete for whatever budget remains ──
    const aux: ContextItem[] = [];
    // (Retrieved repo-map chunks only. The old plan/pinned-file/discovery
    // slots were dead APIs no caller ever fed — and the discovery `age` math
    // mutated the prompt prefix every turn, defeating the very prompt cache
    // the invariant above protects. The task spine now carries plan state as
    // a live-injected TAIL block in the agent loop instead.)
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

    const auxBudget = Math.max(0, maxTokens - systemTokens - toolTokens - messageTokens);
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
    // provider reports authoritative counts for the request we send. The
    // heuristic total is also parked so that report can calibrate the counter.
    this.lastTokenUsage = {
      used: totalTokens,
      limit: maxTokens,
    };
    this.lastHeuristicTotal = totalTokens;

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
    // Pair this authoritative count with the heuristic made for the same
    // request — the ratio tunes every subsequent estimate for this model.
    if (this.lastHeuristicTotal != null) {
      this.tokenCounter.noteCalibration(model, this.lastHeuristicTotal, used);
      this.lastHeuristicTotal = null;
    }
    this.lastTokenUsage = { used, limit: getContextLimit(model) };
  }

  /**
   * The prompt-assembly budget actually in effect. An explicitly configured
   * maxTokens is respected verbatim; the default budget is additionally capped
   * to 85% of the active model's context window (headroom for the reply and
   * residual estimate error), so small-window models get prompts that fit
   * instead of guaranteed provider rejections.
   */
  private effectiveMaxTokens(model?: string): number {
    if (this.budgetExplicit || !model) return this.budget.maxTokens;
    return Math.min(this.budget.maxTokens, Math.floor(getContextLimit(model) * 0.85));
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
  ): Promise<{
    messages: Message[];
    compacted: boolean;
    /** Estimated working-set size before/after (present when compacted). */
    beforeTokens?: number;
    afterTokens?: number;
    /** How many older messages were folded into the summary. */
    summarizedCount?: number;
    /**
     * True when compaction was ATTEMPTED and the summarizer failed — distinct
     * from the quiet no-op cases (below threshold, nothing to fold). Callers
     * must surface this: a silent compaction failure is a run that later dies
     * of context overflow with no visible cause.
     */
    failed?: boolean;
    failureReason?: string;
  }> {
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
    //
    // Summary-of-summary guard: when an earlier compaction already ran, the
    // head of toSummarize IS its summary message. Re-summarizing that prose as
    // ordinary transcript is recursively lossy (each pass paraphrases the
    // paraphrase — by the third compaction the session's original goals are
    // gone). Instead the prior summary is extracted and MERGED: the summarizer
    // receives it as accumulated state to update with the new segment's facts,
    // never as text to compress again.
    const priorState = toSummarize.length > 0 ? priorSummaryText(toSummarize[0]) : null;
    const transcriptMessages = priorState !== null ? toSummarize.slice(1) : toSummarize;
    if (transcriptMessages.length === 0) {
      // Only the previous summary would be "compacted" — nothing new to fold in.
      return { messages, compacted: false };
    }
    const summaryText = await this.generateSummary(transcriptMessages, {
      comprehensive: true,
      priorState: priorState ?? undefined,
    });
    if (!summaryText) {
      return {
        messages,
        compacted: false,
        failed: true,
        failureReason: this.lastSummaryFailure ?? "summary generation failed",
      };
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

    // Keep only the LATEST summary in session memory. The merged summary
    // already contains everything still relevant from its predecessors, and
    // buildPrompt() never injects this array — accumulating every generation
    // was unbounded growth with no reader.
    this.memory.summaries = [
      {
        fromSeq: 0,
        toSeq: safeCutPoint,
        summary: summaryText,
        tokens: this.tokenCounter.countTokens(summaryText),
      },
    ];

    // Honest before/after estimates for the UI's compaction line. Same
    // heuristic counter buildPrompt uses; the next provider report re-calibrates
    // it, so these are labeled approximate at the render layer ("~").
    const countSet = (set: Message[]) =>
      set.reduce((sum, m) => sum + this.tokenCounter.countTokens(messageTokenText(m)), 0);

    return {
      messages: [summaryMessage, ...toKeep],
      compacted: true,
      beforeTokens: countSet(messages),
      afterTokens: countSet([summaryMessage, ...toKeep]),
      summarizedCount: transcriptMessages.length,
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
      messages.map((m) => messageTokenText(m)).join("\n"),
    );
    const summaryTokens = this.tokenCounter.countTokens(summary);
    return { summary, sourceTokens, summaryTokens };
  }

  private async generateSummary(
    messages: Message[],
    opts?: { instructions?: string; comprehensive?: boolean; priorState?: string },
  ): Promise<string | null> {
    // Per-message rendering at SUMMARY fidelity: real tool names, real paths,
    // real command output (head+tail clipped, not cut at 200/500 chars). The
    // summarizer is asked for "files touched, commands run, errors" — feeding
    // it a transcript where all three were amputated mid-string is why
    // compacted sessions used to forget what they were doing.
    const rendered = messages.map((m) => `${m.role}: ${summaryMessageText(m)}`);

    const focus = opts?.instructions?.trim()
      ? `\n\nPay special attention to (per the user's request): ${opts.instructions.trim()}`
      : "";

    const comprehensive = opts?.comprehensive ?? false;
    const priorState = opts?.priorState?.trim();
    const system = comprehensive
      ? "You are compacting a conversation so it can continue with far less context. Preserve every detail needed to resume the work: the user's goals, decisions made, files and code touched, commands run, errors encountered, and the exact current state and next step. Prioritize CODEBASE KNOWLEDGE and EVIDENCE (real paths, real error text, what commands showed) — the harness separately maintains the live goal/todo state and re-shows it to the agent, so hard-won facts are what only this summary can carry. Use exactly the labelled sections you are asked for. Never drop the most recent task."
      : "You are a conversation summarizer. Be concise — 3-5 bullet points.";

    // Fixed section labels: successive compactions MERGE into this structure
    // (state update), so the labels must be stable run-to-run — free-form prose
    // is what made repeated compaction recursively lossy.
    const sections = `## Goals & requirements
## Key facts & codebase knowledge
## Actions taken & outcomes (files touched, commands run)
## Decisions & open questions
## Current state & next step`;

    const instructionText = comprehensive
      ? priorState
        ? `Below is the PRIOR STATE — the accumulated record of everything that happened before the new conversation segment — followed by the segment itself. Update the prior state with the segment's new facts: keep every entry that is still relevant, revise what changed, add what is new, and only drop items that are now clearly obsolete. Output ONLY the updated state, using exactly these sections:
${sections}${focus}`
        : `Write a structured summary of the conversation below so the work can continue from the summary alone. Use exactly these sections:
${sections}${focus}`
      : `Summarize this conversation segment concisely. Focus on:
- What was discussed and decided
- Key facts learned about the codebase
- Actions taken (files read, edited, commands run)
- Outcomes and current state${focus}`;

    // Try the configured summarizer first, then the fallback candidates.
    // `infer` (non-streaming) does no cross-provider fallback of its own, so if
    // the summarizer's provider is momentarily unavailable we walk the rest
    // ourselves rather than failing the whole compaction.
    this.lastSummaryFailure = null;
    let lastError = "no summarizer candidates registered";

    const attempt = async (provider: ProviderName, model: string): Promise<string | null> => {
      // The compaction request must itself fit the candidate's window. Budget
      // the transcript to ~55% of the model's context (instructions + prior
      // state + the 2k reply need the rest) and keep the NEWEST messages when
      // over — the prior state already carries older history in merged form.
      // Without this, a long session's compaction request overflowed the
      // summarizer too, failed silently, and the run died of the very problem
      // compaction exists to prevent.
      const budgetTokens = Math.max(4_000, Math.floor(getContextLimit(model) * 0.55));
      const overheadTokens = this.tokenCounter.countTokens(instructionText + (priorState ?? ""));
      let remaining = Math.max(2_000, budgetTokens - overheadTokens);
      const kept: string[] = [];
      let omitted = 0;
      for (let i = rendered.length - 1; i >= 0; i--) {
        const cost = this.tokenCounter.countTokens(rendered[i]);
        if (cost <= remaining || kept.length === 0) {
          kept.unshift(rendered[i]);
          remaining -= cost;
        } else {
          omitted = i + 1;
          break;
        }
      }
      const transcript = clipText(
        (omitted > 0
          ? `[${omitted} older messages omitted to fit the summarizer's window]\n\n`
          : "") + kept.join("\n\n"),
        budgetTokens * 4, // char-level backstop: one enormous single message
      );
      const userText = priorState
        ? `${instructionText}\n\nPRIOR STATE:\n${priorState}\n\nNew conversation segment:\n${transcript}`
        : `${instructionText}\n\nConversation:\n${transcript}`;
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
        lastError = `${provider}/${model} returned an empty summary`;
      } catch (err) {
        // Remember WHY, then try the next candidate. A silent catch here was
        // how compaction failures vanished: the run would later die of context
        // overflow with no trace of the summarizer ever having failed.
        lastError = `${provider}/${model}: ${err instanceof Error ? err.message : String(err)}`;
        // A retired/renamed model cannot come back mid-session: memoize the
        // corpse so the next compaction skips straight past it.
        if (isModelGoneError(err)) this.deadSummarizers.add(`${provider}/${model}`);
      }
      return null;
    };

    for (const { provider, model } of this.summarizerCandidates()) {
      const out = await attempt(provider, model);
      if (out) return out;
    }

    // Every static candidate failed. Last resort: ask each registered provider
    // what it ACTUALLY serves today and retry on verifiably-live models. The
    // static default tables rot — Ollama Cloud has retired its stock lineup
    // wholesale twice — and this turns the next rot from "this session can
    // never compact again" into one extra round trip.
    const recovered = await this.recoverWithLiveModels(attempt);
    if (recovered) return recovered;

    this.lastSummaryFailure = lastError;
    return null;
  }

  /**
   * Live-list recovery for a summarizer whose every static candidate failed:
   * walk each registered provider's listModels() and try models that are
   * verifiably alive right now, skipping known-dead pairs. On success the
   * summarizer is re-pointed at the discovered model, so later compactions go
   * straight there. Attempts are capped to bound latency (gated models fail
   * fast with a 403), and every failed id is memoized — even a transiently
   * failing one, a deliberate trade: successive compactions walk FORWARD
   * through the list instead of re-dying on the same head entries.
   */
  private async recoverWithLiveModels(
    attempt: (provider: ProviderName, model: string) => Promise<string | null>,
  ): Promise<string | null> {
    const MAX_LIVE_ATTEMPTS = 8;
    let tried = 0;
    const providers: ProviderName[] = [
      this.summarizerProvider,
      ...(this.gateway.getRegisteredProviderNames?.() ?? []).filter(
        (p) => p !== this.summarizerProvider,
      ),
    ];
    for (const name of providers) {
      const provider = this.gateway.getProvider?.(name);
      if (!provider?.listModels) continue;
      let live: Array<{ id: string }>;
      try {
        live = await provider.listModels();
      } catch {
        continue; // discovery itself failed — try the next provider
      }
      for (const m of live) {
        if (tried >= MAX_LIVE_ATTEMPTS) return null;
        const key = `${name}/${m.id}`;
        if (this.deadSummarizers.has(key)) continue;
        tried++;
        const out = await attempt(name, m.id);
        if (out) {
          // Self-heal: point the summarizer at the model that just worked.
          this.summarizerModel = m.id;
          this.summarizerProvider = name;
          return out;
        }
        this.deadSummarizers.add(key);
      }
    }
    return null;
  }

  /**
   * Why the most recent generateSummary() returned null — null when it
   * succeeded (or hasn't run). Callers surface this instead of guessing.
   */
  getLastSummaryFailure(): string | null {
    return this.lastSummaryFailure;
  }

  /**
   * Ordered provider/model pairs to attempt for summarization: the configured
   * (light-tier) one, its provider's stock light default, the ACTIVE SESSION
   * model — guaranteed alive, it is serving the main loop — then every other
   * registered provider with a safe default. Pairs that already failed as
   * summarizers this session are skipped. In normal use the first candidate
   * succeeds immediately; the depth exists because a rotted tier table once
   * pinned compaction to a retired model while the session model worked fine,
   * and that session could never compact again.
   */
  private summarizerCandidates(): Array<{ provider: ProviderName; model: string }> {
    const out: Array<{ provider: ProviderName; model: string }> = [];
    const seen = new Set<string>();
    const push = (provider: ProviderName | null, model: string | null | undefined) => {
      if (!provider || !model) return;
      const key = `${provider}/${model}`;
      if (seen.has(key) || this.deadSummarizers.has(key)) return;
      seen.add(key);
      out.push({ provider, model });
    };
    push(this.summarizerProvider, this.summarizerModel);
    push(this.summarizerProvider, summaryFallbackModel(this.summarizerProvider));
    push(this.sessionProvider, this.sessionModel);
    for (const name of this.gateway.getRegisteredProviderNames?.() ?? []) {
      if (name === this.summarizerProvider) continue;
      push(name, summaryFallbackModel(name) ?? this.summarizerModel);
    }
    return out;
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

/**
 * Full-fidelity text for token ESTIMATION. Every block is counted at its real
 * size — tool inputs, tool results, and thinking included — because these are
 * exactly what the provider bills for. The previous shared renderer truncated
 * tool inputs to 200 chars and results to 500 and counted thinking as "",
 * which undercounted tool-heavy sessions by up to ~60×; the calibration factor
 * is clamped to 4× and structurally could not correct it, so compaction never
 * fired until the provider hard-rejected the request.
 */
function messageTokenText(msg: Message): string {
  return msg.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "redacted_thinking") return block.data;
      if (block.type === "tool_use")
        return `[tool: ${block.toolName}(${JSON.stringify(block.toolInput)})]`;
      if (block.type === "tool_result") return `[result: ${block.toolResultContent}]`;
      // NEVER serialize image base64 into the estimate — megabytes of data
      // would explode a chars/4 heuristic and trigger false forced
      // compactions. A fixed placeholder under-counts (~1.6k real tokens per
      // image), which the per-model calibration from real usage absorbs.
      if (block.type === "image") return "[image attachment]";
      return "";
    })
    .join("\n");
}

// What the SUMMARIZER may keep per block. Head+tail clipping (not a hard cut)
// so a compiler error's final lines and a diff's file header both survive.
const SUMMARY_TOOL_ARGS_CHARS = 700;
const SUMMARY_TOOL_RESULT_CHARS = 2_400;

/** Head+tail clip: keeps ~70% of the budget from the start, ~30% from the end. */
function clipText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head);
  return `${s.slice(0, head)}\n…[${s.length - maxChars} chars clipped]…\n${s.slice(s.length - tail)}`;
}

/**
 * Per-message rendering at SUMMARY fidelity. Tool calls keep their name and
 * enough of their arguments to preserve paths and commands; results keep a
 * generous head+tail so errors and evidence survive into the summary.
 * Thinking is excluded by POLICY (the model's private reasoning is not part
 * of the durable record), not by accident.
 */
function summaryMessageText(msg: Message): string {
  return msg.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use")
        return `[tool: ${block.toolName}(${clipText(JSON.stringify(block.toolInput), SUMMARY_TOOL_ARGS_CHARS)})]`;
      if (block.type === "tool_result")
        return `[result: ${clipText(block.toolResultContent, SUMMARY_TOOL_RESULT_CHARS)}]`;
      if (block.type === "image") return "[image attachment]";
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * Both summary-message producers in the codebase: rolling compaction
 * (compactWorkingSet, above) and the /compress replay path
 * (session-replay.ts eventsToMessages). Either one at the head of a
 * to-be-compacted window is accumulated STATE, not transcript.
 */
const COMPACTION_MARKERS = ["[Earlier conversation summary]", "[Conversation summary]"] as const;

/**
 * When `message` is a summary produced by an earlier compaction, return its
 * body (marker stripped); otherwise null. Deliberately strict — single text
 * block, user role, marker at position 0 — so genuine user text can't be
 * mistaken for engine state.
 */
function priorSummaryText(message: Message): string | null {
  if (message.role !== "user" || message.content.length !== 1) return null;
  const block = message.content[0];
  if (block.type !== "text") return null;
  for (const marker of COMPACTION_MARKERS) {
    if (block.text.startsWith(marker)) return block.text.slice(marker.length).trimStart();
  }
  return null;
}
