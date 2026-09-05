// ─── Azure OpenAI ───
//
// The same OpenAI models over the same Chat Completions wire, addressed by
// DEPLOYMENT NAME instead of model id. This is the thinnest of the three
// enterprise routes: `OpenAIProvider` already accepts a `fetch` and default
// headers, so everything below is a URL rewrite plus a header choice, and the
// entire request/response translation — tool calls, vision, reasoning params,
// `prompt_cache_key`, the usage trailer — is the one in `openai.ts`.
//
// What differs:
//
//   URL      `POST {endpoint}/openai/deployments/{deployment}/chat/completions
//             ?api-version={version}` instead of `POST {base}/chat/completions`.
//   Model    the body's `model` names a DEPLOYMENT. Azure ignores it in favour
//             of the path, but sending the deployment name keeps request logs
//             and the path consistent.
//   Auth     `api-key: <resource key>`, or `Authorization: Bearer <Entra token>`.
//
// **Deployments are named by whoever created them.** Rune's catalogue lists
// MODEL ids, because that is what a person picks; `[providers.azure-openai.
// deployments]` maps a model id to the deployment your resource actually has,
// and defaults to the id itself — the common case, since Azure lets you name a
// deployment after its model.

import type { ModelInfo, ProviderName } from "../types";
import { OpenAIProvider } from "./openai";
import { cacheBreakpointPolicyFor } from "./cache-policy";

/**
 * Default `api-version`. A GA version rather than a preview one: previews are
 * withdrawn on a schedule and a withdrawn default breaks every user at once,
 * which is exactly the rot this repo has been bitten by on model ids.
 * Override with `[providers.azure-openai] apiVersion`.
 */
export const DEFAULT_AZURE_API_VERSION = "2024-10-21";

export interface AzureOpenAIOpts {
  /** `AZURE_OPENAI_ENDPOINT`, e.g. https://my-resource.openai.azure.com */
  endpoint?: string;
  /** `[providers.azure-openai] apiVersion`. */
  apiVersion?: string;
  /** `[providers.azure-openai.deployments]` — model id → deployment name. */
  deployments?: Record<string, string>;
  /** The resource key (`api-key` header). Omit to use an Entra bearer token. */
  apiKey?: string;
  /** An Entra ID access token (`Authorization: Bearer`). Used when no key. */
  entraToken?: string;
  env?: NodeJS.ProcessEnv;
}

/** The endpoint origin, however the user wrote it. */
export function normalizeAzureEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  // A user who pastes the full chat-completions URL out of the portal gets what
  // they meant rather than a 404 with a doubled path.
  return trimmed.replace(/\/openai(\/.*)?$/, "");
}

/**
 * The deployment a model id maps to.
 *
 * Falls back to the id itself, which is right far more often than not: Azure's
 * own portal defaults a deployment's name to its model. Mapping is only needed
 * when someone named theirs `prod-chat`.
 */
export function azureDeploymentFor(
  model: string,
  deployments: Record<string, string> | undefined,
): string {
  return deployments?.[model] ?? model;
}

/** Everything the transport needs — plain values, so it predates `this`. */
interface AzureTransport {
  endpoint: string;
  apiVersion: string;
  deployments: Record<string, string>;
  apiKey?: string;
  entraToken?: string;
}

/** The message a request gets when neither credential is present. */
export const NO_AZURE_CREDENTIALS =
  "No Azure OpenAI credential found. Set AZURE_OPENAI_API_KEY (or AZURE_OPENAI_AD_TOKEN " +
  "for Entra ID) alongside AZURE_OPENAI_ENDPOINT.";

/** The message a request gets when no resource endpoint is configured. */
export const NO_AZURE_ENDPOINT =
  "No Azure OpenAI endpoint configured. Set AZURE_OPENAI_ENDPOINT, or " +
  "`[providers.azure-openai] endpoint` in config.toml.";

export class AzureOpenAIProvider extends OpenAIProvider {
  private readonly transport: AzureTransport;

  constructor(opts: AzureOpenAIOpts = {}) {
    const env = opts.env ?? process.env;
    const transport: AzureTransport = {
      endpoint: normalizeAzureEndpoint(opts.endpoint || env.AZURE_OPENAI_ENDPOINT || ""),
      apiVersion: opts.apiVersion || env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION,
      deployments: opts.deployments ?? {},
      ...(opts.apiKey || env.AZURE_OPENAI_API_KEY
        ? { apiKey: opts.apiKey || env.AZURE_OPENAI_API_KEY }
        : {}),
      ...(opts.entraToken || env.AZURE_OPENAI_AD_TOKEN
        ? { entraToken: opts.entraToken || env.AZURE_OPENAI_AD_TOKEN }
        : {}),
    };

    // The SDK needs SOME key; the transport replaces the header it produces, so
    // this placeholder never reaches the wire. `baseUrl` is a stand-in the
    // rewrite discards — the real URL is built per request from the deployment.
    super("azure", `${transport.endpoint || "https://azure.invalid"}/openai`, "azure-openai", {
      fetch: (url, init) => azureFetch(transport, url, init),
      cacheBreakpoints: cacheBreakpointPolicyFor("azure-openai"),
    });

    this.transport = transport;
  }

  /**
   * The deployments this resource actually has.
   *
   * The honest answer to "what can I run here", and a different question from
   * "what models does Azure offer": a resource serves only what someone
   * deployed into it. Ids come back as MODEL ids where the listing names one,
   * because that is what `/model azure-openai/<id>` takes, with the deployment
   * shown as the label so a mismatch is visible rather than silent.
   */
  async listModels(): Promise<ModelInfo[]> {
    if (!this.transport.endpoint) throw new Error(NO_AZURE_ENDPOINT);
    if (!this.transport.apiKey && !this.transport.entraToken) {
      throw new Error(NO_AZURE_CREDENTIALS);
    }
    const url =
      `${this.transport.endpoint}/openai/deployments` +
      `?api-version=${encodeURIComponent(this.transport.apiVersion)}`;
    const res = await fetch(url, { headers: authHeaders(this.transport) });
    if (!res.ok) throw new Error(`Azure deployment listing failed (${res.status})`);
    const json = (await res.json()) as {
      data?: { id?: string; model?: string; status?: string }[];
    };
    return (json.data ?? [])
      .filter((d) => d.id && d.status !== "failed" && d.status !== "deleting")
      .map((d) => ({
        // Prefer the model id: it is what the picker, the pricing table and the
        // reasoning dial all key on. The deployment name rides in the label.
        id: d.model ?? d.id!,
        label: d.model && d.model !== d.id ? `${d.model} · deployment ${d.id}` : d.id!,
        live: true,
      }));
  }

  /** Health is "is this route configured", never a completion against the deployment. */
  async healthCheck(): Promise<boolean> {
    return !!this.transport.endpoint && (!!this.transport.apiKey || !!this.transport.entraToken);
  }
}

// ─── The transport ───

/** The credential header: a resource key, else an Entra bearer. */
function authHeaders(transport: AzureTransport): Record<string, string> {
  if (transport.apiKey) return { "api-key": transport.apiKey };
  if (transport.entraToken) return { authorization: `Bearer ${transport.entraToken}` };
  return {};
}

/**
 * Rewrite the OpenAI SDK's request onto the Azure deployment path.
 *
 * Exported for the fixture tests, which drive it with a recorded response and
 * never touch the network.
 */
export async function azureFetch(
  transport: AzureTransport,
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  const path = new URL(requestUrl).pathname;

  if (!transport.endpoint) return errorResponse(400, NO_AZURE_ENDPOINT);
  if (!transport.apiKey && !transport.entraToken) {
    // A synthetic 401 rather than a throw: the OpenAI SDK re-raises a thrown
    // transport error as a connection failure AFTER retrying, which would lose
    // the message that says what to set. A 401 response is not retried.
    return errorResponse(401, NO_AZURE_CREDENTIALS);
  }

  const raw = typeof init?.body === "string" ? init.body : "";
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
  const deployment = azureDeploymentFor(String(body?.model ?? ""), transport.deployments);
  if (body) body.model = deployment;

  const target = azureUrl(transport, path, deployment);
  const headers = {
    ...stripKeyHeaders(init?.headers as HeadersLike | undefined),
    ...authHeaders(transport),
    "content-type": "application/json",
  };

  return await fetch(target, {
    ...(init?.method ? { method: init.method } : { method: "POST" }),
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
}

/**
 * Map an OpenAI-shaped path onto Azure's.
 *
 * Only two paths matter here: chat completions (per deployment) and the model
 * listing (per resource). Anything else keeps its shape under `/openai` and
 * gains the api-version, which is the right default for an endpoint Azure
 * happens to expose that Rune does not model.
 */
export function azureUrl(
  transport: { endpoint: string; apiVersion: string },
  path: string,
  deployment: string,
): string {
  const version = `api-version=${encodeURIComponent(transport.apiVersion)}`;
  if (path.endsWith("/chat/completions")) {
    return (
      `${transport.endpoint}/openai/deployments/${encodeURIComponent(deployment)}` +
      `/chat/completions?${version}`
    );
  }
  if (path.endsWith("/models")) {
    return `${transport.endpoint}/openai/models?${version}`;
  }
  const suffix = path.replace(/^.*\/openai/, "") || path;
  return `${transport.endpoint}/openai${suffix}?${version}`;
}

/**
 * Drop the SDK's own credential header. The placeholder key handed to the
 * constructor becomes `Authorization: Bearer azure`; leaving it beside a real
 * `api-key` would send two credentials, one of them fake.
 */
function stripKeyHeaders(headers: HeadersLike | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const drop = new Set(["authorization", "api-key"]);
  if (!headers) return out;
  const entries: [string, string][] =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers as Record<string, string>);
  for (const [k, v] of entries) {
    if (!drop.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

type HeadersLike = Headers | [string, string][] | Record<string, string>;

/** An error shaped the way the OpenAI SDK reads it, so the message survives. */
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export type { AzureTransport };

/** Re-exported so the registry can name the provider id without a literal. */
export const AZURE_PROVIDER_ID: ProviderName = "azure-openai";
