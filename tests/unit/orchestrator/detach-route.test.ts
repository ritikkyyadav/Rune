/**
 * `rune detach` forwards its route flags to the host.
 *
 * The defect this pins: `rune detach "…" -p ollama-turbo -m gpt-oss:120b --gear 4`
 * printed "detached run started" and then ran on model.json's pinned route, which
 * that day was a free model OpenRouter had retired. The flags were parsed and
 * dropped. The host's only boot-time channel is its environment, so the launcher
 * hands them over as session-scoped variables that beat the pin — never as
 * `RUNE_PROVIDER`/`RUNE_MODEL`, which are machine defaults the pin rightly wins.
 */

import { describe, expect, test } from "bun:test";
import { detachRouteEnv } from "../../../packages/orchestrator/src/bin/detach-cli";

describe("detachRouteEnv", () => {
  test("provider, model and gear become the host's session-scoped route", () => {
    expect(detachRouteEnv({ provider: "ollama-turbo", model: "gpt-oss:120b", gear: "4" })).toEqual({
      RUNE_SESSION_PROVIDER: "ollama-turbo",
      RUNE_SESSION_MODEL: "gpt-oss:120b",
      RUNE_GEAR: "4",
    });
  });

  test("nothing given, nothing forwarded — the pin decides", () => {
    expect(detachRouteEnv({ workspace: "/tmp/x", worktree: true })).toEqual({});
  });

  test("a model alone rides on the pinned provider; a provider alone takes its default model", () => {
    expect(detachRouteEnv({ model: "gpt-oss:120b" })).toEqual({
      RUNE_SESSION_MODEL: "gpt-oss:120b",
    });
    expect(detachRouteEnv({ provider: "ollama-turbo" })).toEqual({
      RUNE_SESSION_PROVIDER: "ollama-turbo",
    });
  });

  test("the machine defaults are never written: no RUNE_PROVIDER or RUNE_MODEL", () => {
    const env = detachRouteEnv({ provider: "codex", model: "gpt-5.6-sol" });
    expect(env).not.toHaveProperty("RUNE_PROVIDER");
    expect(env).not.toHaveProperty("RUNE_MODEL");
  });

  test("--yolo is the legacy spelling of --gear 4; --gear wins when both are given", () => {
    expect(detachRouteEnv({ yolo: true })).toEqual({ RUNE_GEAR: "4" });
    expect(detachRouteEnv({ yolo: true, gear: "2" })).toEqual({ RUNE_GEAR: "2" });
  });

  test("whitespace and non-strings are ignored", () => {
    expect(detachRouteEnv({ provider: "  ", model: 42, gear: "" })).toEqual({});
  });
});
