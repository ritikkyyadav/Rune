# Rune sign-in completion — 2026-10-16

The founder requested a more polished completion page, Rune text instead of the gear, a clear
login-success message, and futuristic motion that responds to the pointer. The visual reference
was the airy particle background on Antigravity.

## Design

A white matte surface, large success typography, and an original particle ribbon rendered with
native Canvas. The field responds with depth, repulsion, and ripples as the pointer moves.
Animation can be paused, respects reduced-motion preferences, and stops in background tabs.
The screen loads no external fonts, images, libraries, or analytics.

## Completion means saved credentials

The previous loopback handler sent the success page before state validation, token exchange,
and credential storage. Provider and MCP sign-ins now hold that response until storage succeeds.
Failures return a generic failure response. The callback's code and state still follow the existing
PKCE and state-validation paths; duplicate callbacks cannot replace a pending response.

The page escapes provider text, permits only its bundled script by hash, and clears the callback
query from the address bar. The response is not cacheable.

## Preview and verification

```sh
bun scripts/preview-login-success.ts
```

Open `http://127.0.0.1:8767` for the production renderer or `/mobile` for a 390×844 frame.
The preview does not sign in to an account.

Focused tests cover provider and MCP sign-in, delayed storage, failure paths, injection, pointer
response, pausing, visibility, and reduced motion. The installed macOS CLI can also be tested
against a local mock IdP with an isolated profile:

```sh
bun scripts/verify-login-installed.ts ~/.rune/bin/rune /tmp/rune-login-delivery
```

The delivery probe captures the actual installed binary's HTTP page and checks that its mock
credential was saved. It does not use the user's keychain or a hosted provider.
