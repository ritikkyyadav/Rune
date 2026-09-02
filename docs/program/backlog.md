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
- `packages/tool-registry/src/tools/freshness.ts` and the gear-tools read/edit path — PR #4's first Windows runtime smoke (packaged-e2e, windows-latest) fails at edit_file with "You must read smoke.txt (read_file) before editing it" immediately after a read_file of the same path: the read-before-edit ledger keys paths differently on Windows (separator or case). Real Windows defect, never observed before because nothing had executed the binary on Windows — 1.7
