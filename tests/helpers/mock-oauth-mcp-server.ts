// ─── A local OAuth-protected MCP server ───
//
// There are no live Notion credentials on this machine and there never will be
// in CI, so the OAuth path is proved against a server that implements the same
// RFCs the real ones do:
//
//   RFC 9728  /.well-known/oauth-protected-resource
//   RFC 8414  /.well-known/oauth-authorization-server
//   RFC 7591  POST /register              (dynamic client registration)
//   RFC 7636  PKCE S256                   (verified, not just accepted)
//   RFC 8707  resource indicator          (echoed and audience-bound)
//
// It is deliberately strict: a wrong verifier, a reused code, a mismatched
// redirect_uri or a missing bearer are all rejected the way a real server
// rejects them. A flow that passes here is a flow that has actually done PKCE.

import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  used: boolean;
}

export interface MockOAuthMcpServer {
  /** Base origin, e.g. http://127.0.0.1:54321 */
  origin: string;
  /** The MCP endpoint the client connects to. */
  mcpUrl: string;
  /** Registered client ids, in registration order. */
  registrations: string[];
  /** Every access token this server has minted. */
  issuedAccessTokens: string[];
  /** Count of tools/call requests that arrived with a valid bearer. */
  authorizedCalls: number;
  /** Make every existing access token invalid (simulates revocation/expiry). */
  expireAccessTokens(): void;
  /** Refuse all refresh attempts from here on (simulates a revoked grant). */
  breakRefresh(): void;
  /** Seconds the next access token is valid for. Default 3600. */
  setAccessTokenLifetime(seconds: number): void;
  close(): Promise<void>;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The tools this mock exposes. Two is enough to prove discovery and a call. */
const TOOLS = [
  {
    name: "search",
    description: "Search the mock workspace for pages matching a query.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Text to search for." } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "delete_page",
    description: "Delete a page from the mock workspace.",
    inputSchema: {
      type: "object",
      properties: { page_id: { type: "string", description: "Page to delete." } },
      required: ["page_id"],
    },
    annotations: { destructiveHint: true },
  },
];

export async function startMockOAuthMcpServer(
  opts: { offerRegistration?: boolean; staticClientId?: string } = {},
): Promise<MockOAuthMcpServer> {
  const offerRegistration = opts.offerRegistration !== false;

  const clients = new Set<string>(opts.staticClientId ? [opts.staticClientId] : []);
  const registrations: string[] = [];
  const codes = new Map<string, PendingAuthorization>();
  const accessTokens = new Map<string, { refresh: string; valid: boolean }>();
  const refreshTokens = new Map<string, { clientId: string; resource?: string }>();
  const issuedAccessTokens: string[] = [];
  let refreshBroken = false;
  let lifetimeSec = 3600;
  let authorizedCalls = 0;
  let origin = "";

  const json = (
    res: Parameters<Parameters<typeof createServer>[0]>[1],
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(text);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      const path = url.pathname;

      // ── RFC 9728: protected-resource metadata ──
      if (path === "/.well-known/oauth-protected-resource/mcp" || path === "/.well-known/oauth-protected-resource") {
        json(res, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["read", "write"],
          bearer_methods_supported: ["header"],
        });
        return;
      }

      // ── RFC 8414: authorization-server metadata ──
      if (path === "/.well-known/oauth-authorization-server") {
        json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(offerRegistration ? { registration_endpoint: `${origin}/register` } : {}),
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          response_types_supported: ["code"],
          scopes_supported: ["read", "write"],
        });
        return;
      }

      // ── RFC 7591: dynamic client registration ──
      if (path === "/register" && req.method === "POST") {
        if (!offerRegistration) {
          json(res, 404, { error: "registration_not_supported" });
          return;
        }
        const clientId = `mock-client-${randomBytes(6).toString("hex")}`;
        clients.add(clientId);
        registrations.push(clientId);
        json(res, 201, {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: [],
          token_endpoint_auth_method: "none",
        });
        return;
      }

      // ── The authorization endpoint. A browser would land here; the test
      //    fetches it directly, and it redirects to the loopback exactly as a
      //    real consent screen does after the user approves. ──
      if (path === "/authorize") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const method = url.searchParams.get("code_challenge_method") ?? "";
        const state = url.searchParams.get("state") ?? "";
        if (!clients.has(clientId)) {
          json(res, 400, { error: "invalid_client" });
          return;
        }
        if (method !== "S256" || !challenge) {
          json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });
          return;
        }
        const code = base64url(randomBytes(24));
        codes.set(code, {
          clientId,
          redirectUri,
          codeChallenge: challenge,
          resource: url.searchParams.get("resource") ?? undefined,
          used: false,
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        if (state) back.searchParams.set("state", state);
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }

      // ── The token endpoint. PKCE is VERIFIED here, not merely accepted. ──
      if (path === "/token" && req.method === "POST") {
        const body = await new Promise<string>((resolve) => {
          let acc = "";
          req.on("data", (c) => (acc += c));
          req.on("end", () => resolve(acc));
        });
        const form = new URLSearchParams(body);
        const grant = form.get("grant_type");

        if (grant === "authorization_code") {
          const code = form.get("code") ?? "";
          const pending = codes.get(code);
          if (!pending || pending.used) {
            json(res, 400, { error: "invalid_grant", error_description: "unknown or reused code" });
            return;
          }
          if (form.get("client_id") !== pending.clientId) {
            json(res, 400, { error: "invalid_client" });
            return;
          }
          if (form.get("redirect_uri") !== pending.redirectUri) {
            json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
            return;
          }
          const verifier = form.get("code_verifier") ?? "";
          const computed = base64url(createHash("sha256").update(verifier).digest());
          if (!verifier || computed !== pending.codeChallenge) {
            json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
            return;
          }
          pending.used = true;

          const access = `at-${base64url(randomBytes(18))}`;
          const refresh = `rt-${base64url(randomBytes(18))}`;
          accessTokens.set(access, { refresh, valid: true });
          refreshTokens.set(refresh, {
            clientId: pending.clientId,
            resource: pending.resource,
          });
          issuedAccessTokens.push(access);
          json(res, 200, {
            access_token: access,
            refresh_token: refresh,
            token_type: "Bearer",
            expires_in: lifetimeSec,
            scope: "read write",
          });
          return;
        }

        if (grant === "refresh_token") {
          const rt = form.get("refresh_token") ?? "";
          const known = refreshTokens.get(rt);
          if (refreshBroken || !known) {
            json(res, 400, { error: "invalid_grant", error_description: "refresh token rejected" });
            return;
          }
          const access = `at-${base64url(randomBytes(18))}`;
          accessTokens.set(access, { refresh: rt, valid: true });
          issuedAccessTokens.push(access);
          json(res, 200, {
            access_token: access,
            token_type: "Bearer",
            expires_in: lifetimeSec,
            scope: "read write",
          });
          return;
        }

        json(res, 400, { error: "unsupported_grant_type" });
        return;
      }

      // ── The MCP endpoint, behind a bearer ──
      if (path === "/mcp") {
        if (req.method === "DELETE") {
          res.writeHead(204);
          res.end();
          return;
        }
        const auth = req.headers.authorization ?? "";
        const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
        const entry = accessTokens.get(token);
        if (!entry?.valid) {
          // The header that starts the whole dance.
          json(
            res,
            401,
            { error: "invalid_token" },
            {
              "www-authenticate":
                `Bearer realm="mock", error="invalid_token", ` +
                `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          );
          return;
        }

        const body = await new Promise<string>((resolve) => {
          let acc = "";
          req.on("data", (c) => (acc += c));
          req.on("end", () => resolve(acc));
        });
        let msg: { id?: number; method?: string; params?: Record<string, unknown> } = {};
        try {
          msg = JSON.parse(body);
        } catch {
          json(res, 400, { error: "bad_json" });
          return;
        }

        if (msg.id === undefined) {
          // A notification (initialized, cancelled, …).
          res.writeHead(202);
          res.end();
          return;
        }

        const reply = (result: unknown): void =>
          json(res, 200, { jsonrpc: "2.0", id: msg.id, result }, { "mcp-session-id": "mock-session" });

        switch (msg.method) {
          case "initialize":
            reply({
              protocolVersion: "2025-06-18",
              capabilities: { tools: {}, resources: {}, prompts: {} },
              serverInfo: { name: "mock-notion", version: "1.0.0" },
              instructions: "Mock connector. Search before you delete.",
            });
            return;
          case "tools/list":
            reply({ tools: TOOLS });
            return;
          case "tools/call": {
            authorizedCalls++;
            const name = (msg.params as { name?: string })?.name;
            const args = (msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {};
            reply({
              content: [
                { type: "text", text: `${name} ok: ${JSON.stringify(args)}` },
              ],
            });
            return;
          }
          case "ping":
            reply({});
            return;
          case "resources/list":
            reply({ resources: [{ uri: "mock://page/1", name: "Welcome", mimeType: "text/plain" }] });
            return;
          case "resources/read":
            reply({
              contents: [
                { uri: "mock://page/1", mimeType: "text/plain", text: "the welcome page body" },
              ],
            });
            return;
          case "prompts/list":
            reply({
              prompts: [
                {
                  name: "summarize",
                  description: "Summarize a page.",
                  arguments: [{ name: "page_id", description: "Page to summarize", required: true }],
                },
              ],
            });
            return;
          case "prompts/get":
            reply({
              description: "Summarize a page.",
              messages: [
                { role: "user", content: { type: "text", text: "Summarize the page." } },
              ],
            });
            return;
          default:
            json(res, 200, {
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32601, message: `Method not found: ${msg.method}` },
            });
            return;
        }
      }

      json(res, 404, { error: "not_found" });
    })().catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        // response already sent
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    registrations,
    issuedAccessTokens,
    get authorizedCalls() {
      return authorizedCalls;
    },
    expireAccessTokens() {
      for (const v of accessTokens.values()) v.valid = false;
    },
    breakRefresh() {
      refreshBroken = true;
    },
    setAccessTokenLifetime(seconds: number) {
      lifetimeSec = seconds;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
