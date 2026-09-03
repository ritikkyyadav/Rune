// ─── AWS Signature Version 4 ───
//
// A complete SigV4 request signer over `node:crypto`, ~200 lines, with no AWS
// SDK dependency. The SDK would be the obvious answer and is the wrong one
// here: `@aws-sdk/client-bedrock-runtime` pulls in ~40 packages and its own
// HTTP stack, and Gear ships as a single `bun build --compile` binary where
// every transitive dependency is weight in the artifact and a supply-chain
// surface in the audit. Signing is a pure function of (method, path, query,
// headers, body, credentials, clock) — the one part of AWS that is genuinely
// small enough to own.
//
// Owning it also makes it TESTABLE against AWS's own published vectors rather
// than against itself: `tests/unit/gateway/aws-sigv4.test.ts` checks the
// documented signing-key derivation, the canonical request, the string to
// sign, and the final Authorization header for the `get-vanilla` /
// `post-vanilla` cases of the AWS SigV4 test suite. A signer that agrees with
// AWS's worked example on all four intermediates is not "probably right".

import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials (STS, web identity, container roles). */
  sessionToken?: string;
}

export interface SignRequestInput {
  method: string;
  /** The full request URL. Its path is expected to be ALREADY percent-encoded. */
  url: string | URL;
  region: string;
  /** The AWS service name used in the credential scope ("bedrock", "sts", …). */
  service: string;
  /** Request headers. `host` is derived from the URL when absent. */
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  credentials: AwsCredentials;
  /** Fixed clock, for tests. Defaults to now. */
  now?: Date;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

/** SHA-256, lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * RFC 3986 percent-encoding.
 *
 * `encodeURIComponent` leaves `!'()*` alone — they are "mark" characters in the
 * older RFC 2396 that RFC 3986 moved into the reserved set — and AWS canonical
 * forms expect them encoded. `~` must stay literal, which encodeURIComponent
 * already does. Getting this wrong produces a signature mismatch on exactly the
 * requests whose path or query happens to contain one of five characters, which
 * is the worst possible failure shape: intermittent and blamed on credentials.
 */
export function escapeUri(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The canonical URI: every path segment escaped AGAIN.
 *
 * SigV4 requires double encoding for every service except S3. The path handed
 * in is already encoded once (a Bedrock model id like
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0` reaches the wire with its
 * colon as `%3A`), so the canonical form carries `%253A` while the request line
 * carries `%3A`. Escaping the `/` separators back out is what keeps the path
 * a path.
 */
export function canonicalUri(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname
    .split("/")
    .map((segment) => escapeUri(segment))
    .join("/");
}

/** The canonical query string: escaped, then sorted by name and then value. */
export function canonicalQuery(search: string): string {
  if (!search || search === "?") return "";
  const params: [string, string][] = [];
  for (const pair of search.replace(/^\?/, "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    // The URL already holds encoded values; decode once so the escape below is
    // applied exactly once rather than compounding.
    params.push([escapeUri(safeDecode(name)), escapeUri(safeDecode(value))]);
  }
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return params.map(([k, v]) => `${k}=${v}`).join("&");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface CanonicalRequest {
  canonical: string;
  signedHeaders: string;
  payloadHash: string;
}

/**
 * Build the canonical request. Header names lowercase and sorted; values
 * trimmed with runs of internal whitespace collapsed to one space.
 */
export function buildCanonicalRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string | Uint8Array | undefined,
): CanonicalRequest {
  const normalized: [string, string][] = Object.entries(headers)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]);
  normalized.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalHeaders = normalized.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = normalized.map(([k]) => k).join(";");
  const payloadHash = headers["x-amz-content-sha256"] ?? sha256Hex(body ?? "");

  const canonical = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  return { canonical, signedHeaders, payloadHash };
}

/** `YYYYMMDDTHHMMSSZ` — the `x-amz-date` format. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Derive the signing key: HMAC("AWS4"+secret, date) → region → service →
 * "aws4_request". Exported because AWS publishes a worked example of exactly
 * this chain, which is the cheapest possible check that the primitive is right
 * before any request shape is involved.
 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SignedRequest {
  /** The headers to send — the caller's, plus the ones signing added. */
  headers: Record<string, string>;
  /** Intermediates, for tests and for a diagnostic that never prints a secret. */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/**
 * Sign a request. Returns the complete header set to send.
 *
 * The credential's secret never appears in the output — only the derived
 * signature does, which is the point of SigV4 and the reason a Bedrock route
 * can be debugged from logs without leaking anything.
 */
export function signRequest(input: SignRequestInput): SignedRequest {
  const url = input.url instanceof URL ? input.url : new URL(input.url);
  const now = input.now ?? new Date();
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);

  const headers: Record<string, string> = {
    host: url.host,
    ...(input.headers ?? {}),
  };
  headers["x-amz-date"] = stamp;
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const { canonical, signedHeaders, payloadHash } = buildCanonicalRequest(
    input.method,
    url,
    headers,
    input.body,
  );
  void payloadHash;

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonical)].join("\n");
  const signingKey = deriveSigningKey(
    input.credentials.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  headers.authorization =
    `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers, canonicalRequest: canonical, stringToSign, signature };
}
