# Third-party notices

Rune is a proprietary product. This file records every piece of externally sourced
code or design so the product stays legally clean. Rules (from
`docs/history/Rune-Prescription-Plan.md` §0.5):

- Any code ported from an OSS project gets an entry: source repo, commit, license,
  files affected.
- Apache-2.0 ports must preserve NOTICE content; MIT ports must preserve the
  copyright line.
- Format/protocol _compatibility_ implemented from public documentation or observed
  wire behavior (no source copied) is recorded for provenance but carries no license
  obligation.
- Closed-source products (Claude Code, Cursor) are studied from public docs/blogs
  only — never from decompiled sources.

## Ported code

_(none yet)_

## Format & design compatibility (no code copied)

| What                                                                                              | Origin                                                                                                      | Where in Rune                                     | Notes                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply_patch` patch-envelope format (`*** Begin Patch` / `*** Update File:` / `@@` context hunks) | OpenAI Codex CLI (format publicly documented; Apache-2.0 reference implementation exists in `openai/codex`) | `packages/tool-registry/src/tools/apply-patch.ts` | Parser written fresh for format interoperability with models RL-trained on this envelope. No source code from `openai/codex` was copied. Hunks are applied through Rune's own edit executor (hash-guarding, atomicity, syntax diagnostics). |
| Structured compaction state block (merge-not-resummarize design)                                  | Design approach observed in OpenAI Codex CLI's compaction template (`codex-rs/core`), reimplemented         | `packages/orchestrator/src/context-engine.ts`     | Section design (goals/decisions/files/commands/state/next) is generic; prompt text is original.                                                                                                                                             |

## Vendored dependencies

Runtime dependencies are declared in `package.json` / `Cargo.toml` and carry their own
licenses via the package registries. Vendored-in-tree assets:

| What                                                   | License               | Where                                                  |
| ------------------------------------------------------ | --------------------- | ------------------------------------------------------ |
| Chart.js (vendored for offline interactive dashboards) | MIT                   | `packages/tool-registry/src/tools/assets/chart-umd.ts` |
| Skills library (181 skills)                            | per-skill attribution | `skills/`                                              |

If you add a port, add the entry in the same change — not after.
