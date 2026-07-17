// ─── API-key strategy ───
// Wraps today's key resolution as a first-class auth strategy. This is the
// backward-compatibility firewall: its precedence — secure store → saved key
// (config/secrets) → env var — reproduces the legacy `resolveKey` exactly, with
// the secure store simply prepended. Existing API-key and env-var users see no
// change; a key set via `berne login` (into the keychain) is found first.

import { apiKeyAccount } from "@alan/shared";
import type { AuthContext, AuthenticationStrategy, ResolvedCredential } from "./types";
import { AuthError } from "./types";

export class ApiKeyStrategy implements AuthenticationStrategy {
  readonly method = "api_key" as const;

  async loadCredentials(ctx: AuthContext): Promise<ResolvedCredential | null> {
    const fromStore = await safeGet(ctx, apiKeyAccount(ctx.providerId));
    const fromEnv = ctx.preset.envVar ? ctx.env[ctx.preset.envVar] : undefined;
    const key = fromStore || ctx.savedKey || fromEnv;
    if (!key) return null;
    const source = fromStore ? "keychain" : ctx.savedKey ? "saved" : "env";
    return { kind: "apiKey", secret: key, meta: { method: "api_key", source } };
  }

  async authenticate(ctx: AuthContext): Promise<ResolvedCredential> {
    if (!ctx.prompt) {
      throw new AuthError({
        providerId: ctx.providerId,
        method: this.method,
        message: "no interactive prompt available to enter an API key",
      });
    }
    const hint = ctx.preset.keyHint ? ` (${ctx.preset.keyHint})` : "";
    ctx.log?.(`Paste your ${ctx.preset.label} API key${hint}. Get one at ${ctx.preset.docsUrl}`);
    const key = (await ctx.prompt(`${ctx.preset.label} API key:`)).trim();
    if (!key) {
      throw new AuthError({
        providerId: ctx.providerId,
        method: this.method,
        message: "no API key entered",
      });
    }
    const cred: ResolvedCredential = { kind: "apiKey", secret: key, meta: { method: "api_key" } };
    await this.storeCredentials(ctx, cred);
    return cred;
  }

  /** API keys don't expire — refresh is just a reload. */
  async refresh(ctx: AuthContext): Promise<ResolvedCredential | null> {
    return this.loadCredentials(ctx);
  }

  /** Cheap, offline, never-throws: a usable key is simply non-empty. */
  async validate(_ctx: AuthContext, cred: ResolvedCredential): Promise<boolean> {
    return typeof cred.secret === "string" && cred.secret.trim().length > 0;
  }

  async storeCredentials(ctx: AuthContext, cred: ResolvedCredential): Promise<void> {
    if (cred.secret) await ctx.store.set(apiKeyAccount(ctx.providerId), cred.secret);
  }

  async logout(ctx: AuthContext): Promise<void> {
    try {
      await ctx.store.delete(apiKeyAccount(ctx.providerId));
    } catch {
      // Never throw on logout.
    }
  }
}

async function safeGet(ctx: AuthContext, account: string): Promise<string | null> {
  try {
    return await ctx.store.get(account);
  } catch {
    return null;
  }
}
