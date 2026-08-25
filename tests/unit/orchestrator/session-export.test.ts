/**
 * Unit tests for session-export.ts (Contract C4)
 *
 * Seeds a temp SQLite database with a SessionManager, appends a few events
 * and audit entries, then exercises exportSession() and verifyExport().
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, hashArgs, hashResult } from "../../../packages/shared/src/session";
import { exportSession, verifyExport } from "../../../packages/orchestrator/src/session-export";
import { generateEd25519KeyPair } from "../../../packages/orchestrator/src/signing";
import { signBytes, verifySignature } from "../../../packages/orchestrator/src/signing";

// ─── Temp directory helpers ──────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gear-session-export-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

// ─── Seed helper ─────────────────────────────────────────────────────────

function seedSession(dbPath: string): { sessionId: string; sm: SessionManager } {
  const sm = new SessionManager(dbPath);

  const session = sm.createSession("/tmp/workspace", "claude-sonnet");
  const sessionId = session.id;

  // Append a few conversation events
  sm.appendEvent(sessionId, {
    type: "user_msg",
    payload: { content: "Hello, can you write a hello.ts file?" },
  });

  sm.appendEvent(sessionId, {
    type: "assistant_msg",
    payload: {
      content: "Sure, I will write hello.ts for you.",
      toolUses: [
        {
          callId: "call-001",
          toolName: "write_file",
          toolInput: { path: "hello.ts", content: 'console.log("hello")' },
        },
      ],
    },
  });

  // Simulate a tool_result with a write_file diff payload
  sm.appendEvent(sessionId, {
    type: "tool_result",
    payload: {
      callId: "call-001",
      toolName: "write_file",
      content: '--- a/hello.ts\n+++ b/hello.ts\n@@ -0,0 +1 @@\n+console.log("hello")\n',
      isError: false,
    },
  });

  sm.appendEvent(sessionId, {
    type: "assistant_msg",
    payload: { content: "Done! I wrote hello.ts.", toolUses: [] },
  });

  // Append two audit entries (hash-chained)
  sm.appendAuditEntry({
    sessionId,
    toolName: "write_file",
    argsHash: hashArgs({ path: "hello.ts", content: 'console.log("hello")' }),
    resultHash: hashResult("ok"),
    durationMs: 42,
    exitCode: 0,
  });

  sm.appendAuditEntry({
    sessionId,
    toolName: "read_file",
    argsHash: hashArgs({ path: "hello.ts" }),
    resultHash: hashResult('console.log("hello")'),
    durationMs: 5,
    exitCode: 0,
  });

  return { sessionId, sm };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("exportSession — Markdown format", () => {
  test("renders all sections correctly", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "gear.db");
    const { sessionId, sm } = seedSession(dbPath);
    sm.close();

    const result = await exportSession(dbPath, sessionId, { format: "md" });

    expect(result.content).toContain("# Session Export:");
    expect(result.content).toContain("## Metadata");
    expect(result.content).toContain("## Audit Chain Integrity");
    expect(result.content).toContain("**Status:** VERIFIED");
    expect(result.content).toContain("## Transcript");
    expect(result.content).toContain("Hello, can you write a hello.ts file?");
    expect(result.content).toContain("## Tool Calls (Audit Log)");
    expect(result.content).toContain("write_file");
    expect(result.content).toContain("## File Diffs");
    expect(result.signature).toBeUndefined();
  });
});

describe("exportSession — JSON format", () => {
  test("returns valid JSON with all top-level keys", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "gear.db");
    const { sessionId, sm } = seedSession(dbPath);
    sm.close();

    const result = await exportSession(dbPath, sessionId, { format: "json" });
    const parsed = JSON.parse(result.content) as Record<string, unknown>;

    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.session).toBeDefined();
    expect((parsed.session as Record<string, unknown>).id).toBe(sessionId);
    expect(parsed.auditChain).toBeDefined();
    expect((parsed.auditChain as Record<string, unknown>).ok).toBe(true);
    expect(parsed.transcript).toBeDefined();
    expect(Array.isArray(parsed.transcript)).toBe(true);
    expect((parsed.transcript as unknown[]).length).toBeGreaterThan(0);
    expect(parsed.toolCalls).toBeDefined();
    expect(Array.isArray(parsed.toolCalls)).toBe(true);
    expect((parsed.toolCalls as unknown[]).length).toBe(2);
    expect(parsed.fileDiffs).toBeDefined();
    expect(Array.isArray(parsed.fileDiffs)).toBe(true);
    expect((parsed.fileDiffs as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("exportSession — signing", () => {
  test("returns signature, publicKey, chainHead when sign:true", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "gear.db");
    const { sessionId, sm } = seedSession(dbPath);
    sm.close();

    const keyDir = join(dir, "keys");
    const result = await exportSession(dbPath, sessionId, {
      format: "md",
      sign: true,
      keyPath: keyDir,
    });

    expect(result.signature).toBeDefined();
    expect(result.publicKey).toBeDefined();
    expect(result.chainHead).toBeDefined();
    // chainHead is a SHA-256 hex string (64 chars)
    expect(result.chainHead!.length).toBe(64);
  });

  test("verifyExport returns true for valid signature", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "gear.db");
    const { sessionId, sm } = seedSession(dbPath);
    sm.close();

    const keyDir = join(dir, "keys");
    const result = await exportSession(dbPath, sessionId, {
      format: "json",
      sign: true,
      keyPath: keyDir,
    });

    const ok = verifyExport(result.content, result.signature!, result.publicKey!);
    expect(ok).toBe(true);
  });

  test("verifyExport returns false when content is tampered", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "gear.db");
    const { sessionId, sm } = seedSession(dbPath);
    sm.close();

    const keyDir = join(dir, "keys");
    const result = await exportSession(dbPath, sessionId, {
      format: "md",
      sign: true,
      keyPath: keyDir,
    });

    const tampered = result.content.replace("VERIFIED", "TAMPERED");
    const ok = verifyExport(tampered, result.signature!, result.publicKey!);
    expect(ok).toBe(false);
  });

  test("generated key persists and can be reused across exports", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "gear.db");
    const { sessionId, sm } = seedSession(dbPath);
    sm.close();

    const keyDir = join(dir, "keys");

    // First export — generates keys
    const r1 = await exportSession(dbPath, sessionId, {
      format: "json",
      sign: true,
      keyPath: keyDir,
    });

    // Second export — reuses persisted keys
    const r2 = await exportSession(dbPath, sessionId, {
      format: "json",
      sign: true,
      keyPath: keyDir,
    });

    // Public keys should be identical (same persisted key)
    expect(r1.publicKey).toBe(r2.publicKey);
    // Content is deterministic, signatures should also be identical for Ed25519
    expect(r1.signature).toBe(r2.signature);
  });
});

describe("exportSession — audit chain integrity", () => {
  test("chainHead changes if audit log differs", async () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    const dbPath1 = join(dir1, "gear.db");
    const dbPath2 = join(dir2, "gear.db");

    const { sessionId: sid1, sm: sm1 } = seedSession(dbPath1);
    // Add an extra audit entry to the second DB to make chain heads differ
    sm1.close();

    const { sessionId: sid2, sm: sm2 } = seedSession(dbPath2);
    sm2.appendAuditEntry({
      sessionId: sid2,
      toolName: "bash",
      argsHash: hashArgs({ command: "ls" }),
      resultHash: hashResult("file.ts"),
      durationMs: 12,
      exitCode: 0,
    });
    sm2.close();

    const keyDir = join(dir1, "keys");
    const r1 = await exportSession(dbPath1, sid1, { format: "json", sign: true, keyPath: keyDir });
    const r2 = await exportSession(dbPath2, sid2, { format: "json", sign: true, keyPath: keyDir });

    // Different audit logs → different chain heads
    expect(r1.chainHead).not.toBe(r2.chainHead);
  });
});

describe("signing primitives (standalone)", () => {
  test("generateEd25519KeyPair produces valid keys that round-trip", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const data = Buffer.from("hello signing world");
    const sig = signBytes(data, privateKeyPem);
    expect(verifySignature(data, sig, publicKeyPem)).toBe(true);
    // Wrong data should fail
    expect(verifySignature(Buffer.from("different"), sig, publicKeyPem)).toBe(false);
  });

  test("verifySignature returns false for an unrelated key", () => {
    const kp1 = generateEd25519KeyPair();
    const kp2 = generateEd25519KeyPair();
    const data = Buffer.from("payload");
    const sig = signBytes(data, kp1.privateKeyPem);
    expect(verifySignature(data, sig, kp2.publicKeyPem)).toBe(false);
  });
});

describe("exportSession — error handling", () => {
  test("throws for unknown sessionId", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "gear.db");
    // Create the DB but don't seed any session
    const sm = new SessionManager(dbPath);
    sm.close();

    await expect(exportSession(dbPath, "nonexistent-session-id", { format: "md" })).rejects.toThrow(
      "Session not found",
    );
  });
});
