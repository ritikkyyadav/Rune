// ─── `gear evolve`: the self-evolution loop, read back ───
//
// Five surfaces, no Engine, no provider — everything reads the local record:
//   status     where the loop stands: what is learned, what is measured,
//              what is applied by itself and what still needs a person
//   scorecard  outcomes per model or per workspace from run retros (runs that
//              predate the retro are derived after the fact, marked so)
//   lessons    what Gear knows about THIS repository, and its playbook
//   tune       rule-based proposals from the scorecard — printed, never applied
//   gardener   harness defects the black box has evidence for, as a brief a
//              detached run on Gear's own repository can take (--run)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getGearHome, SessionManager } from "@gear/shared";
import type { SessionEvent } from "@gear/shared";
import { BlackboxStore } from "@gear/telemetry";
import { NotebookStore } from "../notebook/store";
import { repoKey as repoKeyOf } from "../notebook/fingerprint";
import { PLAYBOOK_REL, playbookEntries } from "../playbook";
import {
  deriveRunRetro,
  gardenerBrief,
  gardenerCandidates,
  scorecard,
  scoreRates,
  tuneProposals,
} from "../retro";
import type { RetroSample, RunRetro, ScoreRow } from "../retro";
import { accent, danger, dim, faint, info, ok, text, warn } from "./ui/theme";

type Row = { seq: number; event: SessionEvent };

const say = (s = ""): void => {
  process.stdout.write(s + "\n");
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * The CLI's own flags. gear-cli parses with strict:false, which turns an
 * unknown `--days 30` into a boolean plus a stray positional — so the
 * sub-command reads its flags from argv directly.
 */
function flags(argv: string[]): { opts: Record<string, string | true>; rest: string[] } {
  const opts: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && /^[\w./:-]+$/.test(next)) {
      opts[a.slice(2)] = next;
      i++;
    } else opts[a.slice(2)] = true;
  }
  return { opts, rest };
}

function num(v: string | true | undefined, fallback: number): number {
  if (typeof v !== "string") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ─── Reading retros: written by runs, or derived for sessions before the organ ───

function collectSamples(
  sm: SessionManager,
  opts: { days: number; limit: number },
): { samples: RetroSample[]; sessions: number; written: number; backfilled: number } {
  const since = new Date(Date.now() - opts.days * 86_400_000).toISOString();
  const sessions = sm
    .listSessions({ status: "all" })
    .filter((s) => s.updatedAt >= since && s.eventCount > 2)
    .slice(0, opts.limit);
  const samples: RetroSample[] = [];
  let written = 0;
  let backfilled = 0;
  for (const s of sessions) {
    let rows: Row[];
    try {
      rows = sm.getEvents(s.id, 1) as Row[];
    } catch {
      continue;
    }
    const retros = rows.filter((r) => r.event.type === "retro");
    if (retros.length > 0) {
      for (const r of retros) {
        const p = r.event.payload as { retro?: RunRetro; model?: string; provider?: string };
        if (!p.retro || p.retro.v !== 1) continue;
        samples.push({
          retro: p.retro,
          model: p.model ?? s.model,
          provider: p.provider ?? s.provider,
          workspaceRoot: s.workspaceRoot,
          sessionId: s.id,
        });
        written++;
      }
      continue;
    }
    const retro = deriveRunRetro(rows, { backfilled: true, now: s.updatedAt });
    if (!retro || (retro.completions === 0 && retro.tools.calls === 0)) continue;
    samples.push({
      retro,
      model: s.model,
      provider: s.provider,
      workspaceRoot: s.workspaceRoot,
      sessionId: s.id,
    });
    backfilled++;
  }
  return { samples, sessions: sessions.length, written, backfilled };
}

function shortKey(key: string, by: "model" | "workspace"): string {
  if (by === "workspace") {
    const parts = key.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || key;
  }
  return key;
}

function printScorecard(rows: ScoreRow[], by: "model" | "workspace"): void {
  if (rows.length === 0) {
    say(dim("  No runs in the window."));
    return;
  }
  const head =
    `  ${"".padEnd(34)}` +
    `${"runs".padStart(5)}` +
    `${"finished".padStart(10)}` +
    `${"open".padStart(6)}` +
    `${"stalled".padStart(9)}` +
    `${"unproven".padStart(10)}` +
    `${"checks".padStart(8)}` +
    `${"tool-fail".padStart(11)}` +
    `${"$/run".padStart(9)}`;
  say(dim(head));
  for (const r of rows) {
    const x = scoreRates(r);
    const finishedPaint = x.finishedRate >= 0.7 ? ok : x.finishedRate >= 0.4 ? warn : danger;
    const unprovenPaint = x.unprovenRate <= 0.1 ? ok : x.unprovenRate <= 0.3 ? warn : danger;
    const checks = x.checkPassRate === null ? dim("  —") : pct(x.checkPassRate).padStart(4);
    say(
      `  ${text(shortKey(r.key, by).slice(0, 33).padEnd(34))}` +
        `${String(r.runs).padStart(5)}` +
        `${finishedPaint(pct(x.finishedRate).padStart(10))}` +
        `${pct(x.openStepsRate).padStart(6)}` +
        `${(r.stalled > 0 ? warn : dim)(pct(x.stalledRate).padStart(9))}` +
        `${unprovenPaint(`${r.stepsUnproven}/${r.stepsDone}`.padStart(10))}` +
        `${checks.padStart(8)}` +
        `${pct(x.toolFailRate).padStart(11)}` +
        `${`$${x.usdPerRun.toFixed(3)}`.padStart(9)}`,
    );
  }
  say();
  say(
    dim(
      "  finished = ended with the plan done · open = ended with steps open · unproven = completed steps without evidence · $ = list price per run",
    ),
  );
}

// ─── Sub-commands ───

function cmdScorecard(sm: SessionManager, opts: Record<string, string | true>): number {
  const days = num(opts.days, 30);
  const limit = num(opts.limit, 300);
  const by: "model" | "workspace" = opts.by === "workspace" ? "workspace" : "model";
  const c = collectSamples(sm, { days, limit });
  say();
  say(
    `  ${accent("Scorecard")} ${dim("·")} by ${by} ${dim("·")} last ${days} days ${dim("·")} ${c.samples.length} runs from ${c.sessions} sessions${c.backfilled > 0 ? dim(` (${c.backfilled} derived after the fact)`) : ""}`,
  );
  say();
  printScorecard(scorecard(c.samples, by), by);
  say();
  return 0;
}

function cmdTune(sm: SessionManager, opts: Record<string, string | true>): number {
  const days = num(opts.days, 30);
  const c = collectSamples(sm, { days, limit: num(opts.limit, 300) });
  const rows = scorecard(c.samples, "model");
  const proposals = tuneProposals(rows, { minRuns: num(opts["min-runs"], 5) });
  say();
  say(
    `  ${accent("Tuning proposals")} ${dim("·")} from ${c.samples.length} runs over ${days} days ${dim("·")} ${dim("printed, never applied — the A/B that would justify applying one is not built")}`,
  );
  say();
  if (proposals.length === 0) {
    say(dim("  Nothing to propose: no model crosses a threshold with enough runs behind it."));
    say(
      dim(
        "  (thresholds: ≥5 runs; unproven ≥30% of ≥5 completed steps; stalled ≥20%; checks <50% of ≥10; open steps ≥40%)",
      ),
    );
    say();
    return 0;
  }
  for (const p of proposals) {
    say(
      `  ${text(p.key)} ${dim("·")} ${p.confidence === "medium" ? warn(p.confidence) : dim(p.confidence)}`,
    );
    say(`    ${dim("signal")}    ${p.signal}`);
    say(`    ${dim("proposal")}  ${p.proposal}`);
    say(`    ${dim("config")}    ${info(p.config)}`);
    say();
  }
  return 0;
}

function cmdLessons(workspaceRoot: string, opts: Record<string, string | true>): number {
  let store: NotebookStore;
  try {
    store = new NotebookStore(join(getGearHome(), "notebook.db"));
  } catch {
    say(dim("  Could not open ~/.gear/notebook.db"));
    return 1;
  }
  try {
    const key = repoKeyOf(workspaceRoot);
    const entries = store.listRepo(key).filter((e) => opts.all === true || !e.retired);
    const inPlaybook = new Set(playbookEntries(entries).map((e) => e.id));
    say();
    say(
      `  ${accent("Lessons")} ${dim("·")} ${dim(workspaceRoot)} ${dim("·")} ${entries.length} entr${entries.length === 1 ? "y" : "ies"} ${dim(`(repo key ${key})`)}`,
    );
    say();
    if (entries.length === 0) {
      say(
        dim(
          "  Nothing learned here yet. Gear writes a lesson when a run verifies a command, hits the same failure twice, or fixes a command by changing its arguments.",
        ),
      );
    }
    for (const e of entries) {
      const n = e.provenance.sessions.length;
      const kind = e.title.startsWith("avoid:")
        ? warn("pitfall")
        : e.title.startsWith("fix:") || e.title.startsWith("prefer:")
          ? ok("fix    ")
          : dim(e.kind.padEnd(7));
      const record = e.uses > 0 ? faint(` · used ${e.uses}× · ${pct(e.wins / e.uses)} wins`) : "";
      say(
        `  ${kind} ${text(e.body.slice(0, 96))}${e.retired ? warn("  retired") : ""}\n          ${faint(`${n} session${n === 1 ? "" : "s"}`)}${inPlaybook.has(e.id) ? faint(" · in playbook") : ""}${record} ${faint(`· ${e.id.slice(-8)}`)}`,
      );
    }
    const pb = join(workspaceRoot, PLAYBOOK_REL);
    say();
    if (existsSync(pb)) {
      const lines = readFileSync(pb, "utf8").split("\n").length;
      say(
        `  ${text("Playbook")}  ${info(PLAYBOOK_REL)} ${dim(`· ${lines} lines · a skill the model can load, a file you can edit`)}`,
      );
    } else {
      say(
        `  ${text("Playbook")}  ${dim(`not written yet — appears at ${PLAYBOOK_REL} once a lesson recurs across two sessions`)}`,
      );
    }
    say(dim("  manage: gear notebook show <id> · gear notebook rm <id>"));
    say();
    return 0;
  } finally {
    store.close();
  }
}

function isGearRepo(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
    return existsSync(join(dir, "packages", "orchestrator", "src", "engine.ts")) && !!pkg.name;
  } catch {
    return false;
  }
}

async function cmdGardener(
  workspaceRoot: string,
  opts: Record<string, string | true>,
): Promise<number> {
  let bb: BlackboxStore;
  try {
    bb = new BlackboxStore(join(getGearHome(), "blackbox.db"));
  } catch {
    say(dim("  Could not open ~/.gear/blackbox.db"));
    return 1;
  }
  try {
    const days = num(opts.days, 60);
    const candidates = gardenerCandidates(bb.top({ limit: 400, sinceDays: days }), {
      min: num(opts.min, 3),
      limit: num(opts.top, 5),
    });
    say();
    say(
      `  ${accent("Gardener")} ${dim("·")} harness defects with black-box evidence, last ${days} days ${dim("·")} ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`,
    );
    say();
    if (candidates.length === 0) {
      say(
        dim(
          "  No recurring crash-class fingerprint crosses the threshold. That is the good outcome.",
        ),
      );
      say();
      return 0;
    }
    candidates.forEach((c, i) => {
      say(
        `  ${dim(`${i + 1}.`)} ${warn(c.class)} ${dim("·")} ${text(c.component)} ${dim("·")} ${c.count}× ${dim(`· ${c.firstSeen.slice(0, 10)} → ${c.lastSeen.slice(0, 10)} · v${c.versions.join(", v")}`)}\n     ${faint(c.messageSample.replace(/\s+/g, " ").slice(0, 120))}`,
      );
    });
    const pick = candidates[Math.min(candidates.length, Math.max(1, num(opts.pick, 1))) - 1];
    const samples = bb
      .list({ class: pick.class, limit: 50 })
      .filter((r) => r.fingerprint === pick.fingerprint)
      .slice(0, 3)
      .map((r) => ({
        ts: r.ts,
        message: r.message,
        stack: r.stack,
        context: r.context as unknown as Record<string, unknown>,
      }));
    const brief = gardenerBrief(pick, samples);
    say();
    say(
      `  ${text("Brief")} ${dim(`for candidate ${candidates.indexOf(pick) + 1} (--pick n chooses another)`)}`,
    );
    say();
    for (const line of brief.split("\n")) say(`    ${line}`);
    say();
    if (opts.run !== true) {
      say(
        dim(
          `  dry run. \`gear evolve gardener --run\` starts a detached run on this brief in an isolated worktree of Gear's own repository — it commits on its branch and never pushes; you review the branch.`,
        ),
      );
      say();
      return 0;
    }
    if (!isGearRepo(workspaceRoot)) {
      say(
        `  ${danger("!")} --run needs Gear's own repository as the workspace (run it there, or pass -w <path>).`,
      );
      say();
      return 2;
    }
    const { runDetach } = await import("./detach-cli");
    await runDetach(["detach", brief], { worktree: true, workspace: workspaceRoot });
    return 0;
  } finally {
    bb.close();
  }
}

function cmdStatus(
  sm: SessionManager,
  workspaceRoot: string,
  opts: Record<string, string | true>,
): number {
  const days = num(opts.days, 30);
  const c = collectSamples(sm, { days, limit: num(opts.limit, 300) });
  const outcomes = new Map<string, number>();
  let lessons = 0;
  for (const s of c.samples) {
    outcomes.set(s.retro.outcome, (outcomes.get(s.retro.outcome) ?? 0) + 1);
    lessons += s.retro.lessons.length;
  }
  say();
  say(`  ${accent("Self-evolution")} ${dim("·")} ${dim(`last ${days} days`)}`);
  say();
  say(
    `  ${text("Measured")}  ${c.samples.length} runs ${dim("·")} ${[...outcomes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k === "finished" ? ok(k) : warn(k)} ${dim(String(n))}`)
      .join(
        dim(" · "),
      )}${c.backfilled > 0 ? dim(`  (${c.written} written by runs, ${c.backfilled} derived after the fact)`) : ""}`,
  );

  try {
    const nb = new NotebookStore(join(getGearHome(), "notebook.db"));
    try {
      const all = nb.list({ includeRetired: true, limit: 5000 });
      const active = all.filter((e) => !e.retired);
      const pitfalls = active.filter((e) => e.title.startsWith("avoid:")).length;
      const fixes = active.filter(
        (e) => e.title.startsWith("fix:") || e.title.startsWith("prefer:"),
      ).length;
      const here = nb.listRepo(repoKeyOf(workspaceRoot)).filter((e) => !e.retired);
      say(
        `  ${text("Learned")}   ${active.length} active entries ${dim("·")} ${pitfalls} pitfall${pitfalls === 1 ? "" : "s"} ${dim("·")} ${fixes} fix${fixes === 1 ? "" : "es"} ${dim("·")} ${all.length - active.length} retired ${dim("·")} ${lessons} lesson${lessons === 1 ? "" : "s"} from measured runs`,
      );
      const pb = existsSync(join(workspaceRoot, PLAYBOOK_REL));
      say(
        `  ${text("Here")}      ${here.length} entr${here.length === 1 ? "y" : "ies"} for this repository ${dim("·")} playbook ${pb ? ok(PLAYBOOK_REL) : dim("not yet written")}`,
      );
    } finally {
      nb.close();
    }
  } catch {
    say(`  ${text("Learned")}   ${dim("notebook unavailable")}`);
  }

  try {
    const bb = new BlackboxStore(join(getGearHome(), "blackbox.db"));
    try {
      const cands = gardenerCandidates(bb.top({ limit: 400, sinceDays: 60 }));
      say(
        `  ${text("Gardener")}  ${cands.length} harness defect${cands.length === 1 ? "" : "s"} with evidence ${dim("·")} ${cands.length > 0 ? `${warn(cands[0].class)} ${dim(`${cands[0].count}×`)}` : ok("none")} ${dim("· gear evolve gardener")}`,
      );
    } finally {
      bb.close();
    }
  } catch {
    // No black box, no gardener line.
  }

  const proposals = tuneProposals(scorecard(c.samples, "model"));
  say(
    `  ${text("Tuning")}    ${proposals.length} proposal${proposals.length === 1 ? "" : "s"} ${dim("· printed by gear evolve tune, never applied by themselves")}`,
  );
  say();
  say(
    dim(
      "  applied by itself: retro → notebook → playbook · proposals only: tune · a person on the merge: gardener",
    ),
  );
  say(dim("  gear evolve scorecard · lessons · tune · gardener"));
  say();
  return 0;
}

export async function runEvolve(args: string[], values: Record<string, unknown>): Promise<number> {
  const { opts, rest } = flags(Bun.argv.slice(2).filter((a) => a !== "evolve"));
  const sub = rest[0] ?? args[0] ?? "status";
  const workspaceRoot =
    (typeof values.workspace === "string" && values.workspace) ||
    (typeof opts.workspace === "string" && opts.workspace) ||
    process.cwd();

  if (sub === "lessons") return cmdLessons(workspaceRoot, opts);
  if (sub === "gardener") return cmdGardener(workspaceRoot, opts);

  const dbPath =
    (typeof values.db === "string" && values.db) ||
    process.env.GEAR_DB_PATH ||
    join(getGearHome(), "gear.db");
  let sm: SessionManager;
  try {
    sm = new SessionManager(dbPath);
  } catch (err) {
    say(`  ${danger("!")} could not open ${dbPath}: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  try {
    if (sub === "scorecard") return cmdScorecard(sm, opts);
    if (sub === "tune") return cmdTune(sm, opts);
    if (sub === "status") return cmdStatus(sm, workspaceRoot, opts);
    say(
      dim(
        "  Usage: gear evolve [status|scorecard|lessons|tune|gardener] [--days N] [--by model|workspace] [--run]",
      ),
    );
    return 2;
  } finally {
    sm.close();
  }
}
