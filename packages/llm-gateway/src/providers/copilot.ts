// ─── GitHub Copilot transport (subscription) ───
// Copilot's chat endpoint is OpenAI-compatible, so we reuse the entire
// OpenAIProvider translation layer and only swap in Copilot's auth + endpoint.
//
// Auth has two tiers:
//   • the DURABLE credential is a GitHub OAuth token (from the device-code login),
//     which this class is constructed with; and
//   • a SHORT-LIVED Copilot API token minted from it at
//     GET api.github.com/copilot_internal/v2/token (valid ~25min).
// We mint/cache/refresh the short-lived token INTERNALLY (single-flight) and
// inject it — plus the editor headers the endpoint expects — via a custom `fetch`
// on every request. That keeps the gateway's built-once provider valid across
// long sessions without a rebuild, and presents as an approved Copilot client
// using the user's OWN subscription.

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
import { OpenAIProvider } from "./openai";

const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_BASE = "https://api.githubcopilot.com";
// Present as an approved Copilot client; the endpoint checks these. Overridable
// via env so a required version bump doesn't need a rebuild.
const EDITOR_VERSION = process.env.BERNE_COPILOT_EDITOR_VERSION ?? "vscode/1.95.0";
const PLUGIN_VERSION = process.env.BERNE_COPILOT_PLUGIN_VERSION ?? "copilot-chat/0.23.0";
const INTEGRATION_ID = "vscode-chat";
/** Refresh the short-lived Copilot token this far before it actually expires. */
const TOKEN_SKEW_MS = 120_000;

export class CopilotProvider implements LlmProvider {
  readonly name = "copilot" as const;
  private readonly inner: OpenAIProvider;
  private readonly ghToken: string;
  private token = "";
  private tokenExpMs = 0;
  private minting?: Promise<void>;

  constructor(ghToken: string) {
    this.ghToken = ghToken;
    // Inner OpenAI-compatible client pointed at Copilot. The dummy key is never
    // used — our custom fetch overrides Authorization with a fresh Copilot token
    // and adds the editor headers on every request.
    this.inner = new OpenAIProvider("copilot", COPILOT_BASE, "copilot", {
      fetch: this.copilotFetch,
    });
  }

  infer(request: InferenceRequest): Promise<InferenceResponse> {
    return this.inner.infer(request);
  }

  inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    return this.inner.inferStream(request, opts);
  }

  countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number> {
    return this.inner.countTokens(messages, tools);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureToken();
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  // ─── auth internals ───

  /** Custom fetch: ensure a valid Copilot token, then inject auth + editor headers. */
  private copilotFetch = async (
    url: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    await this.ensureToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("editor-version", EDITOR_VERSION);
    headers.set("editor-plugin-version", PLUGIN_VERSION);
    headers.set("copilot-integration-id", INTEGRATION_ID);
    headers.set("openai-intent", "conversation-panel");
    return fetch(url, { ...init, headers });
  };

  /** Mint the short-lived Copilot token when missing or near expiry (single-flight). */
  private async ensureToken(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpMs - TOKEN_SKEW_MS) return;
    if (!this.minting) {
      this.minting = this.mint().finally(() => {
        this.minting = undefined;
      });
    }
    await this.minting;
  }

  private async mint(): Promise<void> {
    const res = await fetch(TOKEN_URL, {
      headers: {
        authorization: `token ${this.ghToken}`,
        "user-agent": PLUGIN_VERSION,
        "editor-version": EDITOR_VERSION,
        "editor-plugin-version": PLUGIN_VERSION,
        accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `GitHub Copilot token request failed (${res.status}): ${body.slice(0, 200)}. ` +
          `Your GitHub account may not have an active Copilot subscription.`,
      );
    }
    const json = (await res.json().catch(() => ({}))) as { token?: string; expires_at?: number };
    if (!json.token) throw new Error("GitHub Copilot token response contained no token");
    this.token = json.token;
    // expires_at is epoch SECONDS; default to ~25min if the field is absent.
    this.tokenExpMs = json.expires_at ? json.expires_at * 1000 : Date.now() + 25 * 60_000;
  }
}
