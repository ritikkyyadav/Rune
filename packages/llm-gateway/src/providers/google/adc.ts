// ─── Google Application Default Credentials ───
//
// Resolve a Google access token the way every Google tool on the machine does,
// so `gear -p vertex` works for someone who has run `gcloud auth
// application-default login` or who is inside a service account, with nothing
// Gear-specific to set up. The order is ADC's own:
//
//   1. GOOGLE_APPLICATION_CREDENTIALS → a service-account or authorized-user
//      JSON key file
//   2. the gcloud ADC file (~/.config/gcloud/application_default_credentials.json,
//      %APPDATA%\gcloud\… on Windows) — normally an authorized_user refresh token
//   3. the GCE/Cloud Run metadata server, probed with a short timeout
//
// A **service account** key is exchanged the documented way: build a JWT
// asserting the service account and the cloud-platform scope, sign it RS256
// with the key's private PEM (node:crypto — no `google-auth-library`, no
// `jsonwebtoken`), and POST it to the token endpoint under the
// `urn:ietf:params:oauth:grant-type:jwt-bearer` grant. An **authorized user**
// file is a plain refresh-token grant against the same endpoint.
//
// The private key never leaves this module and is never logged. What callers
// get back is a short-lived access token and a printable SOURCE.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSign } from "node:crypto";

/** Where an ADC token came from — printable, and never the credential. */
export type AdcSource = "service-account" | "gcloud" | "metadata";

export interface GoogleAccessToken {
  token: string;
  /** Epoch ms when the token stops working. */
  expiresAt: number;
  source: AdcSource;
  /** The service account's email / the project the file names, when known. */
  detail: string;
  /** GCP project id, when the credential names one. */
  projectId?: string;
}

export interface AdcOpts {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFileImpl?: (path: string) => Promise<string>;
  home?: string;
  /** Fixed clock, for tests. */
  now?: () => number;
}

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const METADATA_HOST = "http://metadata.google.internal";
/** The metadata server answers instantly or is not there. Never hang on it. */
const METADATA_TIMEOUT_MS = 1_000;

/** A service-account or authorized-user JSON key, as Google writes it. */
interface AdcKeyFile {
  type?: string;
  client_email?: string;
  private_key?: string;
  private_key_id?: string;
  token_uri?: string;
  project_id?: string;
  quota_project_id?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
}

/**
 * Resolve an access token from Application Default Credentials.
 *
 * Returns null when nothing resolves — the honest answer that lets
 * `gear providers` print "no credential" instead of a crash. Never throws: a
 * malformed key file is a missing credential, not a broken startup.
 */
export async function resolveGoogleAdc(opts: AdcOpts = {}): Promise<GoogleAccessToken | null> {
  const env = opts.env ?? process.env;

  // 1. An explicit key file.
  const explicit = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (explicit) {
    const token = await fromKeyFile(explicit, opts);
    if (token) return token;
  }

  // 2. The gcloud ADC file.
  const token = await fromKeyFile(gcloudAdcPath(opts), opts);
  if (token) return token;

  // 3. The metadata server, only when it is plausible AND bounded.
  return await fromMetadata(opts);
}

/** The gcloud ADC file's platform-specific path. */
export function gcloudAdcPath(opts: AdcOpts = {}): string {
  const env = opts.env ?? process.env;
  if (env.CLOUDSDK_CONFIG) return join(env.CLOUDSDK_CONFIG, "application_default_credentials.json");
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "gcloud", "application_default_credentials.json");
  }
  return join(opts.home ?? homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/** A one-line, secret-free description of where a token came from. */
export function describeAdcSource(token: GoogleAccessToken): string {
  switch (token.source) {
    case "service-account":
      return `service account ${token.detail}`;
    case "gcloud":
      return "gcloud ADC";
    case "metadata":
      return "metadata server";
  }
}

// ─── Key files ───

async function fromKeyFile(path: string, opts: AdcOpts): Promise<GoogleAccessToken | null> {
  let key: AdcKeyFile;
  try {
    const read = opts.readFileImpl ?? ((p: string) => readFile(p, "utf-8"));
    key = JSON.parse(await read(path)) as AdcKeyFile;
  } catch {
    return null;
  }

  if (key.type === "service_account" && key.client_email && key.private_key) {
    return await exchangeServiceAccountJwt(key, opts);
  }
  if (key.type === "authorized_user" && key.refresh_token && key.client_id && key.client_secret) {
    return await exchangeRefreshToken(key, opts);
  }
  return null;
}

/**
 * Build and sign the assertion JWT, then exchange it for an access token.
 *
 * Exported for the fixture test, which signs with a generated key and verifies
 * the header and claims against the public half — the only way to check a
 * signature without asserting a hash the test computed itself.
 */
export function buildServiceAccountJwt(
  key: { client_email: string; private_key: string; private_key_id?: string; token_uri?: string },
  nowSeconds: number,
): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(key.private_key_id ? { kid: key.private_key_id } : {}),
  };
  const claims = {
    iss: key.client_email,
    sub: key.client_email,
    scope: SCOPE,
    aud: key.token_uri ?? TOKEN_URI,
    iat: nowSeconds,
    // One hour is the documented maximum; Google rejects longer.
    exp: nowSeconds + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(key.private_key)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

async function exchangeServiceAccountJwt(
  key: AdcKeyFile,
  opts: AdcOpts,
): Promise<GoogleAccessToken | null> {
  const now = opts.now?.() ?? Date.now();
  try {
    const assertion = buildServiceAccountJwt(
      {
        client_email: key.client_email!,
        private_key: key.private_key!,
        ...(key.private_key_id ? { private_key_id: key.private_key_id } : {}),
        ...(key.token_uri ? { token_uri: key.token_uri } : {}),
      },
      Math.floor(now / 1000),
    );
    const token = await postToken(
      key.token_uri ?? TOKEN_URI,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      },
      opts,
      now,
    );
    if (!token) return null;
    return {
      ...token,
      source: "service-account",
      detail: key.client_email!,
      ...(key.project_id ? { projectId: key.project_id } : {}),
    };
  } catch {
    // A bad PEM throws inside createSign; that is a missing credential, not a
    // crash — the next rung gets its turn.
    return null;
  }
}

async function exchangeRefreshToken(
  key: AdcKeyFile,
  opts: AdcOpts,
): Promise<GoogleAccessToken | null> {
  const now = opts.now?.() ?? Date.now();
  const token = await postToken(
    key.token_uri ?? TOKEN_URI,
    {
      grant_type: "refresh_token",
      client_id: key.client_id!,
      client_secret: key.client_secret!,
      refresh_token: key.refresh_token!,
    },
    opts,
    now,
  );
  if (!token) return null;
  return {
    ...token,
    source: "gcloud",
    detail: "gcloud ADC",
    ...((key.quota_project_id ?? key.project_id)
      ? { projectId: (key.quota_project_id ?? key.project_id)! }
      : {}),
  };
}

async function postToken(
  uri: string,
  form: Record<string, string>,
  opts: AdcOpts,
  now: number,
): Promise<{ token: string; expiresAt: number } | null> {
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    return { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  } catch {
    return null;
  }
}

// ─── The metadata server ───

async function fromMetadata(opts: AdcOpts): Promise<GoogleAccessToken | null> {
  const env = opts.env ?? process.env;
  // Google's own opt-out, honoured so a locked-down machine is not probed.
  if (env.GCE_METADATA_HOST === "" || env.NO_GCE_CHECK === "true") return null;
  const host = env.GCE_METADATA_HOST ? `http://${env.GCE_METADATA_HOST}` : METADATA_HOST;
  const now = opts.now?.() ?? Date.now();
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(
      `${host}/computeMetadata/v1/instance/service-accounts/default/token`,
      {
        headers: { "Metadata-Flavor": "Google" },
        // Bounded: off GCE this address does not answer, and a coding session
        // must not pay a hang for asking.
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    return {
      token: json.access_token,
      expiresAt: now + (json.expires_in ?? 3600) * 1000,
      source: "metadata",
      detail: "metadata server",
    };
  } catch {
    return null;
  }
}

// ─── Project and location ───

/**
 * The GCP project id, resolved the way `gcloud` resolves it: the explicit
 * config, then the standard env vars, then whatever the credential itself
 * names. A Vertex request without a project has nowhere to go, so this
 * returning undefined is a real error the caller must surface rather than
 * paper over.
 */
export async function resolveGoogleProject(
  opts: AdcOpts & { configured?: string } = {},
): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  if (opts.configured) return opts.configured;
  const fromEnv =
    env.GOOGLE_CLOUD_PROJECT ||
    env.GCLOUD_PROJECT ||
    env.GOOGLE_CLOUD_QUOTA_PROJECT ||
    env.CLOUDSDK_CORE_PROJECT;
  if (fromEnv) return fromEnv;
  const token = await resolveGoogleAdc(opts);
  return token?.projectId;
}

/**
 * A token resolver with a refresh-before-expiry cache.
 *
 * Vertex tokens last an hour and every request needs one, so re-running the
 * whole chain per call would be both slow and a token-endpoint call per turn.
 * Refresh at 60s before expiry.
 */
export function createGoogleTokenResolver(
  opts: AdcOpts = {},
): () => Promise<GoogleAccessToken | null> {
  let cached: GoogleAccessToken | null = null;
  return async () => {
    const now = opts.now?.() ?? Date.now();
    if (!cached || cached.expiresAt - now < 60_000) {
      cached = await resolveGoogleAdc(opts);
    }
    return cached;
  };
}
