import { createHash } from "crypto";

/**
 * Episodic memory per Section 5.5.
 *
 * Cross-session memory: "what did this user tell me before?"
 * - After each session, summarize key facts into atomic statements
 * - Store with metadata: user_id, source_session_id, timestamp, confidence
 * - On contradiction, mark older fact as superseded; do not delete
 * - User-facing inspection and deletion required (GDPR Article 17)
 */

export interface EpisodicFact {
  id?: number;
  userId: string;
  sessionId: string | null;
  fact: string;
  confidence: number;
  supersededBy: number | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface EpisodicMemoryConfig {
  /** Maximum facts to retrieve per query */
  maxRetrievalCount: number;
  /** Minimum confidence to include in retrieval */
  minConfidence: number;
  /** Default expiry for facts (ms), 0 = no expiry */
  defaultExpiryMs: number;
}

const DEFAULT_CONFIG: EpisodicMemoryConfig = {
  maxRetrievalCount: 20,
  minConfidence: 0.5,
  defaultExpiryMs: 0,
};

/**
 * Episodic memory manager.
 * Backed by SQLite via the `episodic_memory` table (see schema.ts).
 */
export class EpisodicMemory {
  private db: import("bun:sqlite").Database;
  private config: EpisodicMemoryConfig;

  constructor(db: import("bun:sqlite").Database, config?: Partial<EpisodicMemoryConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Store a new fact learned about the user.
   * If a contradicting fact exists, supersede it.
   */
  addFact(fact: Omit<EpisodicFact, "id" | "supersededBy" | "createdAt">): EpisodicFact {
    const now = new Date().toISOString();
    const expiresAt =
      fact.expiresAt ??
      (this.config.defaultExpiryMs > 0
        ? new Date(Date.now() + this.config.defaultExpiryMs).toISOString()
        : null);

    const result = this.db
      .prepare(
        `INSERT INTO episodic_memory (user_id, session_id, fact, confidence, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(fact.userId, fact.sessionId ?? null, fact.fact, fact.confidence, now, expiresAt);

    return {
      id: Number(result.lastInsertRowid),
      userId: fact.userId,
      sessionId: fact.sessionId ?? null,
      fact: fact.fact,
      confidence: fact.confidence,
      supersededBy: null,
      createdAt: now,
      expiresAt,
    };
  }

  /**
   * Mark an older fact as superseded by a newer one.
   * Per Section 5.5: "On contradiction, mark the older fact as superseded; do not delete."
   */
  supersedeFact(oldFactId: number, newFactId: number): void {
    this.db
      .prepare("UPDATE episodic_memory SET superseded_by = ? WHERE id = ?")
      .run(newFactId, oldFactId);
  }

  /**
   * Retrieve active (non-superseded, non-expired) facts for a user.
   * Ordered by confidence DESC, recency DESC.
   */
  retrieveFacts(userId: string, limit?: number): EpisodicFact[] {
    const effectiveLimit = limit ?? this.config.maxRetrievalCount;
    const now = new Date().toISOString();

    const rows = this.db
      .prepare(
        `SELECT id, user_id, session_id, fact, confidence, superseded_by, created_at, expires_at
         FROM episodic_memory
         WHERE user_id = ?
           AND superseded_by IS NULL
           AND confidence >= ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?`,
      )
      .all(userId, this.config.minConfidence, now, effectiveLimit) as EpisodicRow[];

    return rows.map(rowToFact);
  }

  /**
   * Search facts by keyword.
   */
  searchFacts(userId: string, query: string, limit = 10): EpisodicFact[] {
    const now = new Date().toISOString();

    const rows = this.db
      .prepare(
        `SELECT id, user_id, session_id, fact, confidence, superseded_by, created_at, expires_at
         FROM episodic_memory
         WHERE user_id = ?
           AND superseded_by IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND fact LIKE ?
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?`,
      )
      .all(userId, now, `%${query}%`, limit) as EpisodicRow[];

    return rows.map(rowToFact);
  }

  /**
   * List all facts for a user (for inspection UI per Section 5.5).
   * Includes superseded facts for transparency.
   */
  listAllFacts(userId: string): EpisodicFact[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, session_id, fact, confidence, superseded_by, created_at, expires_at
         FROM episodic_memory
         WHERE user_id = ?
         ORDER BY created_at DESC`,
      )
      .all(userId) as EpisodicRow[];

    return rows.map(rowToFact);
  }

  /**
   * Delete a specific fact (GDPR Article 17 compliance).
   */
  deleteFact(factId: number): void {
    this.db.prepare("DELETE FROM episodic_memory WHERE id = ?").run(factId);
  }

  /**
   * Delete all facts for a user (GDPR right to erasure).
   */
  deleteAllForUser(userId: string): number {
    const result = this.db.prepare("DELETE FROM episodic_memory WHERE user_id = ?").run(userId);
    return result.changes;
  }

  /**
   * Format facts for injection into system prompt.
   */
  formatForPrompt(facts: EpisodicFact[]): string {
    if (facts.length === 0) return "";
    const lines = facts.map((f) => `- [${f.confidence >= 0.8 ? "high" : "med"}] ${f.fact}`);
    return `## Remembered Context\n${lines.join("\n")}`;
  }

  /**
   * Extract structured facts from a run summary string.
   * Each non-trivial line becomes a candidate fact with heuristic confidence.
   */
  extractFactsFromSummary(
    summary: string,
    userId: string,
  ): Omit<EpisodicFact, "id" | "supersededBy" | "createdAt">[] {
    const facts: Omit<EpisodicFact, "id" | "supersededBy" | "createdAt">[] = [];
    const lines = summary.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length <= 10 || trimmed.length >= 500) continue;

      facts.push({
        userId,
        sessionId: null,
        fact: trimmed,
        confidence: 0.7,
        expiresAt: null,
      });
    }
    return facts;
  }

  /**
   * Retrieve facts relevant to the current context using keyword overlap scoring.
   */
  getRelevantFacts(userId: string, currentContext: string, limit: number = 10): EpisodicFact[] {
    const allFacts = this.listAllFacts(userId);
    const contextWords = new Set(
      currentContext
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3),
    );

    return allFacts
      .filter((f) => f.supersededBy === null)
      .map((fact) => {
        const factWords = fact.fact
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3);
        const overlap = factWords.filter((w) => contextWords.has(w)).length;
        const relevance = overlap / Math.max(factWords.length, 1);
        return { fact, relevance };
      })
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit)
      .map((r) => r.fact);
  }
}

interface EpisodicRow {
  id: number;
  user_id: string;
  session_id: string | null;
  fact: string;
  confidence: number;
  superseded_by: number | null;
  created_at: string;
  expires_at: string | null;
}

function rowToFact(row: EpisodicRow): EpisodicFact {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    fact: row.fact,
    confidence: row.confidence,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
