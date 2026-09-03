// ─── The AWS credential chain ───
//
// Resolve credentials the way every AWS tool on the machine already does, so
// `gear -p bedrock` works for someone who has run `aws configure` or who is
// inside a task role, with nothing Gear-specific to set up. The order is the
// standard one:
//
//   1. environment variables       AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
//   2. the shared config files     ~/.aws/credentials and ~/.aws/config, the
//                                  profile named by AWS_PROFILE
//   3. web identity                AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN,
//                                  or the same pair declared in the profile
//   4. container credentials       AWS_CONTAINER_CREDENTIALS_RELATIVE_URI or
//                                  _FULL_URI (ECS / EKS pod identity)
//
// **IMDS is deliberately not in the chain.** The instance metadata service is
// the last rung in the AWS SDKs, and on a laptop it is a request to a
// link-local address that does not answer — the SDKs pay a 1s timeout plus
// retries for it on every cold start. Gear resolves credentials on the
// no-credential path too (`gear providers` must print an honest row), so a
// hanging probe would be a second of latency on a command whose answer is
// "no". Anything running ON EC2 with an instance role can export the standard
// env vars or use a profile; containers, the case that actually matters for a
// team running Gear in CI, are covered by rung 4.
//
// Nothing here logs. A resolved credential's secret is returned to the signer
// and never rendered: `describeAwsSource()` is what the UI prints.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AwsCredentials } from "./sigv4";

/** Where a credential came from — printable, and never the secret itself. */
export type AwsCredentialSource = "env" | "profile" | "web-identity" | "container";

export interface ResolvedAwsCredentials extends AwsCredentials {
  source: AwsCredentialSource;
  /** The profile name, when rung 2/3 resolved it. */
  profile?: string;
  /** Region discovered alongside the credential (config file / env). */
  region?: string;
  /** Epoch ms after which temporary credentials stop working. */
  expiresAt?: number;
}

export interface AwsChainOpts {
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to reading the real files. */
  readFileImpl?: (path: string) => Promise<string>;
  /** Home directory override, for tests. */
  home?: string;
}

/** The default region, resolved the way the AWS CLI resolves it. */
export async function resolveAwsRegion(opts: AwsChainOpts = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const fromEnv = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (fromEnv) return fromEnv;
  const profile = env.AWS_PROFILE || "default";
  const config = await loadIniFile(configFilePath(opts), opts);
  // ~/.aws/config names non-default profiles as `[profile foo]`.
  const section = config[`profile ${profile}`] ?? config[profile];
  return section?.region;
}

/**
 * Walk the chain. Returns null when nothing resolves — the honest answer that
 * lets `gear providers` print "no credential" instead of a crash or a guess.
 * Never throws: a malformed ~/.aws/credentials is a missing credential, not a
 * broken startup.
 */
export async function resolveAwsCredentials(
  opts: AwsChainOpts = {},
): Promise<ResolvedAwsCredentials | null> {
  const env = opts.env ?? process.env;

  // 1. Environment variables.
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      source: "env",
      ...(env.AWS_REGION || env.AWS_DEFAULT_REGION
        ? { region: env.AWS_REGION || env.AWS_DEFAULT_REGION }
        : {}),
    };
  }

  const profileName = env.AWS_PROFILE || "default";
  const credentialsIni = await loadIniFile(credentialsFilePath(opts), opts);
  const configIni = await loadIniFile(configFilePath(opts), opts);
  const profile = {
    ...(configIni[`profile ${profileName}`] ?? configIni[profileName] ?? {}),
    ...(credentialsIni[profileName] ?? {}),
  };

  // 2. Static keys in the shared files.
  if (profile.aws_access_key_id && profile.aws_secret_access_key) {
    return {
      accessKeyId: profile.aws_access_key_id,
      secretAccessKey: profile.aws_secret_access_key,
      ...(profile.aws_session_token ? { sessionToken: profile.aws_session_token } : {}),
      source: "profile",
      profile: profileName,
      ...(profile.region ? { region: profile.region } : {}),
    };
  }

  // 3. Web identity — env first, then the same pair declared in the profile.
  const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE || profile.web_identity_token_file;
  const roleArn = env.AWS_ROLE_ARN || profile.role_arn;
  if (tokenFile && roleArn) {
    const region = (await resolveAwsRegion(opts)) ?? "us-east-1";
    const cred = await assumeRoleWithWebIdentity(
      { tokenFile, roleArn, sessionName: env.AWS_ROLE_SESSION_NAME || "gear", region },
      opts,
    );
    if (cred) return { ...cred, profile: profileName, region };
  }

  // 4. Container credentials (ECS task role / EKS pod identity).
  const containerUri = containerCredentialUri(env);
  if (containerUri) {
    const cred = await fetchContainerCredentials(containerUri, opts);
    if (cred) return cred;
  }

  return null;
}

/** A one-line, secret-free description of where a credential came from. */
export function describeAwsSource(cred: ResolvedAwsCredentials): string {
  switch (cred.source) {
    case "env":
      return "environment";
    case "profile":
      return `profile ${cred.profile ?? "default"}`;
    case "web-identity":
      return "web identity";
    case "container":
      return "container role";
  }
}

// ─── Shared config files ───

function credentialsFilePath(opts: AwsChainOpts): string {
  const env = opts.env ?? process.env;
  return env.AWS_SHARED_CREDENTIALS_FILE || join(opts.home ?? homedir(), ".aws", "credentials");
}

function configFilePath(opts: AwsChainOpts): string {
  const env = opts.env ?? process.env;
  return env.AWS_CONFIG_FILE || join(opts.home ?? homedir(), ".aws", "config");
}

/**
 * Parse an AWS-style INI file into `{ section: { key: value } }`.
 *
 * Deliberately minimal: AWS's own format is `key = value` under `[section]`
 * headers with `#`/`;` comments. Nested sub-sections (`sso_session`) are
 * flattened away rather than half-supported — a profile Gear cannot fully
 * resolve should fall through to the next rung, not produce a broken
 * credential.
 */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      out[section] ??= {};
      continue;
    }
    if (!section) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    // An indented continuation line belongs to a nested sub-section; skip it.
    if (!key || rawLine.startsWith(" ") || rawLine.startsWith("\t")) continue;
    out[section]![key] = value;
  }
  return out;
}

async function loadIniFile(
  path: string,
  opts: AwsChainOpts,
): Promise<Record<string, Record<string, string>>> {
  try {
    const read = opts.readFileImpl ?? ((p: string) => readFile(p, "utf-8"));
    return parseIni(await read(path));
  } catch {
    return {};
  }
}

// ─── Web identity (STS AssumeRoleWithWebIdentity) ───

/**
 * Exchange an OIDC token for temporary credentials.
 *
 * This STS call is UNSIGNED — it is the one AWS API that authenticates with the
 * web-identity token itself, which is exactly why it can bootstrap a chain that
 * has no keys yet. The response is XML (STS has no JSON protocol), so the four
 * fields are pulled with tag matches rather than a parser dependency.
 */
async function assumeRoleWithWebIdentity(
  args: { tokenFile: string; roleArn: string; sessionName: string; region: string },
  opts: AwsChainOpts,
): Promise<ResolvedAwsCredentials | null> {
  try {
    const read = opts.readFileImpl ?? ((p: string) => readFile(p, "utf-8"));
    const token = (await read(args.tokenFile)).trim();
    if (!token) return null;
    const body = new URLSearchParams({
      Action: "AssumeRoleWithWebIdentity",
      Version: "2011-06-15",
      RoleArn: args.roleArn,
      RoleSessionName: args.sessionName,
      WebIdentityToken: token,
    });
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`https://sts.${args.region}.amazonaws.com/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const accessKeyId = tag(xml, "AccessKeyId");
    const secretAccessKey = tag(xml, "SecretAccessKey");
    const sessionToken = tag(xml, "SessionToken");
    if (!accessKeyId || !secretAccessKey) return null;
    const expiration = tag(xml, "Expiration");
    return {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      source: "web-identity",
      ...(expiration ? { expiresAt: Date.parse(expiration) } : {}),
    };
  } catch {
    return null;
  }
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m?.[1];
}

// ─── Container credentials ───

function containerCredentialUri(env: NodeJS.ProcessEnv): string | undefined {
  if (env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
    return `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`;
  }
  return undefined;
}

async function fetchContainerCredentials(
  uri: string,
  opts: AwsChainOpts,
): Promise<ResolvedAwsCredentials | null> {
  const env = opts.env ?? process.env;
  try {
    const headers: Record<string, string> = {};
    let authToken = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    if (!authToken && env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) {
      const read = opts.readFileImpl ?? ((p: string) => readFile(p, "utf-8"));
      authToken = (await read(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE)).trim();
    }
    if (authToken) headers.authorization = authToken;
    const doFetch = opts.fetchImpl ?? fetch;
    // Bounded: the credential endpoint is link-local and either answers at once
    // or is not there. A hang here would stall every `gear providers`.
    const res = await doFetch(uri, { headers, signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      Token?: string;
      Expiration?: string;
    };
    if (!json.AccessKeyId || !json.SecretAccessKey) return null;
    return {
      accessKeyId: json.AccessKeyId,
      secretAccessKey: json.SecretAccessKey,
      ...(json.Token ? { sessionToken: json.Token } : {}),
      source: "container",
      ...(json.Expiration ? { expiresAt: Date.parse(json.Expiration) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * A credential resolver with a small TTL cache.
 *
 * Temporary credentials expire, and the container/STS rungs are network calls,
 * so re-resolving per request would be both wrong (a cached expiry ignored) and
 * slow. This re-resolves when the cached credential is within 60s of expiry, or
 * after 5 minutes for static ones (so a `aws configure` mid-session is picked
 * up without a restart).
 */
export function createAwsCredentialResolver(
  opts: AwsChainOpts = {},
): () => Promise<ResolvedAwsCredentials | null> {
  let cached: ResolvedAwsCredentials | null = null;
  let cachedAt = 0;
  return async () => {
    const now = Date.now();
    const stale =
      !cached ||
      now - cachedAt > 5 * 60_000 ||
      (cached.expiresAt !== undefined && cached.expiresAt - now < 60_000);
    if (stale) {
      cached = await resolveAwsCredentials(opts);
      cachedAt = now;
    }
    return cached;
  };
}
