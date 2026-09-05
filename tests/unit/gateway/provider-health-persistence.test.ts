/**
 * Cross-session provider health.
 *
 * The bug this pins: the gateway learned which models were gone and which
 * plans were capped, and forgot all of it on exit. The black box shows the
 * cost — 24 recorded failures against a model retired six weeks earlier, and
 * 105 rate-limit incidents in ten days, most of them a fresh session
 * re-walking a cascade a previous one had already proved doomed. Each
 * rediscovery is a full request with the entire conversation attached.
 *
 * The contract: remember, expire, and never be the reason a request cannot be
 * made.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderHealthStore,
  RETIREMENT_TTL_MS,
} from "../../../packages/llm-gateway/src/provider-health";

describe("ProviderHealthStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-health-"));
    path = join(dir, "provider-health.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a retirement survives into the next session", () => {
    new ProviderHealthStore(path).noteRetired(
      "ollama-turbo",
      "qwen3-coder-next",
      "410 model was retired",
    );
    // A brand-new instance is the next session.
    const next = new ProviderHealthStore(path);
    expect(next.isRetired("ollama-turbo", "qwen3-coder-next")).toBe(true);
    expect(next.retirementReason("ollama-turbo", "qwen3-coder-next")).toContain("retired");
  });

  test("retirement is scoped to the exact provider and model", () => {
    const s = new ProviderHealthStore(path);
    s.noteRetired("ollama-turbo", "qwen3-coder-next", "gone");
    // A different model on the same provider is untouched — pruning a whole
    // provider because one id died is how a working route gets abandoned.
    expect(s.isRetired("ollama-turbo", "qwen3-coder:480b")).toBe(false);
    expect(s.isRetired("openrouter", "qwen3-coder-next")).toBe(false);
  });

  test("a retirement expires, so a model that comes back is re-probed", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        retired: [
          {
            provider: "openrouter",
            model: "back-from-the-dead",
            until: Date.now() - 1,
            reason: "x",
          },
        ],
        capped: [],
      }),
    );
    expect(new ProviderHealthStore(path).isRetired("openrouter", "back-from-the-dead")).toBe(false);
  });

  test("the TTL is long enough to matter and short enough to self-heal", () => {
    const s = new ProviderHealthStore(path);
    s.noteRetired("openrouter", "m", "gone");
    const rec = s.snapshot().retired[0];
    const ttl = rec.until - Date.now();
    expect(ttl).toBeGreaterThan(RETIREMENT_TTL_MS * 0.9);
    expect(ttl).toBeLessThanOrEqual(RETIREMENT_TTL_MS);
  });

  test("a plan cap survives, with the message that announced it", () => {
    const until = Date.now() + 900_000;
    new ProviderHealthStore(path).noteCapped("codex", until, "The usage limit has been reached");
    const next = new ProviderHealthStore(path);
    expect(next.cappedUntil("codex")).toBe(until);
    expect(next.capMessage("codex")).toContain("usage limit");
  });

  test("an already-elapsed cap is not recorded", () => {
    const s = new ProviderHealthStore(path);
    s.noteCapped("codex", Date.now() - 1000, "stale");
    expect(s.cappedUntil("codex")).toBe(0);
  });

  test("a corrupt file degrades to knowing nothing, never to throwing", () => {
    writeFileSync(path, "{ not json at all");
    const s = new ProviderHealthStore(path);
    expect(s.isRetired("a", "b")).toBe(false);
    expect(s.cappedUntil("a")).toBe(0);
    expect(() => s.noteRetired("a", "b", "r")).not.toThrow();
  });

  test("a file from a future version is ignored rather than misread", () => {
    writeFileSync(path, JSON.stringify({ version: 99, retired: [{ provider: "a", model: "b" }] }));
    expect(new ProviderHealthStore(path).isRetired("a", "b")).toBe(false);
  });

  test("an unwritable path never breaks the caller", () => {
    const s = new ProviderHealthStore(join(dir, "no", "such", "dir", "h.json"));
    expect(() => s.noteRetired("a", "b", "r")).not.toThrow();
    // In-memory view is still correct for this session.
    expect(s.isRetired("a", "b")).toBe(true);
  });

  test("a record can be cleared when a model returns early", () => {
    const s = new ProviderHealthStore(path);
    s.noteRetired("openrouter", "m", "gone");
    s.clearRetired("openrouter", "m");
    expect(s.isRetired("openrouter", "m")).toBe(false);
    expect(new ProviderHealthStore(path).isRetired("openrouter", "m")).toBe(false);
  });

  test("re-noting the same model replaces rather than accumulates", () => {
    const s = new ProviderHealthStore(path);
    s.noteRetired("openrouter", "m", "first");
    s.noteRetired("openrouter", "m", "second");
    const snap = s.snapshot();
    expect(snap.retired.filter((r) => r.model === "m").length).toBe(1);
    expect(snap.retired[0].reason).toBe("second");
  });
});
