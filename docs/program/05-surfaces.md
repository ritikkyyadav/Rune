# Phase 5 — Everywhere the work happens

**Lane B · 8–12 days · needs Phase 2**

## Goal

Gear runs where the work is: in the editor, in CI, on a remote box, from a script. Each surface is a thin client of `@gear/protocol`.

## Evidence (2026-09-02)

- No HTTP, WebSocket, JSON-RPC server or ACP anywhere in front of the engine (grep across `packages/`); the only servers are the telemetry collector and the OAuth loopback.
- `headless.ts` exists (`gear -P`), exit codes 0/1/3, JSON envelope; `--stream-json` arrives in P2.8.
- `gear detach --worktree` + `gear attach` already give background runs over a unix socket and a JSON registry (`bin/detach-cli.ts`).
- OpenCode ships `serve`, `web`, `attach <url>`, an ACP server for Zed, a GitHub agent and `pr <n>`; this axis is Gear's largest deficit on the bench (3.0 vs 9.0, weight 10).

## Work items

### P5.1 ACP server (3 days)

`gear acp`: an Agent Client Protocol server mapping protocol events to ACP session updates and ACP permission requests to the permission round-trip. Verify against Zed. Document the config snippet.

### P5.2 VS Code extension (3 days)

Thin: a webview hosting the `gear web` bundle against a local `gear serve` it starts on demand; status-bar item with gear and cost; "Send selection to Gear"; "Open trace for this file". Publish to the marketplace under Savoir. JetBrains deferred.

### P5.3 CI and GitHub (2 days)

- `gear -P --stream-json --gear 3 --workspace .` documented as the CI form; `GEAR_*` env for keys; exit code contract in `docs/ci.md`.
- `savoir/gear-action`: a composite action that installs the pinned release, runs a prompt (default: review the PR diff with the plan ledger and evidence gates), and posts one comment with the audit summary. Use it on this repo's PRs.
- `gear pr <n>`: checkout helper that creates a worktree for a PR and starts a session with the PR description as the brief.

### P5.4 SDK (1 day)

`@gear/sdk` from P2.9 published (per D1) with two examples: a script that runs a task and prints the audit; a bot that answers permissions from a policy.

### P5.5 Remote (1 day)

`gear serve --host` + `gear attach ws://host:port` + the web UI from a phone. Token in the URL fragment, never the query. Document the threat model in `docs/threat-model.md` (a served engine is remote code execution with the user's credentials attached; loopback and token are mandatory, LAN is opt-in).

## Gate

```bash
# Zed: agent server configured; a session runs a prompt, requests a permission, receives the answer, completes
code --install-extension savoir.gear && # webview loads, selection round-trips
gh workflow run gear-review.yml -f pr=<n>   # the action posts a comment with the audit summary on this repo
bun run examples/sdk/run-task.ts             # prints the audit
gear serve --host 0.0.0.0 --port 7788 && gear attach ws://<lan-ip>:7788 --token ...   # from another machine
```

Done means: the integration-surface axis moves from 3 to at least 7 on the existing bench, with each surface a client, not a fork.
