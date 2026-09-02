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

Found during Phase 2 (lane B):

- `.gitignore:32-42` — a run writes `.gear/skills/playbook/SKILL.md` into the workspace and that path is NOT ignored, so every session dirties the tree it is working in; `.gear/cache/`, `logs/`, `worktrees/` are ignored but `skills/` is not — found in 2.8 while running the `--stream-json` gate — lane B
- `packages/orchestrator/src/bin/gear-cli.ts:112` — `--status` is declared `{type:"string"}` under `strict:false`, so a bare `--status` silently swallows the NEXT argument as its value (`gear serve --status --port 4999` parsed as `status:"--port"`). Worked around for `serve` by rewriting the flag to a positional before `parseArgs`; every other subcommand still has the hole — found in 2.4 — lane B
- `packages/orchestrator/src/engine.ts` — `Engine` holds one `currentAbort`/`liveLoop`, so `abort(sessionId)` cannot truly be per-session in one process. `gear serve` works around it with one host process per session (P2.3's supervisor). An in-process multiplexed Engine remains unbuilt and is the blocker for a single-process multi-session desktop — found in 2.3 — lane B
- `packages/shared/src/session.ts:44-107` — `tool_result` rows carry no `durationMs`, so a replayed tool call reports 0 and a client cannot tell "instant" from "unknown" — found in 2.5 — lane B
