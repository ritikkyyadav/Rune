// ─── Device-code strategy (RFC 8628) ───
// The headless / SSH-friendly OAuth fallback: no local browser or loopback. The
// user is shown a short code + URL to open on ANY device; meanwhile we poll the
// token endpoint until they approve. Generic engine here; a provider supplies the
// device-authorization + polling specifics via `DeviceFlow`. Kept ready for any
// provider that officially supports device authorization (none is wired by
// default — see auth/oauth-registry.ts).

import { oauthAccount } from "@alan/shared";
import type { AuthContext, AuthenticationStrategy, ResolvedCredential, AuthMethod } from "./types";
import { AuthError } from "./types";
import type { ExchangeResult } from "./oauth-strategy";

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** A URL with the code pre-filled, if the provider gives one. */
  verificationUriComplete?: string;
  /** Seconds between polls (default 5). */
  intervalSec?: number;
  /** Seconds until the device code expires. */
  expiresInSec?: number;
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "done"; result: ExchangeResult }
  | { status: "denied" }
  | { status: "expired" };

export interface DeviceFlow {
  readonly providerId: string;
  readonly credentialKind: "apiKey" | "bearer";
  /** Begin device authorization → the code/URL to show the user. */
  startDeviceAuth(): Promise<DeviceAuthorization>;
  /** Poll once for completion. */
  poll(deviceCode: string): Promise<DevicePoll>;
  refresh?(refreshToken: string): Promise<ExchangeResult>;
}

interface StoredOAuth {
  secret: string;
  refreshToken?: string;
  expiresAt?: number;
  method: AuthMethod;
}

const REFRESH_SKEW_MS = 60_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DeviceCodeStrategy implements AuthenticationStrategy {
  readonly method: AuthMethod = "device";

  constructor(
    private readonly flow: DeviceFlow,
    /** Injectable for tests — avoids real waits. */
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async authenticate(ctx: AuthContext): Promise<ResolvedCredential> {
    let auth: DeviceAuthorization;
    try {
      auth = await this.flow.startDeviceAuth();
    } catch (err) {
      throw this.fail(ctx, `couldn't start device authorization: ${errMsg(err)}`);
    }

    const where = auth.verificationUriComplete ?? auth.verificationUri;
    ctx.log?.(`To authorize ${ctx.preset.label}, visit:\n  ${where}`);
    ctx.log?.(`and enter the code:  ${auth.userCode}`);

    let intervalMs = (auth.intervalSec ?? 5) * 1000;
    const deadline = Date.now() + (auth.expiresInSec ?? 900) * 1000;

    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw this.fail(ctx, "login aborted");
      await this.sleep(intervalMs);
      let poll: DevicePoll;
      try {
        poll = await this.flow.poll(auth.deviceCode);
      } catch (err) {
        throw this.fail(ctx, `polling failed: ${errMsg(err)}`);
      }
      if (poll.status === "done") {
        const cred = this.toCred(poll.result);
        await this.persist(ctx, {
          secret: poll.result.secret,
          refreshToken: poll.result.refreshToken,
          expiresAt: cred.expiresAt,
          method: "device",
        });
        return cred;
      }
      if (poll.status === "denied") throw this.fail(ctx, "authorization was denied");
      if (poll.status === "expired") break;
      if (poll.status === "slow_down") intervalMs += 5000; // RFC 8628 §3.5
    }
    throw this.fail(ctx, "the device code expired before authorization completed");
  }

  async loadCredentials(ctx: AuthContext): Promise<ResolvedCredential | null> {
    const blob = await this.readBlob(ctx);
    if (!blob) return null;
    if (
      blob.expiresAt &&
      blob.expiresAt - Date.now() < REFRESH_SKEW_MS &&
      blob.refreshToken &&
      this.flow.refresh
    ) {
      try {
        return await this.doRefresh(ctx, blob.refreshToken);
      } catch {
        return null;
      }
    }
    return this.credFromBlob(blob);
  }

  async refresh(ctx: AuthContext): Promise<ResolvedCredential | null> {
    const blob = await this.readBlob(ctx);
    if (!blob) return null;
    if (blob.refreshToken && this.flow.refresh) return this.doRefresh(ctx, blob.refreshToken);
    return this.credFromBlob(blob);
  }

  async validate(_ctx: AuthContext, cred: ResolvedCredential): Promise<boolean> {
    return typeof cred.secret === "string" && cred.secret.length > 0;
  }

  async storeCredentials(ctx: AuthContext, cred: ResolvedCredential): Promise<void> {
    const existing = await this.readBlob(ctx);
    await this.persist(ctx, {
      secret: cred.secret ?? "",
      refreshToken: existing?.refreshToken,
      expiresAt: cred.expiresAt,
      method: "device",
    });
  }

  async logout(ctx: AuthContext): Promise<void> {
    try {
      await ctx.store.delete(oauthAccount(ctx.providerId));
    } catch {
      // never throw
    }
  }

  // ─── internals ───

  private toCred(result: ExchangeResult): ResolvedCredential {
    const expiresAt = result.expiresInSec ? Date.now() + result.expiresInSec * 1000 : undefined;
    return {
      kind: this.flow.credentialKind,
      secret: result.secret,
      expiresAt,
      meta: { method: "device" },
    };
  }

  private credFromBlob(blob: StoredOAuth): ResolvedCredential {
    return {
      kind: this.flow.credentialKind,
      secret: blob.secret,
      expiresAt: blob.expiresAt,
      meta: { method: "device" },
    };
  }

  private async doRefresh(ctx: AuthContext, refreshToken: string): Promise<ResolvedCredential> {
    const result = await this.flow.refresh!(refreshToken);
    const cred = this.toCred(result);
    await this.persist(ctx, {
      secret: result.secret,
      refreshToken: result.refreshToken ?? refreshToken,
      expiresAt: cred.expiresAt,
      method: "device",
    });
    return cred;
  }

  private async persist(ctx: AuthContext, blob: StoredOAuth): Promise<void> {
    await ctx.store.set(oauthAccount(ctx.providerId), JSON.stringify(blob));
  }

  private async readBlob(ctx: AuthContext): Promise<StoredOAuth | null> {
    try {
      const raw = await ctx.store.get(oauthAccount(ctx.providerId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredOAuth;
      return parsed && typeof parsed.secret === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private fail(ctx: AuthContext, message: string): AuthError {
    return new AuthError({
      providerId: ctx.providerId,
      method: this.method,
      message: `Device login failed: ${message}`,
      recovery: `run: berne login ${ctx.providerId}`,
    });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
