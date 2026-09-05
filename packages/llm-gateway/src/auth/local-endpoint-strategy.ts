// ─── Local-endpoint strategy ───
// Formalizes Ollama / LM Studio as an auth METHOD whose "credential" is mere
// connectivity — a base URL, no secret. It carries no key material; `validate`
// is a bounded reachability probe used by `rune providers` / status. Provider
// REGISTRATION for local runtimes stays in buildGateway exactly as before, so
// this adds status/validation without changing who gets registered.

import type { AuthContext, AuthenticationStrategy, ResolvedCredential } from "./types";

export class LocalEndpointStrategy implements AuthenticationStrategy {
  readonly method = "local" as const;

  private baseUrl(ctx: AuthContext): string | undefined {
    return ctx.baseUrl ?? ctx.preset.baseUrl;
  }

  async loadCredentials(ctx: AuthContext): Promise<ResolvedCredential | null> {
    const baseUrl = this.baseUrl(ctx);
    if (!baseUrl) return null;
    return { kind: "none", baseUrl, meta: { method: "local" } };
  }

  async authenticate(ctx: AuthContext): Promise<ResolvedCredential> {
    // "Logging in" to a local runtime is just confirming it's reachable.
    const cred = (await this.loadCredentials(ctx)) ?? { kind: "none" as const };
    const ok = await this.validate(ctx, cred);
    ctx.log?.(
      ok
        ? `${ctx.preset.label} is reachable at ${cred.baseUrl}`
        : `${ctx.preset.label} did not respond at ${cred.baseUrl} — is it running?`,
    );
    return cred;
  }

  async refresh(ctx: AuthContext): Promise<ResolvedCredential | null> {
    return this.loadCredentials(ctx);
  }

  /** Bounded connectivity probe; never throws, resolves false on timeout/error. */
  async validate(ctx: AuthContext, cred: ResolvedCredential): Promise<boolean> {
    const baseUrl = cred.baseUrl ?? this.baseUrl(ctx);
    if (!baseUrl) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(baseUrl, { method: "GET", signal: controller.signal });
      // Any HTTP response (even 404) proves the port is listening.
      return res.status >= 0;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** No credential material to persist. */
  async storeCredentials(): Promise<void> {}
  /** Nothing to remove. */
  async logout(): Promise<void> {}
}
