/**
 * The page a browser lands on after an OAuth sign-in (OpenRouter, ChatGPT).
 *
 * These tests used to share a file with the Claude subscription sign-in's
 * authorize-URL tests. That sign-in is retired (see
 * docs/program/compliance-subscription-routes.md); the page is generic and
 * stays.
 */

import { describe, test, expect } from "bun:test";
import { successPage } from "../../../packages/llm-gateway/src/auth/oauth-strategy";

describe("the page you land on after signing in", () => {
  test("names what was actually connected", () => {
    expect(successPage("ChatGPT Plus / Pro")).toContain("connected to ChatGPT Plus / Pro");
  });

  test("carries the Rune mark inline, so it needs no network", () => {
    const html = successPage("OpenRouter");
    expect(html).toContain("<svg");
    expect(html).toContain("Rune");
    // Served from localhost after an auth redirect: an external fetch here
    // would be both slow and a needless third party in the flow.
    expect(/https?:\/\//.test(html)).toBe(false);
  });

  test("reads in dark mode too", () => {
    // A browser opened from a dark terminal should not flashbang the person
    // who just signed in.
    expect(successPage("X")).toContain("prefers-color-scheme:dark");
  });

  test("escapes the provider label", () => {
    const html = successPage('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("falls back to something sensible with no label", () => {
    expect(successPage()).toContain("your account");
  });
});
