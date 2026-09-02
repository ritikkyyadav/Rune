import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { Database } from "bun:sqlite";

import { ensureGearHome, gearHomePath } from "@gear/shared";

/**
 * The labelling sidecar.
 *
 * A `safety_decision` row records the hash of a tool call's arguments, never
 * the arguments. That is the right default — the audit log is exportable, and a
 * bash command routinely contains a path, a hostname, sometimes a token — but
 * it is also why 913 recorded decisions could not be turned into 913 labelled
 * corpus rows: you cannot re-run a decision whose input you deliberately threw
 * away.
 *
 * So the raw arguments go somewhere else, under three constraints that are the
 * whole design:
 *
 *   1. **Off by default.** `[permissions.autoMode] collectForEval = true` and
 *      nothing else turns it on. There is no remote flag, no experiment, no
 *      "helpful" default.
 *   2. **Encrypted at rest with a local key.** AES-256-GCM under a key in
 *      `~/.gear/auto-eval.key`, mode 0600, generated on first write. Losing the
 *      key loses the sidecar, which is the correct failure mode for a file
 *      whose only purpose is local eval.
 *   3. **Structurally unexportable.** It is a separate database, keyed by
 *      `argsHash`, that no telemetry path, no `gear export`, and no black box
 *      reads. The audit chain keeps hashing what it always hashed; this file is
 *      the join table, and it never leaves the machine.
 */

const KEY_FILE = "auto-eval.key";
const DB_FILE = "auto-eval.db";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS eval_args (
    args_hash   TEXT PRIMARY KEY,
    tool_name   TEXT NOT NULL,
    iv          BLOB NOT NULL,
    tag         BLOB NOT NULL,
    ciphertext  BLOB NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eval_context (
    args_hash    TEXT PRIMARY KEY,
    session_id   TEXT,
    call_id      TEXT,
    iv           BLOB NOT NULL,
    tag          BLOB NOT NULL,
    ciphertext   BLOB NOT NULL,
    created_at   TEXT NOT NULL
  );
`;

/** What a decision needs beyond its arguments to be replayable as a scenario. */
export interface SidecarContext {
  /** The trusted user messages that were in scope when the action was proposed. */
  userMessages: string[];
  /** Interactive question/answer rounds, the conversational-authorization channel. */
  answers?: Array<{ question: string; answer: string }>;
}

export interface SidecarRow {
  argsHash: string;
  toolName: string;
  args: Record<string, unknown>;
  context?: SidecarContext;
  createdAt: string;
}

function loadOrCreateKey(): Buffer {
  ensureGearHome();
  const path = gearHomePath(KEY_FILE);
  if (existsSync(path)) {
    const raw = readFileSync(path);
    // A 32-byte key stored as 64 hex characters; anything else is a corrupt
    // file, and silently regenerating over it would orphan the existing rows.
    const key = Buffer.from(raw.toString("utf8").trim(), "hex");
    if (key.length !== 32) {
      throw new Error(
        `auto-eval key at ${path} is malformed (expected 32 bytes). Delete it to start a fresh sidecar.`,
      );
    }
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(path, key.toString("hex"), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  return key;
}

function seal(key: Buffer, plaintext: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Local, encrypted, opt-in. Constructing one is cheap; nothing is written until
 * `record` is called, and every method swallows its own failures — a sidecar
 * that cannot write must never be able to fail a turn that was otherwise fine.
 */
export class AutoEvalSidecar {
  private db: Database | null = null;
  private key: Buffer | null = null;
  private broken = false;

  constructor(private readonly path: string = gearHomePath(DB_FILE)) {}

  private ensure(): { db: Database; key: Buffer } | null {
    if (this.broken) return null;
    if (this.db && this.key) return { db: this.db, key: this.key };
    try {
      ensureGearHome();
      this.key = loadOrCreateKey();
      this.db = new Database(this.path, { create: true });
      this.db.exec(SCHEMA);
      return { db: this.db, key: this.key };
    } catch {
      // One failure is enough: a missing key directory or a read-only home is
      // not going to fix itself mid-session, and retrying per decision would
      // turn a config problem into a performance problem.
      this.broken = true;
      return null;
    }
  }

  /**
   * Store one decision's raw input, keyed by the same hash the audit row
   * carries. Idempotent: identical arguments hash identically, and the second
   * occurrence adds nothing a labeller could use.
   */
  record(
    argsHash: string,
    toolName: string,
    args: Record<string, unknown>,
    context?: SidecarContext & { sessionId?: string; callId?: string },
  ): void {
    const handle = this.ensure();
    if (!handle) return;
    try {
      const sealed = seal(handle.key, JSON.stringify(args));
      handle.db
        .prepare(
          `INSERT OR IGNORE INTO eval_args (args_hash, tool_name, iv, tag, ciphertext, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          argsHash,
          toolName,
          sealed.iv,
          sealed.tag,
          sealed.ciphertext,
          new Date().toISOString(),
        );
      if (!context) return;
      const ctx = seal(
        handle.key,
        JSON.stringify({ userMessages: context.userMessages, answers: context.answers }),
      );
      handle.db
        .prepare(
          `INSERT OR IGNORE INTO eval_context (args_hash, session_id, call_id, iv, tag, ciphertext, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          argsHash,
          context.sessionId ?? null,
          context.callId ?? null,
          ctx.iv,
          ctx.tag,
          ctx.ciphertext,
          new Date().toISOString(),
        );
    } catch {
      // Never fails the caller. See the class comment.
    }
  }

  /** Read back everything the corpus builder can use. Local tooling only. */
  list(limit = 5_000): SidecarRow[] {
    const handle = this.ensure();
    if (!handle) return [];
    try {
      const rows = handle.db
        .prepare(
          `SELECT a.args_hash, a.tool_name, a.iv, a.tag, a.ciphertext, a.created_at,
                  c.iv AS ctx_iv, c.tag AS ctx_tag, c.ciphertext AS ctx_ciphertext
           FROM eval_args a LEFT JOIN eval_context c ON c.args_hash = a.args_hash
           ORDER BY a.created_at ASC LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
      const out: SidecarRow[] = [];
      for (const row of rows) {
        try {
          const args = JSON.parse(
            open(
              handle.key,
              Buffer.from(row.iv as Uint8Array),
              Buffer.from(row.tag as Uint8Array),
              Buffer.from(row.ciphertext as Uint8Array),
            ),
          ) as Record<string, unknown>;
          let context: SidecarContext | undefined;
          if (row.ctx_iv) {
            context = JSON.parse(
              open(
                handle.key,
                Buffer.from(row.ctx_iv as Uint8Array),
                Buffer.from(row.ctx_tag as Uint8Array),
                Buffer.from(row.ctx_ciphertext as Uint8Array),
              ),
            ) as SidecarContext;
          }
          out.push({
            argsHash: String(row.args_hash),
            toolName: String(row.tool_name),
            args,
            context,
            createdAt: String(row.created_at),
          });
        } catch {
          // A row sealed under a key that has since been replaced is simply
          // unreadable. Skip it; it is eval material, not evidence.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  count(): number {
    const handle = this.ensure();
    if (!handle) return 0;
    try {
      const row = handle.db.prepare("SELECT COUNT(*) AS n FROM eval_args").get() as { n: number };
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // Nothing depends on a clean close.
    }
    this.db = null;
  }
}
