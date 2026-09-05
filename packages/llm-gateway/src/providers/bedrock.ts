// ─── AWS Bedrock ───
//
// Anthropic models on AWS. This is an AUTH-AND-ENDPOINT VARIANT over the
// existing Anthropic adapter, not a second Anthropic implementation: the
// Messages body, the streaming event grammar, the thinking parameters, the
// tool translation, the `cache_control` breakpoints and the usage accounting
// are all the ones in `anthropic.ts`, and stay in one place.
//
// Four things differ, and this file is exactly those four things:
//
//   1. **The URL.** `POST /v1/messages` becomes
//      `POST /model/{modelId}/invoke-with-response-stream` (or `/invoke`).
//   2. **The body.** `model` moves into the path and `anthropic_version` moves
//      into the body as `bedrock-2023-05-31`. `stream` disappears — the path
//      says it.
//   3. **The auth.** SigV4 over the standard credential chain instead of
//      `x-api-key`.
//   4. **The framing.** The response is `vnd.amazon.eventstream`, decoded back
//      into SSE so the SDK's parser reads it unchanged.
//
// Everything else — every future fix to Anthropic streaming — is inherited.

import type { LlmProvider, Message, ModelInfo, ToolDefinition } from "../types";
import { ApiError } from "../types";
import { AnthropicProvider } from "./anthropic";
import { signRequest } from "./aws/sigv4";
import {
  createAwsCredentialResolver,
  describeAwsSource,
  resolveAwsCredentials,
  type AwsChainOpts,
  type ResolvedAwsCredentials,
} from "./aws/credentials";
import { eventStreamToSse } from "./aws/event-stream";

/** The `anthropic_version` Bedrock's Anthropic runtime expects in the body. */
export const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

/** Fallback region when neither env, config, nor a profile names one. */
const DEFAULT_REGION = "us-east-1";

export interface BedrockOpts extends AwsChainOpts {
  /** `[llm.bedrock] region`, else AWS_REGION / the profile's region. */
  region?: string;
  /**
   * Which cross-region inference profile family to use, or "none" to send the
   * model id untouched. Defaults to the family implied by the region.
   */
  inferenceProfile?: InferenceProfileFamily | "none";
  /** Override the runtime host (tests, VPC endpoints, FIPS endpoints). */
  baseUrl?: string;
}

export type InferenceProfileFamily = "us" | "eu" | "apac";

/**
 * The inference-profile family a region belongs to.
 *
 * Most current Anthropic models on Bedrock are only invokable through a
 * CROSS-REGION INFERENCE PROFILE — an id carrying a geography prefix
 * (`us.anthropic.claude-…`) that routes the request across that geography's
 * regions. A `us.` id sent to `eu-central-1` is rejected, so the prefix has to
 * follow the region rather than be baked into the catalogue. Anything outside
 * the three published geographies returns undefined and the model id is sent
 * verbatim, which is the honest answer: a guessed prefix is a 400 with a
 * confusing message.
 */
export function inferenceProfileFamily(region: string): InferenceProfileFamily | undefined {
  if (/^us-gov-/.test(region)) return undefined;
  if (/^us-/.test(region)) return "us";
  if (/^(eu|il)-/.test(region)) return "eu";
  if (/^ap-/.test(region)) return "apac";
  return undefined;
}

/** Geo prefixes an id may already carry — the set this function may rewrite. */
const PROFILE_PREFIX = /^(us|eu|apac|us-gov)\./;

/**
 * Align a model id's geo prefix with the target region.
 *
 * Only ids that ALREADY carry a prefix are rewritten: a bare foundation-model
 * id (`anthropic.claude-3-5-haiku-20241022-v1:0`) is on-demand invokable and
 * must not grow one, and a full ARN is left alone entirely. So the catalogue
 * can ship one set of `us.`-prefixed ids and a user in Frankfurt still reaches
 * a model, without the picker carrying three copies of every row.
 */
export function applyInferenceProfile(
  model: string,
  family: InferenceProfileFamily | "none" | undefined,
): string {
  if (!family || family === "none") return model;
  if (model.startsWith("arn:")) return model;
  if (!PROFILE_PREFIX.test(model)) return model;
  return model.replace(PROFILE_PREFIX, `${family}.`);
}

/**
 * A resolved-credential probe for the boot path and `rune providers`. Returns
 * a printable source ("profile default") or null — never the secret.
 */
export async function bedrockCredentialSource(opts: AwsChainOpts = {}): Promise<string | null> {
  const cred = await resolveAwsCredentials(opts);
  return cred ? describeAwsSource(cred) : null;
}

/** Everything the transport needs — no `this`, so it can be built before super(). */
interface BedrockTransport {
  region: string;
  runtimeHost: string;
  controlHost: string;
  profileFamily: InferenceProfileFamily | "none" | undefined;
  credentials: () => Promise<ResolvedAwsCredentials | null>;
}

export class BedrockProvider extends AnthropicProvider implements LlmProvider {
  private readonly transport: BedrockTransport;

  constructor(opts: BedrockOpts = {}) {
    const env = opts.env ?? process.env;
    const region = opts.region || env.AWS_REGION || env.AWS_DEFAULT_REGION || DEFAULT_REGION;
    const transport: BedrockTransport = {
      region,
      runtimeHost: (opts.baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`).replace(
        /\/$/,
        "",
      ),
      controlHost: `https://bedrock.${region}.amazonaws.com`,
      profileFamily: opts.inferenceProfile ?? inferenceProfileFamily(region),
      credentials: createAwsCredentialResolver(opts),
    };

    // `apiKey` is a placeholder the SDK requires and the transport discards —
    // Bedrock authenticates per request with SigV4, so there is no key here to
    // leak. The custom fetch is where the real request is built.
    super("bedrock", transport.runtimeHost, {
      name: "bedrock",
      utilityModel: "anthropic.claude-3-5-haiku-20241022-v1:0",
      fetch: (url, init) => bedrockFetch(transport, url, init),
    });

    this.transport = transport;
  }

  /**
   * Bedrock has no count-tokens endpoint, so the inherited call would 404 on
   * every context measurement. A character estimate is worse than the real
   * count and far better than an exception: the context engine's own tokenizer
   * is the authority for scheduling compaction, and this is the coarse
   * cross-check.
   */
  async countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number> {
    const text =
      JSON.stringify(messages.map((m) => m.content)) + (tools ? JSON.stringify(tools) : "");
    return Math.ceil(text.length / 4);
  }

  /**
   * Health is "do credentials resolve", not "does an inference succeed".
   * Spending a real completion to answer a health check is how a probe becomes
   * a bill; and for Bedrock the only failure this can catch — no credential —
   * is the one that actually happens.
   */
  async healthCheck(): Promise<boolean> {
    return (await this.transport.credentials()) !== null;
  }

  /**
   * Live discovery via the Bedrock control plane's ListFoundationModels.
   *
   * Ids whose `inferenceTypesSupported` lacks `ON_DEMAND` can only be invoked
   * through an inference profile, so they are returned WITH the region's geo
   * prefix. A list whose ids 400 when you pick one is worse than no list.
   */
  async listModels(): Promise<ModelInfo[]> {
    const url = new URL(`${this.transport.controlHost}/foundation-models`);
    url.searchParams.set("byOutputModality", "TEXT");
    url.searchParams.set("byProvider", "Anthropic");
    const res = await signedFetch(this.transport, "GET", url, undefined, {});
    if (!res.ok) {
      throw new ApiError({
        status: res.status,
        provider: "bedrock",
        message: await errorMessage(res, "Bedrock ListFoundationModels failed"),
      });
    }
    const json = (await res.json()) as {
      modelSummaries?: {
        modelId?: string;
        modelName?: string;
        inferenceTypesSupported?: string[];
        responseStreamingSupported?: boolean;
      }[];
    };
    const family = this.transport.profileFamily;
    return (json.modelSummaries ?? [])
      .filter((m) => m.modelId && m.responseStreamingSupported !== false)
      .map((m) => {
        const onDemand = m.inferenceTypesSupported?.includes("ON_DEMAND") ?? true;
        const id =
          onDemand || !family || family === "none" ? m.modelId! : `${family}.${m.modelId!}`;
        return { id, label: m.modelName ?? id, live: true };
      });
  }
}

// ─── The transport ───

/**
 * The whole Bedrock adaptation: rewrite the Anthropic SDK's request into a
 * Bedrock one, sign it, and turn the answer back into something the SDK
 * understands. Exported for the fixture tests, which drive it with a recorded
 * event-stream body and never touch the network.
 */
export async function bedrockFetch(
  transport: BedrockTransport,
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  const path = new URL(requestUrl).pathname;

  // The SDK only ever calls /v1/messages and /v1/messages/count_tokens here;
  // countTokens is overridden above, so anything else is a programming error
  // rather than a request to translate.
  if (!path.endsWith("/v1/messages")) {
    throw new ApiError({
      status: 404,
      provider: "bedrock",
      message: `no Bedrock route for ${path}`,
    });
  }

  const raw = typeof init?.body === "string" ? init.body : "";
  const body = JSON.parse(raw || "{}") as Record<string, unknown>;
  const model = applyInferenceProfile(String(body.model ?? ""), transport.profileFamily);
  const streaming = body.stream === true;
  delete body.model;
  delete body.stream;
  body.anthropic_version = BEDROCK_ANTHROPIC_VERSION;

  // Anthropic betas ride in a header on the first-party API and in the BODY on
  // Bedrock. Translating rather than dropping is what keeps interleaved
  // thinking working on this route.
  const beta = headerValue(init?.headers as RequestHeaders | undefined, "anthropic-beta");
  if (beta) {
    body.anthropic_beta = beta
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const action = streaming ? "invoke-with-response-stream" : "invoke";
  const target = new URL(`${transport.runtimeHost}/model/${encodeURIComponent(model)}/${action}`);
  const payload = JSON.stringify(body);
  const res = await signedFetch(transport, "POST", target, payload, {
    "content-type": "application/json",
    accept: streaming ? "application/vnd.amazon.eventstream" : "application/json",
  });

  if (!res.ok) return await toAnthropicError(res);
  if (!streaming || !res.body) return res;

  // The SDK's SSE parser reads this exactly as it reads the first-party API.
  // Cast: `Response.body` is typed loosely across the DOM/Bun lib pair; the
  // runtime value is a byte stream, which is what the decoder reads.
  return new Response(eventStreamToSse(res.body as ReadableStream<Uint8Array>), {
    status: res.status,
    headers: { "content-type": "text/event-stream" },
  });
}

/** The message a request gets when the credential chain resolved to nothing. */
export const NO_AWS_CREDENTIALS =
  "No AWS credentials found. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, run " +
  "`aws configure`, or select a profile with AWS_PROFILE.";

/** Sign and send. The credential is resolved per call and never logged. */
async function signedFetch(
  transport: BedrockTransport,
  method: string,
  url: URL,
  body: string | undefined,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const cred = await transport.credentials();
  if (!cred) {
    // A synthetic 401 rather than a thrown error, deliberately. The Anthropic
    // SDK catches transport exceptions and re-raises them as
    // "Connection error." AFTER retrying — so throwing here would lose the one
    // message that tells the user what to do and would spend three round trips
    // discovering the same absent credential. A 401 response carries the text
    // intact and is not retried.
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "credentials_missing", message: NO_AWS_CREDENTIALS },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  const signed = signRequest({
    method,
    url,
    region: transport.region,
    service: "bedrock",
    headers: extraHeaders,
    body,
    credentials: cred,
  });
  return await fetch(url.href, {
    method,
    headers: signed.headers,
    ...(body !== undefined ? { body } : {}),
  });
}

/**
 * Read one header out of any of the three shapes `RequestInit.headers` takes.
 * Spelled structurally rather than as `HeadersInit`, which is a DOM-lib type
 * this package does not pull in.
 */
type RequestHeaders = Headers | [string, string][] | Record<string, string>;

function headerValue(headers: RequestHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => k.toLowerCase() === name);
    return found?.[1];
  }
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === name);
  return entry?.[1] as string | undefined;
}

/**
 * Re-shape a Bedrock error into Anthropic's error envelope.
 *
 * Bedrock answers `{"message": "…"}` with the class in an `x-amzn-errortype`
 * header; the Anthropic SDK looks for `{"error": {"type", "message"}}` and,
 * finding neither, raises with an empty message. A 403 that reads as "" is the
 * single most expensive kind of error to debug, so it is translated here.
 */
async function toAnthropicError(res: Response): Promise<Response> {
  const message = await errorMessage(res, `bedrock error (${res.status})`);
  const type = (res.headers.get("x-amzn-errortype") ?? "bedrock_error").split(":")[0]!;
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

/** Pull a human message out of an AWS (or already-translated) error body. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text();
  if (!text) return fallback;
  try {
    const json = JSON.parse(text) as {
      message?: string;
      Message?: string;
      error?: { message?: string };
    };
    return json.error?.message ?? json.message ?? json.Message ?? text;
  } catch {
    return text;
  }
}

export type { BedrockTransport };
