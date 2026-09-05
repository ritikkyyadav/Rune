/**
 * P7.1 — attribution.
 *
 * A run that cannot say what configuration produced it is an anecdote. Three
 * things had to exist before anything downstream could be honest: the doctrine
 * has a version and a hash, the session row records which prompt it ran under,
 * and the A/B-relevant config projects to a stable digest.
 *
 * These tests are mostly about STABILITY — a hash that changes when it should
 * not is worse than no hash, because it silently splits one arm into two.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../../../packages/shared/src/session";
import {
  DOCTRINE_VERSION,
  doctrineHash,
  FULL_DOCTRINE_CONTEXT,
} from "../../../packages/orchestrator/src/prompts";
import {
  AB_CONFIG_KEYS,
  AB_FORBIDDEN_KEYS,
  abConfigOf,
  configHash,
} from "../../../packages/orchestrator/src/evolve/config-hash";
import { rmTemp } from "../../helpers/tmp";

describe("doctrine attribution", () => {
  it("has a hand-maintained version", () => {
    expect(Number.isInteger(DOCTRINE_VERSION)).toBe(true);
    expect(DOCTRINE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("hashes to twelve stable hex characters", () => {
    const a = doctrineHash();
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(doctrineHash()).toBe(a);
    expect(doctrineHash(FULL_DOCTRINE_CONTEXT)).toBe(a);
  });

  it("separates sessions that render different doctrine", () => {
    // Two sessions on one build can render different text — one has a
    // delegation tool, one does not. Treating those as one configuration is
    // how an A/B lies about what it measured.
    const full = doctrineHash({ canDelegate: true, greenfield: true, buildsInterfaces: true });
    const noDelegation = doctrineHash({
      canDelegate: false,
      greenfield: true,
      buildsInterfaces: true,
    });
    const mature = doctrineHash({
      canDelegate: true,
      greenfield: false,
      buildsInterfaces: false,
    });
    expect(new Set([full, noDelegation, mature]).size).toBe(3);
  });
});

describe("session records the prompt it ran under", () => {
  it("writes system_prompt_hash and reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-attrib-"));
    try {
      const sm = new SessionManager(join(dir, "rune.db"));
      const created = sm.createSession("/tmp/ws", "m", "anthropic", "abc123def456");
      expect(created.systemPromptHash).toBe("abc123def456");
      expect(sm.getSession(created.id)?.systemPromptHash).toBe("abc123def456");
      expect(sm.listSessions({ status: "all" })[0]?.systemPromptHash).toBe("abc123def456");
      sm.close();
    } finally {
      rmTemp(dir);
    }
  });

  it("leaves it null when the caller has none, rather than inventing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-attrib-"));
    try {
      const sm = new SessionManager(join(dir, "rune.db"));
      const created = sm.createSession("/tmp/ws", "m", "anthropic");
      expect(created.systemPromptHash).toBeNull();
      expect(sm.getSession(created.id)?.systemPromptHash).toBeNull();
      sm.close();
    } finally {
      rmTemp(dir);
    }
  });
});

describe("configHash", () => {
  it("is stable across key order and undefined fields", () => {
    const a = configHash({ doctrineDelivery: "full", effortRouting: "off" });
    const b = configHash({ effortRouting: "off", doctrineDelivery: "full", model: undefined });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("treats an unset field and its default as the same run", () => {
    expect(configHash({})).toBe(
      configHash({
        doctrineDelivery: "jit",
        effortRouting: "conservative",
        reasoningEffort: "high",
      }),
    );
  });

  it("ignores fields that are environment, not behaviour", () => {
    const base = configHash({ doctrineDelivery: "full" });
    expect(
      configHash({
        doctrineDelivery: "full",
        workspaceRoot: "/somewhere/else",
        dbPath: "/tmp/other.db",
        model: "a-different-model",
        toolsBinaryPath: "/opt/rune-tools",
      }),
    ).toBe(base);
  });

  it("changes when a behaviour field changes", () => {
    const hashes = new Set([
      configHash({}),
      configHash({ doctrineDelivery: "full" }),
      configHash({ effortRouting: "off" }),
      configHash({ reasoningEffort: "medium" }),
      configHash({ notebook: { enabled: true } }),
      configHash({ context: { repoMap: false } }),
      configHash({ evolve: { playbook: false } }),
    ]);
    expect(hashes.size).toBe(7);
  });

  it("never lets a safety or spend field into the projection", () => {
    // The allowlist is the boundary. If one of these ever reaches the hash it
    // means a variant could carry it, which is the mutation this phase exists
    // to prevent.
    for (const forbidden of AB_FORBIDDEN_KEYS) {
      expect(AB_CONFIG_KEYS as readonly string[]).not.toContain(forbidden);
      expect(Object.keys(abConfigOf({}))).not.toContain(forbidden);
    }
    const withSafetyOff = configHash({
      yoloMode: true,
      trustWorkspace: true,
      sandboxEnabled: false,
      maxSessionCostUsd: 999,
      verifyPerStep: false,
      autoMode: { failClosed: false },
    });
    expect(withSafetyOff).toBe(configHash({}));
  });
});
