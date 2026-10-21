#!/usr/bin/env bun
// ─── One live request check, in a child process ───
//
// The corpus runner's `--request-check-live` hands each request-check call
// here: {system, user} on stdin, the model's answer text on stdout, nothing
// else. Rune's own boot path builds the gateway — the credential store, the
// provider credentials, `buildGateway` — exactly as `rune` does at start, in
// a process given the founder's sign-ins only through the credential paths in
// its environment (the parity rig's rule). No secret is printed or written.
//
// The route is fixed and named: Codex, `gpt-6-sol`, the founder's subscription.
import { openCredentialStore } from "../../../packages/shared/src/credential-store";
import {
  buildGateway,
  resolveProviderCredentials,
} from "../../../packages/orchestrator/src/provider-registry";

const PROVIDER = "codex";
const MODEL = process.env.RUNE_REQUEST_CHECK_MODEL ?? "gpt-6-sol";

const input = JSON.parse(await Bun.stdin.text()) as { system: string; user: string };
const store = await openCredentialStore();
const credentials = await resolveProviderCredentials({
  store,
  keys: {},
  active: PROVIDER,
  disabled: new Set(),
  localBaseUrls: {},
});
const gateway = buildGateway({ provider: PROVIDER, keys: {}, credentials });
const response = await gateway.infer({
  messages: [{ role: "user", content: [{ type: "text", text: input.user }] }],
  system: input.system,
  model: MODEL,
  provider: PROVIDER,
  maxTokens: 2_000,
  stream: false,
  role: "request_check",
});
process.stdout.write(
  response.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
);
