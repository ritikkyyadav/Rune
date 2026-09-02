# Program backlog

Out-of-phase defects found during execution. One line each: `file:line — what — found in phase — by`.

Seeded 2026-09-02 from the audits:

- `packages/tool-registry/src/tools/todo-write.ts:55` — `todo_write` has category `read`, so `task` sub-agents can call it into a throwaway store — 6B.4
- `packages/llm-gateway/src/providers/openai.ts:74-79` — comment says OpenRouter passes no name; `openrouter.ts:28-32` passes one — 8.6
- `packages/orchestrator/src/auto-mode.ts:199, 550` — `conversationalEscalation` resolved and reported, never read — 1.1
- `docs/auto-mode.md:275` — "ten scenarios"; there are 19 — 1.1
- `packages/tool-registry/src/mcp/client.ts:655` — MCP handlers return `validate: () => ({valid: true})` unconditionally — 4.4
- `packages/orchestrator/src/bin/engine-host.ts:321-335` — pending permission promises have no timeout and no rejection on disconnect — 2.2
- `packages/shared/src/session.ts:55` — `system_prompt_hash` never written (NULL for 601 sessions) — 7.1
- `tests/eval/tasks-from-incidents.ts:12-15` — flywheel input empty — 7.8
- `dist/` — stale partial artifacts from 2026-08-25 — 1.3
- `apps/desktop/src-tauri/src/lib.rs` — six `*_system_memory` commands never called — 3.1

Found while executing Phase 4 (lane C):

- `packages/orchestrator/src/engine.ts` — `reconcileMcpTools` unregisters only `mcp_`-prefixed tools, so the cross-server `read_resource` survives every connector going away; it answers "no connected service exposes resources", which is honest but leaves a schema advertised for nothing — 4.4
- `packages/orchestrator/src/engine.ts` — `mcpNotices` now carries plugin refusals and local-tool loads as well as connector lifecycle; the name has drifted from what it holds — rename to `extensionNotices` when Phase 2 touches the event surface — 4.5/4.6
- `packages/orchestrator/src/bin/gear-cli.ts` — `parseArgs` runs with `strict: false`, so any UNDECLARED long option with a value silently becomes a boolean flag plus a stray positional. P4.3 declared the five it needed; every future subcommand must remember to, or lose its arguments without an error — 4.3
- `packages/orchestrator/src/bin/ui/brand.ts:15` — `PRODUCT_VERSION` is a fifth hand-maintained copy of the version; `plugins.ts` deliberately reads `package.json` instead to avoid an engine→UI import. Consolidate in Phase 1 — 4.6
