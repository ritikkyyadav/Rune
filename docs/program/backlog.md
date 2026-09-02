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
