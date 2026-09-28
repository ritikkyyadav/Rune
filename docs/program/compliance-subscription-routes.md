# Subscription sign-in routes: compliance record

Status as of 2026-09-28. This file records every route by which Rune spends a
person's consumer subscription, rather than an API account, and what was decided
about each one. Three routes are covered:

| Route                                                  | Where it lives                            | Decision                                                 |
| ------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------- |
| Claude Pro/Max sign-in (`anthropic`, `--method oauth`) | removed                                   | **Retired** 2026-09-28                                   |
| Google Code Assist sign-in ("Antigravity")             | branch `park/antigravity-20260928`        | **D1: parked, never released**                           |
| ChatGPT Plus/Pro sign-in (`codex`)                     | `packages/llm-gateway/src/oauth/codex.ts` | **D3: OPEN**, the founder needs to verify OpenAI's terms |

## 1. The Claude subscription sign-in is retired

### What the terms say

Anthropic's published terms, [Legal and compliance, "Authentication and
credential use"](https://code.claude.com/docs/en/legal-and-compliance):

> Anthropic does not permit third-party developers to offer Claude.ai login into
> their own applications, or to route requests through Free, Pro, or Max plan
> credentials on behalf of their users. Moreover, developers may not collect,
> store, or intermediate Claude.ai credentials or session tokens.

### What Rune did

Rune did every part of that.

- **It offered Claude.ai login.** `packages/llm-gateway/src/oauth/anthropic.ts`
  ran an authorization-code + PKCE flow against `claude.com/cai/oauth/authorize`
  using **Claude Code's OAuth client id**. A comment in that file said the id,
  the endpoints and the scopes had been read out of the installed Claude Code
  2.1.198 binary.
- **It stored and refreshed the session token.** The token was kept in Rune's
  credential store at `provider:anthropic:oauth` and refreshed there.
- **It sent requests through the plan as Claude Code.**
  `packages/llm-gateway/src/providers/anthropic.ts` sent the token as a bearer
  with the `anthropic-beta: oauth-2025-04-20` header. It also put Claude Code's
  identity line ("You are Claude Code, Anthropic's official CLI for Claude.")
  first in the system prompt, because the subscription backend accepts the token
  only when that line is present.

### What changed

- The `anthropic` preset offers `auth: ["api_key"]` only.
  `packages/llm-gateway/src/oauth/anthropic.ts` is deleted, and the OAuth
  registry has no strategy for `anthropic`. No `--method` or config override can
  select one.
- `AnthropicProvider` has no subscription mode. Its bearer auth, the oauth beta
  and the identity block are all gone. The only beta it still sends is
  interleaved-thinking, when budgeted thinking plus tools need it. Its SDK client
  now uses `maxRetries: 0`, so the SDK no longer retries underneath the gateway.
- `/login` no longer lists Claude on the Subscription route. Claude is on the API
  key route. `rune login anthropic --method oauth` is refused with the reason.
- **Existing users.** A token stored by an older Rune is left where it is and is
  never read for inference. `retiredOAuthNotices` (in
  `packages/llm-gateway/src/auth/oauth-registry.ts`) returns one line per retired
  route that still has a stored token, once per process. `rune login` prints that
  line. Rune never deletes the token automatically. `rune logout anthropic`
  removes it, along with any stored Anthropic API key, which is why the notice
  says to log out before adding a key.
- **Tripwire.** `tests/unit/compliance/no-subscription-impersonation.test.ts`
  reads every file under every `packages/**/src` directory, with no exclusions.
  It fails if any file contains Claude Code's identity line, `oauth-2025-04-20`,
  or Claude Code's OAuth client id (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`).

### What is still available

Claude models remain available through:

- an Anthropic console API key (`rune login anthropic`, or `ANTHROPIC_API_KEY`);
- `bedrock`, Claude on AWS, signed with the machine's AWS credential chain;
- `vertex`, Claude on Google Cloud, with Application Default Credentials.

### Not yet done

The notice appears at `rune login`, not at startup. Showing it at startup needs
one call after `resolveProviderCredentials` in
`packages/orchestrator/src/bin/rune-cli.ts`, which a different lane owns:

```ts
for (const line of await retiredOAuthNotices(store)) console.warn(`  ${brass("!")} ${dim(line)}`);
```

A few surfaces outside this lane still name "Claude Pro/Max" as a
subscription, and need the same treatment:

- `accountLoginLabel` in `packages/shared/src/providers.ts`;
- the hint in `packages/orchestrator/src/bin/rune-cli.ts`;
- the hint in `packages/orchestrator/src/bin/ui/tui-commands.ts`;
- the Subscription row in `docs/providers.md`.

## 2. D1: the Antigravity route is parked

The Antigravity route signed in with Google and called Code Assist, the
backend behind Google's own agent. Like the Claude route, it depended on a
client id that is not Rune's: the id was read out of the installed `agy` binary.
It was never released. On 2026-09-28 it was parked, unreleased, on branch
`park/antigravity-20260928` at commit `07ed729` ("park: Antigravity route
(Google Code Assist sign-in), not for release").

It should not be merged or released unless Google's terms are shown to permit a
third-party app to use that client and backend. If that happens, add the
decision and its source to this file.

## 3. D3 (OPEN): the Codex route

`rune login codex` signs in with a ChatGPT Plus/Pro account and spends that
plan. It uses the **Codex CLI's** OAuth client id, `app_EMoamEEZ73f0CkXaXp7hrann`
(`packages/llm-gateway/src/oauth/codex.ts:18`), so Rune authenticates as
OpenAI's own client, the same pattern that was retired for Claude.

**Founder action:** check OpenAI's current terms for third-party use of ChatGPT
sign-in and of the Codex client id, and record the answer and its source here.

- **If permitted:** record the source here and keep the route.
- **If not permitted:** retire it the same way as the Claude route. That means
  API-key-only on the preset, the flow deleted, a one-time notice for stored
  tokens, and a tripwire entry for the client id. There is a knock-on effect:
  the product-mode yardstick currently runs on this route. Without it, the
  yardstick needs funded OpenAI API credits, which the zero-budget plan does not
  have today.

Until D3 is decided, this route stays as it is, and the question stays open here.
