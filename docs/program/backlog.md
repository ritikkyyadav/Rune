# Program backlog

Out-of-phase defects found during execution. One line each: `file:line — what — found in phase — by`.

Seeded 2026-09-02 from the audits:

- `packages/tool-registry/src/tools/todo-write.ts:55` — `todo_write` has category `read`, so `task` sub-agents can call it into a throwaway store — 6B.4
- `packages/llm-gateway/src/providers/openai.ts:74-79` — comment says OpenRouter passes no name; `openrouter.ts:28-32` passes one — 8.6
- `packages/tool-registry/src/mcp/client.ts:655` — MCP handlers return `validate: () => ({valid: true})` unconditionally — 4.4
- `packages/orchestrator/src/bin/engine-host.ts:321-335` — pending permission promises have no timeout and no rejection on disconnect — 2.2
- `packages/shared/src/session.ts:55` — `system_prompt_hash` never written (NULL for 601 sessions) — 7.1
- `tests/eval/tasks-from-incidents.ts:12-15` — flywheel input empty — 7.8
- `apps/desktop/src-tauri/src/lib.rs` — six `*_system_memory` commands never called — 3.1
- `packages/tool-registry/src/tools/freshness.ts` and the gear-tools read/edit path — PR #4's first Windows runtime smoke (packaged-e2e, windows-latest) fails at edit_file with "You must read smoke.txt (read_file) before editing it" immediately after a read_file of the same path: the read-before-edit ledger keys paths differently on Windows (separator or case). Real Windows defect, never observed before because nothing had executed the binary on Windows — 1.7

Added during execution:

- `tests/unit/**` (21 files) — POSIX-shell and POSIX-path assumptions block `bun test tests/unit/` on Windows: hardcoded `/bin/sh`, `/tmp/...`, `bash -c` and `uname` in the sandbox, permission, auto-containment and custom-loader suites. `ci.yml`'s ts-windows job typechecks only. The Windows smokes (P1.7) do not need these, so they were left alone — found in 1.7
- `.github/workflows/release.yml` — the install-smoke matrix downloads with `gh` rather than running `web-install.sh` / `install.ps1`, because a private repo 404s anonymous `curl`. Switch it to the real one-liners once D1 makes the repo (or a mirror) public — found in 1.4
- `packages/orchestrator/src/bin/ui/brand.ts` — `PRODUCT_VERSION`'s source-run fallback reads `packages/orchestrator/package.json` at runtime; five other `package.json` files still carry a semver nothing reads. Consider collapsing them, or add a CI check that they agree — found in 1.3

Found while executing Phase 4 (lane C):

- `packages/orchestrator/src/engine.ts` — `reconcileMcpTools` unregisters only `mcp_`-prefixed tools, so the cross-server `read_resource` survives every connector going away; it answers "no connected service exposes resources", which is honest but leaves a schema advertised for nothing — 4.4
- `packages/orchestrator/src/engine.ts` — `mcpNotices` now carries plugin refusals and local-tool loads as well as connector lifecycle; the name has drifted from what it holds — rename to `extensionNotices` when Phase 2 touches the event surface — 4.5/4.6
- `packages/orchestrator/src/bin/gear-cli.ts` — `parseArgs` runs with `strict: false`, so any UNDECLARED long option with a value silently becomes a boolean flag plus a stray positional. P4.3 declared the five it needed; every future subcommand must remember to, or lose its arguments without an error — 4.3
- `packages/orchestrator/src/bin/ui/brand.ts:15` — `PRODUCT_VERSION` is a fifth hand-maintained copy of the version; `plugins.ts` deliberately reads `package.json` instead to avoid an engine→UI import. Consolidate in Phase 1 — 4.6

Found during Phase 2 (lane B):

- `.gitignore:32-42` — a run writes `.gear/skills/playbook/SKILL.md` into the workspace and that path is NOT ignored, so every session dirties the tree it is working in; `.gear/cache/`, `logs/`, `worktrees/` are ignored but `skills/` is not — found in 2.8 while running the `--stream-json` gate — lane B
- `packages/orchestrator/src/bin/gear-cli.ts:112` — `--status` is declared `{type:"string"}` under `strict:false`, so a bare `--status` silently swallows the NEXT argument as its value (`gear serve --status --port 4999` parsed as `status:"--port"`). Worked around for `serve` by rewriting the flag to a positional before `parseArgs`; every other subcommand still has the hole — found in 2.4 — lane B
- `packages/orchestrator/src/engine.ts` — `Engine` holds one `currentAbort`/`liveLoop`, so `abort(sessionId)` cannot truly be per-session in one process. `gear serve` works around it with one host process per session (P2.3's supervisor). An in-process multiplexed Engine remains unbuilt and is the blocker for a single-process multi-session desktop — found in 2.3 — lane B
- `packages/shared/src/session.ts:44-107` — `tool_result` rows carry no `durationMs`, so a replayed tool call reports 0 and a client cannot tell "instant" from "unknown" — found in 2.5 — lane B

Found during Phase 3 (lane B):

- `apps/desktop/src-tauri/Cargo.toml` — the repo root's `exclude` for `apps/desktop/src-tauri` only works while the nearest ancestor manifest IS the repo root, so every cargo command from a git worktree checked out under the main checkout failed with "believes it's in a workspace when it's not". Fixed here with an empty `[workspace]` table in the package; the same trap applies to any future nested crate — found in 3.1 — lane B
- `packages/orchestrator/src/bin/login-cli.ts` — provider OAuth (Anthropic, Codex, OpenRouter) and the Copilot device flow are terminal-owned: they open a browser and catch a loopback redirect from the CLI process. The desktop settings panel prints `gear login <provider>` for those providers rather than offering a button that cannot work. Moving it in-app needs one host command (`start_provider_login` → returns the URL, completes the exchange, writes to the credential store) — found in 3.4 — lane B
- `packages/orchestrator/src/engine.ts` — `getTurnContext` records the last turn's assembly PER SESSION, not per turn, so the inspector shows the most recent assembly for the session rather than the one for the model span you clicked. Correct for a one-turn question and wrong for scrubbing back through a long session; a per-turn record needs a turn index on the capture — found in 3.4 — lane B
- `apps/desktop/src/lib/demo.ts` — the recorded demo turn predates the round-trip cards, the fleet panel and the auto chips, so "replay a recorded turn" shows a 2026-08 surface. Re-record it against the current reducers — found in 3.4 — lane B

Found while merging the lanes (merge captain):

- `tests/unit/brand-checklist.test.ts:26-33` — `builtCss()` skips when `apps/desktop/dist/assets` is absent but trusts it blindly when it is STALE, so the checklist audits whatever bytes happen to be on disk. A `dist/` built before the Savoir tokens existed (gitignored, so it survives every checkout and merge) fails all six rules on a tree that is correct; `bun run --cwd apps/desktop build` turns the same tree green. Either stamp the build with a token hash and skip on mismatch, or have `bun run test` depend on the desktop build — found while merging #9
