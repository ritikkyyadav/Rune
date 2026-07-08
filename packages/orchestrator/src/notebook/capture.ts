// ─── Rule-based capture: learning from tokens the user ALREADY paid for ───
// Every extractor here reads the run's tool observations (free — they exist
// regardless) and distills high-precision facts. No model calls, ever. The
// bar is precision over recall: a wrong "run tests with X" note actively
// hurts, a missed one costs nothing — fuzzier distillation belongs to the
// (governor-gated, cheapest-tier) reflection pass, not here.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NotebookStore } from "./store";

/** What the engine observed about one tool call during a run. */
export interface ToolObservation {
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  error?: string;
}

export interface CaptureContext {
  store: NotebookStore;
  repoKey: string;
  stackKey: string;
  sessionId: string;
  workspaceRoot: string;
}

/** Run all extractors over one finished run. Returns entry ids written. */
export function captureFromRun(ctx: CaptureContext, observations: ToolObservation[]): string[] {
  const written: string[] = [];
  try {
    written.push(...captureCommandFacts(ctx, observations));
    written.push(...captureFailoverTactics(ctx, observations));
    written.push(...captureMonorepoLayout(ctx));
  } catch {
    // capture must never affect the run — best-effort by construction
  }
  return written;
}

// ─── E1: verified command facts (test / build / typecheck / lint) ───
// "This repo tests with `bun test`" — captured only from a command that
// actually SUCCEEDED in this run. The single most re-derived fact in agent
// sessions, and the cheapest to remember.

const COMMAND_CATEGORIES: Array<[category: string, re: RegExp]> = [
  ["test-command", /\b(test|spec)\b/],
  ["build-command", /\bbuild\b/],
  ["typecheck-command", /\b(typecheck|tsc)\b/],
  ["lint-command", /\b(lint|clippy|fmt --check)\b/],
];

function bashCommand(o: ToolObservation): string | null {
  if (o.toolName !== "bash") return null;
  const c = o.args.command;
  if (typeof c !== "string") return null;
  const cmd = c.trim();
  // multi-line scripts and monsters are not "the test command"
  if (cmd.length === 0 || cmd.length > 120 || cmd.includes("\n")) return null;
  return cmd;
}

function categorize(cmd: string): string | null {
  // Only project-runner shapes qualify — `bun test`, `cargo build`, `npm run x`,
  // `make check`… An arbitrary `grep test file` must not become a "test command".
  if (!/^(bun|bunx|npm|npx|pnpm|yarn|cargo|go|make|python|pytest|mvn|gradle|turbo)\b/.test(cmd)) {
    return null;
  }
  for (const [category, re] of COMMAND_CATEGORIES) {
    if (re.test(cmd)) return category;
  }
  return null;
}

function captureCommandFacts(ctx: CaptureContext, observations: ToolObservation[]): string[] {
  const written: string[] = [];
  // last successful command per category wins (the one the run settled on)
  const winners = new Map<string, string>();
  for (const o of observations) {
    const cmd = bashCommand(o);
    if (!cmd || !o.success) continue;
    const category = categorize(cmd);
    if (category) winners.set(category, cmd);
  }
  for (const [category, cmd] of winners) {
    written.push(
      ctx.store.upsert({
        kind: "fact",
        scope: "repo",
        repoKey: ctx.repoKey,
        title: category,
        body: `${category.replace("-command", "")}: \`${cmd}\` (verified working here)`,
        sessionId: ctx.sessionId,
      }),
    );
  }
  return written;
}

// ─── E2: failover tactics — "use B here, not A" ───
// The user's exact scenario: the agent tries variants, fails, and figures the
// right one out on a later attempt. That hard-won pairing is the tactic worth
// keeping: a FAILED bash command followed by a SUCCEEDED one that shares most
// of its tokens but differs (e.g. `npm test` → `bun test`).

export function commandsAreVariants(failed: string, succeeded: string): boolean {
  if (failed === succeeded) return false;
  const a = failed.split(/\s+/);
  const b = succeeded.split(/\s+/);
  if (a.length === 0 || b.length === 0) return false;
  const shared = a.filter((t) => b.includes(t)).length;
  const overlap = shared / Math.max(a.length, b.length);
  // same intent, different invocation: high token overlap OR same trailing args
  // with a different runner (`npm test` vs `bun test` overlaps on "test")
  return (
    overlap >= 0.5 ||
    (a.length >= 2 && b.length >= 2 && a.slice(1).join(" ") === b.slice(1).join(" "))
  );
}

function captureFailoverTactics(ctx: CaptureContext, observations: ToolObservation[]): string[] {
  const written: string[] = [];
  const failures: string[] = [];
  const paired = new Set<string>();
  for (const o of observations) {
    const cmd = bashCommand(o);
    if (!cmd) continue;
    if (!o.success) {
      failures.push(cmd);
      continue;
    }
    // a success — did it resolve an earlier failed variant?
    const match = failures.find((f) => !paired.has(f) && commandsAreVariants(f, cmd));
    if (match) {
      paired.add(match);
      written.push(
        ctx.store.upsert({
          kind: "tactic",
          scope: "repo",
          repoKey: ctx.repoKey,
          title: `prefer:${cmd.split(/\s+/)[0]}:${match.split(/\s+/)[0]}`,
          body: `Use \`${cmd}\` here — \`${match}\` fails in this repo.`,
          sessionId: ctx.sessionId,
        }),
      );
    }
  }
  return written;
}

// ─── E3: monorepo layout fact (once per repo, from manifests) ───

function captureMonorepoLayout(ctx: CaptureContext): string[] {
  const parts: string[] = [];
  const pkgPath = join(ctx.workspaceRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (ws && ws.length > 0) parts.push(`JS workspaces: ${ws.join(", ")}`);
    } catch {
      // skip
    }
  }
  const cargoPath = join(ctx.workspaceRoot, "Cargo.toml");
  if (existsSync(cargoPath)) {
    try {
      const cargo = readFileSync(cargoPath, "utf-8");
      const m = cargo.match(/members\s*=\s*\[([^\]]*)\]/);
      if (m?.[1]) {
        const members = m[1]
          .split(",")
          .map((s) => s.trim().replace(/["']/g, ""))
          .filter(Boolean);
        if (members.length > 0) parts.push(`Cargo workspace: ${members.join(", ")}`);
      }
    } catch {
      // skip
    }
  }
  if (parts.length === 0) return [];
  return [
    ctx.store.upsert({
      kind: "fact",
      scope: "repo",
      repoKey: ctx.repoKey,
      title: "monorepo-layout",
      body: `Monorepo — ${parts.join(" · ")}`,
      sessionId: ctx.sessionId,
    }),
  ];
}
