// ─── GitHub Copilot device-code login ───
// The headless OAuth device flow GitHub documents (RFC 8628): request a device +
// user code, the user enters the short code at github.com/login/device, and we
// poll until they approve. The result is a durable GitHub OAuth token — the
// CopilotProvider mints short-lived Copilot API tokens from it per session.
//
// The client id is GitHub's public Copilot CLI/editor client (the same one the
// official editor plugins use — not a secret); override with
// GEAR_COPILOT_CLIENT_ID if GitHub rotates it (the older variable remains supported).

import type { DeviceAuthorization, DeviceFlow, DevicePoll } from "../auth/device-code-strategy";

const CLIENT_ID = process.env.GEAR_COPILOT_CLIENT_ID ?? "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const JSON_HEADERS = { accept: "application/json", "content-type": "application/json" };

export const githubCopilotDeviceFlow: DeviceFlow = {
  providerId: "copilot",
  // The stored secret is the durable GitHub OAuth token; the CopilotProvider
  // exchanges it for short-lived Copilot tokens itself, so no refresh here.
  credentialKind: "apiKey",

  async startDeviceAuth(): Promise<DeviceAuthorization> {
    const res = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub device authorization failed (${res.status}): ${body.slice(0, 160)}`);
    }
    const j = (await res.json().catch(() => ({}))) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
    };
    if (!j.device_code || !j.user_code || !j.verification_uri) {
      throw new Error("GitHub device authorization response was incomplete");
    }
    return {
      deviceCode: j.device_code,
      userCode: j.user_code,
      verificationUri: j.verification_uri,
      intervalSec: j.interval,
      expiresInSec: j.expires_in,
    };
  },

  async poll(deviceCode: string): Promise<DevicePoll> {
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: GRANT_TYPE,
      }),
    });
    // A transient non-200 shouldn't abort the whole login — keep polling.
    if (!res.ok) return { status: "pending" };
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (j.access_token) return { status: "done", result: { secret: j.access_token } };
    switch (j.error) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return { status: "slow_down" };
      case "expired_token":
        return { status: "expired" };
      case "access_denied":
        return { status: "denied" };
      default:
        return { status: "pending" };
    }
  },
};
