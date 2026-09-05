// ─── Shared helpers for the BYOP CLI verbs (login / providers / use / models) ───
// Single source of truth for the credential-merge and interactive I/O these verbs
// need, so `rune login`, `rune providers`, and the boot path in rune-cli all
// resolve keys the same way (no drift). No Engine boot — these run standalone,
// like the telemetry/doctor subcommands.

import { createInterface } from "node:readline";
import type { RuneConfig, SecretsFile, AuthMethod, CredentialStore } from "@rune/shared";

/**
 * The saved keys the gateway treats as "middle precedence" (below the secure
 * store, above env). Mirrors the Engine's own seed: config-file keys that don't
 * merely echo an env var, then ~/.rune/secrets.json (which wins). Kept here so
 * the boot path and the CLI verbs never diverge.
 */
export function buildSavedKeys(
  config: RuneConfig,
  secrets: SecretsFile,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...(config.llm.anthropic?.apiKey && !env.ANTHROPIC_API_KEY
      ? { anthropic: config.llm.anthropic.apiKey }
      : {}),
    ...(config.llm.openai?.apiKey && !env.OPENAI_API_KEY
      ? { openai: config.llm.openai.apiKey }
      : {}),
    ...(config.llm.openrouter?.apiKey && !env.OPENROUTER_API_KEY
      ? { openrouter: config.llm.openrouter.apiKey }
      : {}),
    ...(config.llm.google?.apiKey && !env.GOOGLE_API_KEY
      ? { google: config.llm.google.apiKey }
      : {}),
    ...secrets.keys,
  };
}

/** Per-provider auth-method overrides from `[llm.<id>] authentication = "…"`. */
export function readAuthOverrides(config: RuneConfig): Record<string, AuthMethod> {
  const out: Record<string, AuthMethod> = {};
  const llm = config.llm as unknown as Record<string, { authentication?: string } | undefined>;
  const valid: ReadonlySet<string> = new Set(["api_key", "oauth", "device", "local", "chain"]);
  for (const id of ["anthropic", "openai", "openrouter", "google", "ollama"]) {
    const m = llm[id]?.authentication;
    if (m && valid.has(m)) out[id] = m as AuthMethod;
  }
  return out;
}

/** The one-line notice shown whenever secrets are held in the plaintext fallback. */
export function insecureNoticeLine(store: CredentialStore): string | null {
  if (store.secure) return null;
  return "⚠ credentials stored unencrypted at ~/.rune/credentials.json (no OS keychain available)";
}

/** Open a URL in the user's default browser (best effort; never throws). */
export function openBrowser(url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const cmd =
        process.platform === "darwin"
          ? ["open", url]
          : process.platform === "win32"
            ? ["cmd", "/c", "start", "", url]
            : ["xdg-open", url];
      // Bun.spawn: detached, no stdio, swallows a missing-binary error here
      // rather than emitting an unhandled 'error' event like child_process would.
      Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    } catch {
      // ignore — browser couldn't be launched; the caller prints the URL instead.
    }
    resolve();
  });
}

/** Read a single line from stdin with a prompt. */
export function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question + " ", (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

/** True when stdin is an interactive terminal (browser/paste flows need one). */
export function isInteractive(): boolean {
  return !!process.stdin.isTTY;
}
