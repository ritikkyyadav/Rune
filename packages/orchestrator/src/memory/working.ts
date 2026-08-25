import type { Message } from "@gear/llm-gateway";
import { tokenCounter } from "../tokenizer";

/**
 * Working memory management per Section 5.2.
 *
 * The context window is bounded. Production agents manage it actively:
 * - Strategy 3: Selective retention (system + pinned + recent + curated)
 * - Combined with retrieval of episodic memory on demand
 *
 * This module implements the context window assembly with budget enforcement.
 */

export interface WorkingMemoryConfig {
  /** Maximum tokens for the working memory window */
  maxTokens: number;
  /** Token budget allocation percentages */
  budgetAllocation: {
    system: number; // System prompt + tools (30-40%)
    pinned: number; // Pinned files + active plan (15-25%)
    recent: number; // Recent conversation turns (25-35%)
    memory: number; // Episodic + semantic memory (10-20%)
    reserved: number; // Buffer for model output (5-10%)
  };
  /** Number of recent turns to keep at full fidelity */
  recentTurnsFull: number;
  /** Number of older turns to keep as summaries */
  olderTurnsSummarized: number;
}

export const DEFAULT_WORKING_MEMORY_CONFIG: WorkingMemoryConfig = {
  maxTokens: 128_000,
  budgetAllocation: {
    system: 0.3,
    pinned: 0.2,
    recent: 0.3,
    memory: 0.15,
    reserved: 0.05,
  },
  recentTurnsFull: 10,
  olderTurnsSummarized: 20,
};

export interface ContextSlot {
  id: string;
  category: "system" | "pinned" | "recent" | "summary" | "memory" | "retrieved";
  content: string;
  estimatedTokens: number;
  priority: number; // 0 = highest
  pinned: boolean;
  age: number; // Turns since this content was added
}

/**
 * Working memory manager.
 * Assembles the context window from multiple sources within a token budget.
 */
export class WorkingMemory {
  private config: WorkingMemoryConfig;
  private slots: ContextSlot[] = [];

  constructor(config?: Partial<WorkingMemoryConfig>) {
    this.config = { ...DEFAULT_WORKING_MEMORY_CONFIG, ...config };
  }

  /**
   * Add a content slot to working memory.
   */
  addSlot(slot: ContextSlot): void {
    this.slots.push(slot);
  }

  /**
   * Remove a slot by ID.
   */
  removeSlot(id: string): void {
    this.slots = this.slots.filter((s) => s.id !== id);
  }

  /**
   * Get all slots that fit within the token budget.
   * Slots are selected by priority, with pinned slots always included.
   */
  getActiveSlots(): ContextSlot[] {
    const budget = this.config.maxTokens;
    const sorted = [...this.slots].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return a.priority - b.priority;
    });

    const active: ContextSlot[] = [];
    let usedTokens = 0;
    const reservedTokens = Math.floor(budget * this.config.budgetAllocation.reserved);

    for (const slot of sorted) {
      if (usedTokens + slot.estimatedTokens <= budget - reservedTokens) {
        active.push(slot);
        usedTokens += slot.estimatedTokens;
      } else if (slot.pinned) {
        // Pinned slots always included; evict lowest-priority non-pinned
        active.push(slot);
        usedTokens += slot.estimatedTokens;
        // Evict from the back until we fit
        while (usedTokens > budget - reservedTokens && active.length > 1) {
          const evictIdx = active.findLastIndex((s) => !s.pinned);
          if (evictIdx === -1) break;
          usedTokens -= active[evictIdx].estimatedTokens;
          active.splice(evictIdx, 1);
        }
      }
    }

    return active;
  }

  /**
   * Estimate tokens used vs budget.
   */
  getUsage(): { used: number; budget: number; utilization: number } {
    const active = this.getActiveSlots();
    const used = active.reduce((sum, s) => sum + s.estimatedTokens, 0);
    return {
      used,
      budget: this.config.maxTokens,
      utilization: used / this.config.maxTokens,
    };
  }

  /**
   * Build conversation history with compression.
   * Recent turns at full fidelity, older turns summarized.
   *
   * Per Section 5.2 Strategy 4: Hierarchical compression
   */
  async compressHistory(
    messages: Message[],
    summarize: (older: Message[]) => Promise<string>,
  ): Promise<{ fullMessages: Message[]; summaryText: string | null }> {
    const totalTokens = this.estimateMessagesTokens(messages);

    if (totalTokens <= this.config.maxTokens) {
      return { fullMessages: messages, summaryText: null };
    }

    // Keep ~70% budget for recent messages, summarize the rest
    const targetRecent = Math.floor(this.config.maxTokens * 0.7);
    let recentTokens = 0;
    let splitIndex = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.estimateMessageTokens(messages[i]);
      if (recentTokens + msgTokens > targetRecent) {
        splitIndex = i + 1;
        break;
      }
      recentTokens += msgTokens;
    }

    if (splitIndex <= 0) {
      return { fullMessages: messages, summaryText: null };
    }

    const olderMessages = messages.slice(0, splitIndex);
    const recentMessages = messages.slice(splitIndex);
    const summaryText = await summarize(olderMessages);

    return { fullMessages: recentMessages, summaryText };
  }

  /**
   * Check whether the message history should be compressed.
   */
  shouldCompress(messages: Message[]): boolean {
    return this.estimateMessagesTokens(messages) > this.config.maxTokens * 0.8;
  }

  /**
   * Estimate total tokens across all messages.
   */
  private estimateMessagesTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + this.estimateMessageTokens(m), 0);
  }

  /**
   * Estimate tokens for a single message.
   */
  private estimateMessageTokens(message: Message): number {
    const content =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return Math.ceil(content.length / 4);
  }

  /**
   * Clear all non-pinned slots.
   */
  clearTransient(): void {
    this.slots = this.slots.filter((s) => s.pinned);
  }

  /**
   * Reset everything.
   */
  reset(): void {
    this.slots = [];
  }
}

/**
 * Token estimation delegated to the shared counter so working memory and the
 * context engine budget with the SAME numbers (including any calibration
 * learned from real provider usage). Two estimators disagreeing was how
 * "fits in memory" and "fits in the prompt" drifted apart.
 */
export function estimateTokens(text: string): number {
  return tokenCounter.countTokens(text);
}
