import { EpisodicMemory, type EpisodicFact } from "./episodic";
import { WorkingMemory } from "./working";
import type { Message } from "@gear/llm-gateway";

/**
 * MemoryManager coordinates episodic and working memory subsystems.
 *
 * Responsibilities:
 * - After each run, extract and persist facts from the run summary
 * - Before each turn, assemble memory context (episodic facts + compressed history)
 * - Provide session-level memory loading for UI inspection
 */
export class MemoryManager {
  constructor(
    private episodic: EpisodicMemory,
    private working: WorkingMemory,
  ) {}

  /**
   * Called after a run completes. Extracts facts from the summary
   * and stores them in episodic memory.
   */
  async onRunComplete(userId: string, runSummary: string): Promise<void> {
    const factData = this.episodic.extractFactsFromSummary(runSummary, userId);
    for (const fact of factData) {
      this.episodic.addFact(fact);
    }
  }

  /**
   * Assemble full memory context for an inference call:
   * - Retrieve relevant episodic facts based on recent conversation
   * - Compress history if the message list exceeds the token budget
   */
  async getMemoryContext(
    userId: string,
    currentMessages: Message[],
    summarize: (messages: Message[]) => Promise<string>,
  ): Promise<{
    episodicFacts: string;
    compressedHistory: Message[];
    summaryPrefix: string | null;
  }> {
    // Build a text representation of recent messages for relevance matching
    const recentText = currentMessages
      .slice(-3)
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" ");
    const facts = this.episodic.getRelevantFacts(userId, recentText, 10);
    const episodicFacts = this.episodic.formatForPrompt(facts);

    let compressedHistory = currentMessages;
    let summaryPrefix: string | null = null;

    if (this.working.shouldCompress(currentMessages)) {
      const result = await this.working.compressHistory(currentMessages, summarize);
      compressedHistory = result.fullMessages;
      summaryPrefix = result.summaryText;
    }

    return { episodicFacts, compressedHistory, summaryPrefix };
  }

  /**
   * Load all memory for a given user/session (for UI inspection).
   */
  loadSessionMemory(
    userId: string,
    _sessionId: string,
  ): {
    facts: EpisodicFact[];
    factsSummary: string;
  } {
    const facts = this.episodic.listAllFacts(userId);
    const factsSummary = this.episodic.formatForPrompt(facts);
    return { facts, factsSummary };
  }
}
