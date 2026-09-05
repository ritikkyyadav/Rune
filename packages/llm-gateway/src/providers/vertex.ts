// ─── Google Vertex AI ───
//
// The one enterprise route that serves TWO model families on one account:
// Anthropic through the Vertex Anthropic endpoint and Gemini through the Vertex
// Gemini endpoint. Both are auth-and-endpoint variants over adapters that
// already exist — `AnthropicProvider` with a rewritten URL, `GoogleProvider`
// with a base URL and a bearer header — so `vertex` is a router with two inner
// providers and no wire format of its own.
//
// Routing is by model id, because that is the only thing that distinguishes
// them and it is unambiguous: Vertex names Anthropic models
// `claude-sonnet-4-5@20250929` and Gemini models `gemini-2.5-pro`. So
// `/model vertex/claude-…` and `/model vertex/gemini-…` are the same provider,
// the same project, the same bill, and two different endpoints — which is
// exactly how Vertex itself presents them.
//
// What differs from the first-party APIs:
//
//   Anthropic  POST …/publishers/anthropic/models/{model}:streamRawPredict
//              body carries `anthropic_version: "vertex-2023-10-16"` and no
//              `model` (the path has it). The response is already SSE — no
//              framing to decode, unlike Bedrock.
//   Gemini     POST …/publishers/google/models/{model}:streamGenerateContent
//              with `?alt=sse`; identical body to AI Studio.
//   Auth       `Authorization: Bearer <ADC token>` on both, never `?key=`.

import type {
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ModelInfo,
  StreamEvent,
  StreamOpts,
  ToolDefinition,
} from "../types";
import { ApiError } from "../types";
import { AnthropicProvider } from "./anthropic";
import { GoogleProvider } from "./google";
import {
  createGoogleTokenResolver,
  describeAdcSource,
  resolveGoogleAdc,
  type AdcOpts,
  type GoogleAccessToken,
} from "./google/adc";

/** The `anthropic_version` Vertex's Anthropic runtime expects in the body. */
export const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";

/** Where Anthropic models are widely available; also Vertex's own default. */
const DEFAULT_LOCATION = "us-east5";

export interface VertexOpts extends AdcOpts {
  /** `[providers.vertex] project`, else GOOGLE_CLOUD_PROJECT / the credential's. */
  project?: string;
  /** `[providers.vertex] location`, else GOOGLE_CLOUD_LOCATION. "global" is valid. */
  location?: string;
  /** Override the API host (tests, Private Service Connect endpoints). */
  baseUrl?: string;
}

/**
 * Which Vertex publisher serves a model id.
 *
 * Deliberately explicit rather than a default: an id that matches neither
 * family is a typo or a publisher Rune does not route, and answering "Gemini,
 * probably" would send it to an endpoint that 404s with a message about the
 * wrong publisher. Naming the real problem is cheaper to debug.
 */
export function vertexPublisher(model: string): "anthropic" | "google" | undefined {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gemini")) return "google";
  return undefined;
}

/** The regional API host. Vertex's multi-region endpoint has no location prefix. */
export function vertexHost(location: string): string {
  return location === "global"
    ? "https://aiplatform.googleapis.com"
    : `https://${location}-aiplatform.googleapis.com`;
}

/** The publisher-scoped base path a model lives under. */
export function vertexPublisherPath(
  project: string,
  location: string,
  publisher: "anthropic" | "google",
): string {
  return `/v1/projects/${project}/locations/${location}/publishers/${publisher}`;
}

/**
 * A resolved-credential probe for the boot path and `rune providers`. Returns
 * a printable source ("service account rune@proj.iam…") or null — never the token.
 */
export async function vertexCredentialSource(opts: AdcOpts = {}): Promise<string | null> {
  const token = await resolveGoogleAdc(opts);
  return token ? describeAdcSource(token) : null;
}

/** Everything both inner providers need — plain values, no `this`. */
interface VertexConfig {
  project: string | undefined;
  location: string;
  host: string;
  token: () => Promise<GoogleAccessToken | null>;
}

/** The Anthropic half: the shared adapter with the URL and auth swapped. */
class VertexAnthropic extends AnthropicProvider {
  constructor(config: VertexConfig) {
    super("vertex", config.host, {
      name: "vertex",
      utilityModel: "claude-haiku-4-5@20251001",
      fetch: (url, init) => vertexAnthropicFetch(config, url, init),
    });
  }
}

/** The Gemini half: the shared adapter with the base URL and header swapped. */
class VertexGemini extends GoogleProvider {
  protected readonly healthModel = "gemini-2.5-flash";

  constructor(config: VertexConfig) {
    super(
      undefined,
      `${config.host}${vertexPublisherPath(config.project ?? "-", config.location, "google")}`,
      {
        name: "vertex",
        authHeaders: async (): Promise<Record<string, string>> => {
          const token = await config.token();
          // An empty header set is how "no credential" reaches the adapter —
          // `hasCredential()` reads it and raises the actionable message rather
          // than sending `Bearer undefined` and reading back a 401 nobody can act on.
          return token ? { authorization: `Bearer ${token.token}` } : {};
        },
      },
    );
  }
}

export class VertexProvider implements LlmProvider {
  readonly name = "vertex" as const;
  private readonly config: VertexConfig;
  private readonly anthropic: VertexAnthropic;
  private readonly gemini: VertexGemini;

  constructor(opts: VertexOpts = {}) {
    const env = opts.env ?? process.env;
    const location =
      opts.location || env.GOOGLE_CLOUD_LOCATION || env.VERTEX_LOCATION || DEFAULT_LOCATION;
    const project =
      opts.project || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.CLOUDSDK_CORE_PROJECT;
    this.config = {
      project,
      location,
      host: (opts.baseUrl ?? vertexHost(location)).replace(/\/$/, ""),
      token: createGoogleTokenResolver(opts),
    };
    this.anthropic = new VertexAnthropic(this.config);
    this.gemini = new VertexGemini(this.config);
  }

  /** The inner adapter for a model id, or a 404 naming the real problem. */
  private route(model: string): LlmProvider {
    const publisher = vertexPublisher(model);
    if (publisher === "anthropic") return this.anthropic;
    if (publisher === "google") return this.gemini;
    throw new ApiError({
      status: 404,
      provider: "vertex",
      message:
        `Vertex has no publisher for "${model}". Rune routes ids starting with ` +
        `"claude" to the Anthropic publisher and "gemini" to Google's.`,
    });
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    return await this.route(request.model).infer(request);
  }

  /**
   * An async generator rather than a plain delegation, so a routing failure
   * surfaces as a REJECTION of the iteration instead of a synchronous throw
   * from the call itself. The gateway wraps `for await` in its try/catch, not
   * the call that creates the iterator — a sync throw would escape the retry
   * and fallback machinery entirely.
   */
  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    yield* this.route(request.model).inferStream(request, opts);
  }

  /**
   * Token counting follows the family: Anthropic on Vertex has no count-tokens
   * endpoint under the raw-predict path, and Gemini's takes the same shape as
   * AI Studio's. Both are approximations against the context engine's own
   * tokenizer, which is the authority for compaction either way.
   */
  async countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number> {
    const text =
      JSON.stringify(messages.map((m) => m.content)) + (tools ? JSON.stringify(tools) : "");
    return Math.ceil(text.length / 4);
  }

  /**
   * Health is "does ADC resolve and is a project configured", never a real
   * completion. Both halves of that answer are things a user can act on, and
   * neither costs a token to find out.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.config.project) return false;
    return (await this.config.token()) !== null;
  }

  /**
   * Live discovery across BOTH publishers, which is the list a Vertex user
   * actually picks from. Publisher model listing is unauthenticated metadata
   * about what Vertex offers, but the token is sent anyway so a project with
   * restricted access sees its own view.
   */
  async listModels(): Promise<ModelInfo[]> {
    const token = await this.config.token();
    if (!token) throw vertexNoCredentials();
    const headers = { authorization: `Bearer ${token.token}` };
    const out: ModelInfo[] = [];
    for (const publisher of ["anthropic", "google"] as const) {
      const url = `${this.config.host}/v1/publishers/${publisher}/models?pageSize=200`;
      let res: Response;
      try {
        res = await fetch(url, { headers });
      } catch {
        continue;
      }
      if (!res.ok) continue;
      const json = (await res.json()) as {
        publisherModels?: { name?: string; versionId?: string; openSourceCategory?: string }[];
      };
      for (const m of json.publisherModels ?? []) {
        // `publishers/anthropic/models/claude-sonnet-4-5` → the leaf id.
        const leaf = (m.name ?? "").split("/").pop() ?? "";
        if (!leaf) continue;
        // Anthropic ids need the @version suffix to be invokable; Gemini's do not.
        const id = publisher === "anthropic" && m.versionId ? `${leaf}@${m.versionId}` : leaf;
        out.push({ id, label: id, live: true });
      }
    }
    if (!out.length) throw new Error("Vertex publisher listing returned nothing");
    return out;
  }
}

// ─── The Anthropic transport ───

/** The 401 a request gets when ADC resolved to nothing. */
export const NO_GOOGLE_CREDENTIALS =
  "No Google Cloud credentials found. Run `gcloud auth application-default login`, " +
  "or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key.";

/** The 400 a request gets when no project is configured. */
export const NO_VERTEX_PROJECT =
  "No Google Cloud project configured for Vertex. Set GOOGLE_CLOUD_PROJECT, or " +
  "`[providers.vertex] project` in config.toml.";

function vertexNoCredentials(): ApiError {
  return new ApiError({ status: 401, provider: "vertex", message: NO_GOOGLE_CREDENTIALS });
}

/**
 * Rewrite the Anthropic SDK's request into a Vertex one and add the bearer.
 *
 * Exported for the fixture tests, which drive it with a recorded SSE body and
 * never touch the network.
 */
export async function vertexAnthropicFetch(
  config: VertexConfig,
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  const path = new URL(requestUrl).pathname;
  if (!path.endsWith("/v1/messages")) {
    throw new ApiError({ status: 404, provider: "vertex", message: `no Vertex route for ${path}` });
  }

  if (!config.project) return errorResponse(400, "project_missing", NO_VERTEX_PROJECT);
  const token = await config.token();
  // A synthetic 401 rather than a throw: the Anthropic SDK re-raises a thrown
  // transport error as "Connection error." AFTER retrying it, which would lose
  // the one message that says what to do. A 401 response is not retried.
  if (!token) return errorResponse(401, "credentials_missing", NO_GOOGLE_CREDENTIALS);

  const raw = typeof init?.body === "string" ? init.body : "";
  const body = JSON.parse(raw || "{}") as Record<string, unknown>;
  const model = String(body.model ?? "");
  const streaming = body.stream === true;
  delete body.model;
  delete body.stream;
  body.anthropic_version = VERTEX_ANTHROPIC_VERSION;

  const base = `${config.host}${vertexPublisherPath(config.project, config.location, "anthropic")}`;
  const action = streaming ? "streamRawPredict" : "rawPredict";
  const target = `${base}/models/${encodeURIComponent(model)}:${action}`;

  const res = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // Vertex's Anthropic endpoint already speaks SSE — nothing to decode, which
  // is the one place this route is simpler than Bedrock.
  if (res.ok) return res;
  return await toAnthropicError(res);
}

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Re-shape a Google API error into Anthropic's error envelope.
 *
 * Vertex answers `{"error": {"code", "message", "status"}}`; the Anthropic SDK
 * looks for `{"error": {"type", "message"}}` and, finding no `type`, raises
 * with an unhelpful message. A permission error on a fresh project is the most
 * common failure on this route, so its text has to survive.
 */
async function toAnthropicError(res: Response): Promise<Response> {
  const text = await res.text();
  let message = text || `vertex error (${res.status})`;
  let type = "vertex_error";
  try {
    const json = JSON.parse(text) as { error?: { message?: string; status?: string } };
    if (json.error?.message) message = json.error.message;
    if (json.error?.status) type = json.error.status;
  } catch {
    // Not JSON — keep the raw text.
  }
  return errorResponse(res.status, type, message);
}

export type { VertexConfig };
