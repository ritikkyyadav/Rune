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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGearHome, SessionManager } from "@gear/shared";
import type { SessionEvent } from "@gear/shared";
import { BlackboxStore } from "@gear/telemetry";
import { NotebookStore } from "../notebook/store";
import { repoKey as repoKeyOf } from "../notebook/fingerprint";
import { PLAYBOOK_PENDING_REL, PLAYBOOK_REL, playbookEntries } from "../playbook";
import {
  GARDENER_OFF_LIMITS,
  deriveRunRetro,
  foldTurnRetros,
  gardenerBrief,
  gardenerCandidates,
  recordLessons,
  scorecard,
  scoreRates,
  tuneProposals,
} from "../retro";
import type { RetroSample, RunRetro, ScoreRow } from "../retro";
import { TaskStateStore } from "../task-state";
import { configHash } from "../evolve/config-hash";
import { consentPath, learnedSkillsEnabled, setLearnedSkills } from "../evolve/consent";
import { installGardenerGuard } from "../evolve/gardener-guard";
import { activeThreshold, lessonBaseline, stageCounts } from "../evolve/lessons";
import {
  activePromotions,
  appendLedger,
  haltState,
  ledgerPath,
  readLedger,
} from "../evolve/ledger";
import { promote, resume, revert } from "../evolve/promote";
import {
  VARIANT_IDS,
  isVariantId,
  variant as variantOf,
  variantConfig,
  variantConfigLines,
} from "../evolve/variants";
import { currentYardstick, findRepoRoot, readBlessed, writeBlessed } from "../evolve/yardstick";
import { doctrineHash } from "../prompts";
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

/**
 * The session's goal, from the spine. Turn retros omit it on purpose — the
 * goal is the session's, not the turn's — so the fold reads it back from the
 * log the turns were written beside.
 */
function sessionGoal(rows: Row[]): string | undefined {
  return TaskStateStore.fromEvents(rows)?.snapshot().goal || undefined;
}

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
    // The engine writes one retro per RUN. A session is N of them, and each
    // one is a turn — so pushing them as N samples made a greeting weigh as
    // much as a day's work and inflated every rate's denominator. One session
    // is one sample; the fold does the arithmetic.
    const retroRows = rows.filter((r) => r.event.type === "retro");
    if (retroRows.length > 0) {
      const turns: RunRetro[] = [];
      let model: string | undefined;
      let provider: string | undefined;
      let doctrineHash: string | null = null;
      let configHash: string | null = null;
      let arm: string | null = null;
      for (const r of retroRows) {
        const p = r.event.payload as {
          retro?: RunRetro;
          model?: string;
          provider?: string;
          doctrineHash?: string | null;
          configHash?: string | null;
          arm?: string | null;
        };
        if (!p.retro || p.retro.v !== 1) continue;
        turns.push(p.retro);
        // The model the session ran on last is the one it is scored as.
        if (p.model) model = p.model;
        if (p.provider) provider = p.provider;
        // Same rule for attribution: the configuration the session ENDED under
        // is the one it is attributed to. A /config change mid-session makes
        // the sample unattributable, and the A/B path drops those rather than
        // averaging two arms into one number.
        if (p.doctrineHash) doctrineHash = p.doctrineHash;
        if (p.configHash) configHash = p.configHash;
        if (p.arm) arm = p.arm;
      }
      const folded =
        turns.length === 1 && turns[0]!.scope === "session"
          ? turns[0]!
          : foldTurnRetros(turns, sessionGoal(rows));
      if (folded) {
        samples.push({
          retro: folded,
          model: model ?? s.model,
          provider: provider ?? s.provider,
          workspaceRoot: s.workspaceRoot,
          sessionId: s.id,
          doctrineHash: doctrineHash ?? s.systemPromptHash ?? null,
          configHash,
          arm,
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
    `  ${accent("Tuning proposals")} ${dim("·")} from ${c.samples.length} runs over ${days} days ${dim("·")} ${dim("never applied by themselves — each one that names a variant is measurable with gear evolve ab")}`,
  );
  say();
  if (proposals.length === 0) {
    say(dim("  Nothing to propose: no model crosses a threshold with enough runs behind it."));
    say(
      dim(
        "  (thresholds: ≥5 runs; unproven ≥30% of ≥5 completed steps; stalled ≥20%; checks <50% of ≥10; open steps ≥40%;",
      ),
    );
    say(dim("   aborted ≥25%; errored ≥20%; max_turns ≥3 and ≥10%; halted ≥2)"));
    say();
    return 0;
  }
  for (const p of proposals) {
    say(
      `  ${text(p.key)} ${dim("·")} ${p.confidence === "medium" ? warn(p.confidence) : dim(p.confidence)}`,
    );
    say(`    ${dim("signal")}    ${p.signal}`);
    say(`    ${dim("proposal")}  ${p.proposal}`);
    if (p.variant) {
      // A proposal that names a variant is one command from evidence. That is
      // the whole change: before, `config` was a TOML line to retype by hand,
      // which is why 128 measured runs produced no change at all.
      say(`    ${dim("measure")}   ${info(`gear evolve ab ${p.variant}`)} ${dim(`→ ${p.config}`)}`);
    } else {
      say(
        `    ${dim("config")}    ${info(p.config)} ${dim("· no variant: outside the allowlist")}`,
      );
    }
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
      const stage = e.retired
        ? warn("retired")
        : e.stage === "active"
          ? ok("active")
          : e.stage === "trial"
            ? info("trial")
            : dim("candidate");
      say(
        `  ${kind} ${text(e.body.slice(0, 96))}\n          ${stage} ${faint(`· ${n} session${n === 1 ? "" : "s"}`)}${inPlaybook.has(e.id) ? faint(" · in playbook") : ""}${record} ${faint(`· ${e.id.slice(-8)}`)}`,
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
      const draft = existsSync(join(workspaceRoot, PLAYBOOK_PENDING_REL));
      say(
        `  ${text("Playbook")}  ${
          draft
            ? `${warn(PLAYBOOK_PENDING_REL)} ${dim("· drafted and inert — gear evolve playbook --enable")}`
            : dim(
                `not written yet — appears once a lesson reaches ${"active"} and learned skills are enabled`,
              )
        }`,
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
    // The off-limits list was enforced as text in a prompt, which is a request,
    // not a boundary. Install the mechanical write-deny into the shared hooks
    // directory BEFORE the run starts, so the branch it produces cannot carry a
    // change to the doctrine, the permission broker, org policy or the secret
    // stores. A person still reviews the branch; this is what makes that review
    // about the fix rather than about what else the run touched.
    const guard = installGardenerGuard(workspaceRoot);
    say(
      guard.installed
        ? `  ${dim("guard")}     ${info(guard.path)} ${dim(`· refuses a commit touching ${GARDENER_OFF_LIMITS.length} off-limits paths`)}`
        : `  ${warn("!")} ${dim(`no write-deny installed: ${guard.reason}`)}`,
    );
    say();
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
  const outcomeLine = [...outcomes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k === "finished" ? ok(k) : warn(k)} ${dim(String(n))}`)
    .join(dim(" · "));
  say(
    `  ${text("Measured")}  ${c.samples.length} runs${outcomeLine ? ` ${dim("·")} ${outcomeLine}` : ""}${c.backfilled > 0 ? dim(`  (${c.written} written by runs, ${c.backfilled} derived after the fact)`) : ""}`,
  );

  try {
    const nb = new NotebookStore(join(getGearHome(), "notebook.db"));
    try {
      const all = nb.list({ includeRetired: true, limit: 5000 });
      const stages = stageCounts(all);
      const baseline = lessonBaseline(all);
      const here = nb.listRepo(repoKeyOf(workspaceRoot));
      const hereStages = stageCounts(here);
      // The ladder, not a headcount: "12 entries" said nothing about which of
      // them anything had been measured about.
      say(
        `  ${text("Lessons")}   ${dim("candidate")} ${stages.candidate} ${dim("→ trial")} ${stages.trial} ${dim("→")} ${ok(`active ${stages.active}`)} ${dim("·")} ${warn(`${stages.retired} retired`)} ${dim("·")} ${lessons} from measured runs`,
      );
      say(
        `  ${text("Bar")}       active needs ≥5 injections and a win rate ≥ ${pct(activeThreshold(baseline))} ${dim(baseline === null ? "(no ambient baseline yet; the floor applies)" : `(ambient ${pct(baseline)} + margin)`)}`,
      );
      const live = existsSync(join(workspaceRoot, PLAYBOOK_REL));
      const draft = existsSync(join(workspaceRoot, PLAYBOOK_PENDING_REL));
      say(
        `  ${text("Here")}      ${here.length} entr${here.length === 1 ? "y" : "ies"} ${dim(`(${hereStages.active} active)`)} ${dim("·")} playbook ${live ? ok(PLAYBOOK_REL) : draft ? warn(`${PLAYBOOK_PENDING_REL} — inert, gear evolve playbook --enable`) : dim("not yet written")}`,
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
    `  ${text("Tuning")}    ${proposals.length} proposal${proposals.length === 1 ? "" : "s"} ${dim("· printed by gear evolve tune, measurable with gear evolve ab")}`,
  );

  // ── The A/B ledger: the last measured lift, with its date ──
  const ledger = readLedger(gearHome(opts));
  const measurements = ledger.filter((e) => e.kind === "measurement");
  const last = measurements[measurements.length - 1];
  const standing = activePromotions(ledger);
  const halt = haltState(ledger);
  if (last) {
    const lift = `${(last.rateDelta ?? 0) >= 0 ? "+" : ""}${((last.rateDelta ?? 0) * 100).toFixed(1)}%`;
    say(
      `  ${text("Last A/B")}  ${last.subject} ${dim("·")} ${last.win ? ok(`WIN ${lift}`) : warn(`no change ${lift}`)} ${dim(`· ${last.mode} · ${last.compared ?? 0} tasks · ${last.at.slice(0, 10)}`)}`,
    );
  } else {
    say(
      `  ${text("Last A/B")}  ${dim("none run — gear evolve ab <variant>; bare `gear evolve ab` lists them")}`,
    );
  }
  say(
    `  ${text("Promoted")}  ${standing.length === 0 ? dim("nothing standing") : standing.map((p) => `${ok(p.subject)} ${dim(p.at.slice(0, 10))}`).join(dim(" · "))}${halt.halted ? ` ${danger("· LOOP HALTED")}` : ""}`,
  );
  say();
  say(
    dim(
      "  applied by itself: retro → notebook (candidates) · measured then promoted: variants, lessons, the playbook · a person on the merge: gardener",
    ),
  );
  say(dim("  gear evolve scorecard · lessons · tune · ab · promote · revert · why · playbook"));
  say();
  return 0;
}

// ─── ab · promote · revert · why · yardstick · resume (P7.5) ───
//
// The four commands that turn a measurement into a change and back again. They
// share one rule: everything they do lands in the ledger first, and the config
// block is rendered FROM the ledger rather than edited alongside it. One source
// of truth means a revert cannot leave the file and the history disagreeing.

function gearHome(opts: Record<string, string | true>): string {
  return typeof opts.home === "string" ? opts.home : getGearHome();
}

function printRefusals(refusals: string[]): void {
  for (const r of refusals) say(`  ${danger("refused")}  ${text(r)}`);
}

/**
 * `gear evolve ab <variant>` — run the paired A/B and record the result.
 *
 * The suite lives in the repository, not in the installed binary, so this
 * shells out to `bun run tests/eval/runner.ts --ab <id>` in a Gear checkout and
 * reads the report it writes. Outside a checkout it says so rather than
 * pretending: there is no eval suite to run, and inventing a number would be
 * the exact failure this phase exists to prevent.
 */
async function cmdAb(
  workspaceRoot: string,
  rest: string[],
  opts: Record<string, string | true>,
): Promise<number> {
  const id = rest[1];
  say();
  if (!id || !isVariantId(id)) {
    say(`  ${accent("Variants")} ${dim("· the closed set the loop may change")}`);
    say();
    for (const v of VARIANT_IDS) {
      say(`  ${text(v.padEnd(16))} ${dim(variantOf(v).summary)}`);
    }
    say();
    say(dim(`  Usage: gear evolve ab <variant>   ${id ? `("${id}" is not one of them)` : ""}`));
    say();
    return id ? 2 : 0;
  }

  const repoRoot = findRepoRoot(workspaceRoot) ?? findRepoRoot(process.cwd());
  if (!repoRoot) {
    say(
      `  ${danger("!")} no eval suite here. \`gear evolve ab\` runs tests/eval against two configurations,`,
    );
    say(`    so it needs a Gear checkout as the workspace (run it there, or pass -w <path>).`);
    say();
    return 2;
  }

  const v = variantOf(id);
  const mode = opts.real === true ? "real" : "mock";
  say(`  ${accent("A/B")} ${text(id)} ${dim("·")} ${dim(v.summary)} ${dim("·")} ${mode} mode`);
  say(`  ${faint(v.hypothesis)}`);
  say();

  const out = join(tmpdir(), `gear-ab-${id}-${Date.now()}.json`);
  const args = ["run", join(repoRoot, "tests", "eval", "runner.ts"), "--ab", id, "--ab-out", out];
  if (mode === "real") args.push("--real");
  const proc = Bun.spawn(["bun", ...args], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await proc.exited;
  if (code !== 0 || !existsSync(out)) {
    say(`  ${danger("!")} the A/B did not complete (exit ${code}); nothing recorded.`);
    say();
    return 1;
  }

  let payload: {
    comparison: {
      win: boolean;
      rateDelta: number;
      costDelta: number | null;
      compared: number;
      fixes: string[];
      regressions: string[];
      refusals: string[];
      mode: "mock" | "real";
      controlConfigHash?: string;
      treatmentConfigHash?: string;
    };
    yardstick?: string | null;
  };
  try {
    payload = JSON.parse(readFileSync(out, "utf8"));
  } catch (err) {
    say(
      `  ${danger("!")} could not read the A/B report: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }
  const c = payload.comparison;
  appendLedger(
    {
      v: 1,
      at: new Date().toISOString(),
      kind: "measurement",
      subject: id,
      controlConfigHash: c.controlConfigHash ?? configHash({}),
      treatmentConfigHash: c.treatmentConfigHash ?? configHash(variantConfig(id)),
      doctrineHash: doctrineHash(),
      yardstick: payload.yardstick ?? null,
      mode: c.mode,
      win: c.win,
      rateDelta: c.rateDelta,
      costDelta: c.costDelta,
      compared: c.compared,
      fixes: c.fixes,
      regressions: c.regressions,
      refusals: c.refusals,
    },
    gearHome(opts),
  );
  say(
    `  ${c.win ? ok("recorded: WIN") : warn("recorded: no change")} ${dim("· ledger")} ${info(ledgerPath(gearHome(opts)))}`,
  );
  if (c.win) say(`  ${dim("next")}      ${info(`gear evolve promote ${id}`)}`);
  say();
  return 0;
}

function cmdPromote(
  workspaceRoot: string,
  rest: string[],
  opts: Record<string, string | true>,
): number {
  const home = gearHome(opts);
  const id = rest[1];
  say();
  if (!id) {
    say(dim("  Usage: gear evolve promote <variant>"));
    say();
    return 2;
  }
  const { hash } = currentYardstick(findRepoRoot(workspaceRoot) ?? process.cwd());
  const blessed = readBlessed(home);
  const result = promote(id, {
    home,
    yardstick: hash,
    blessedYardstick: blessed?.hash ?? null,
  });
  if (!result.ok) {
    say(`  ${accent("Promote")} ${text(id)} ${dim("· not applied")}`);
    say();
    printRefusals(result.refusals);
    say();
    return 1;
  }
  say(`  ${ok("Promoted")} ${text(id)}`);
  say();
  for (const line of result.configLines ?? []) say(`    ${info(line)}`);
  say();
  say(`  ${dim("config")}   ${result.configPath}`);
  say(`  ${dim("ledger")}   ${ledgerPath(home)}`);
  say(`  ${dim("undo")}     ${info("gear evolve revert")}`);
  say();
  return 0;
}

function cmdRevert(rest: string[], opts: Record<string, string | true>): number {
  const home = gearHome(opts);
  const n = num(rest[1], 1);
  say();
  const result = revert(n, { home });
  if (!result.ok) {
    say(`  ${accent("Revert")} ${dim("· nothing done")}`);
    say();
    printRefusals(result.refusals);
    say();
    return 1;
  }
  say(`  ${ok("Reverted")} ${text(result.reverted.join(", "))}`);
  say(
    `  ${dim("config")}   ${result.configPath} ${dim("(block rewritten from what is left standing)")}`,
  );
  say(`  ${dim("ledger")}   ${ledgerPath(home)} ${dim("· the revert is a row, not a deletion")}`);
  if (result.halted) {
    say();
    say(`  ${danger("HALTED")}  ${text(result.haltReason ?? "two consecutive reverts")}`);
    say(`  ${dim("resume")}   ${info("gear evolve resume")}`);
  }
  say();
  return 0;
}

function cmdResume(opts: Record<string, string | true>): number {
  const home = gearHome(opts);
  say();
  if (!resume({ home })) {
    say(dim("  The loop is not halted; nothing to resume."));
    say();
    return 0;
  }
  say(
    `  ${ok("Resumed")} ${dim("· promotions are allowed again, and the halt stays in the ledger")}`,
  );
  say();
  return 0;
}

function cmdYardstick(workspaceRoot: string, opts: Record<string, string | true>): number {
  const home = gearHome(opts);
  const { repoRoot, hash } = currentYardstick(findRepoRoot(workspaceRoot) ?? process.cwd());
  const blessed = readBlessed(home);
  say();
  say(`  ${accent("Yardstick")} ${dim("· the eval suite promotions are measured against")}`);
  say();
  if (!hash) {
    say(dim("  No tests/eval here — run this from a Gear checkout."));
    say();
    return 2;
  }
  say(`  ${text("current")}  ${hash} ${dim(`· ${repoRoot}/tests/eval`)}`);
  say(
    `  ${text("blessed")}  ${blessed ? `${blessed.hash} ${dim(`· ${blessed.at.slice(0, 10)}`)}` : dim("never")}`,
  );
  if (opts.bless === true) {
    const entry = writeBlessed(hash, repoRoot, home);
    say();
    say(`  ${ok("Blessed")} ${entry.hash} ${dim("· promotions may now be measured against it")}`);
    say();
    return 0;
  }
  say();
  if (!blessed) {
    say(dim("  Never blessed: promotions are refused until a human anchors it."));
  } else if (blessed.hash !== hash) {
    say(warn("  The suite has moved since it was blessed — promotions are refused."));
    say(
      dim(
        "  A loop that edits the eval suite and then promotes on the result grades its own exam.",
      ),
    );
  } else {
    say(ok("  Unchanged since it was blessed."));
  }
  say(dim("  bless it: gear evolve yardstick --bless"));
  say();
  return 0;
}

/**
 * `gear evolve why <variant|lesson>` — the lineage.
 *
 * The question a promotion has to be able to answer is "why does it believe
 * this", and the answer is not a confidence score: it is the hypothesis someone
 * wrote down, the measurements that were run, what each one decided, and what
 * happened afterwards. All of it comes off the ledger, so a belief that turned
 * out wrong stays readable.
 */
function cmdWhy(
  workspaceRoot: string,
  rest: string[],
  opts: Record<string, string | true>,
): number {
  const home = gearHome(opts);
  const subject = rest[1];
  say();
  if (!subject) {
    say(dim("  Usage: gear evolve why <variant|lesson-id>"));
    say();
    return 2;
  }
  const entries = readLedger(home).filter((e) => e.subject === subject);

  if (isVariantId(subject)) {
    const v = variantOf(subject);
    say(`  ${accent("Why")} ${text(subject)}`);
    say();
    say(`  ${dim("changes")}    ${v.summary}`);
    say(`  ${dim("config")}     ${info(variantConfigLines(subject).join(" · "))}`);
    say(`  ${dim("hypothesis")} ${text(v.hypothesis)}`);
    say();
  } else {
    // Not a variant: try the notebook, where lessons live.
    const printed = whyLesson(workspaceRoot, subject);
    if (!printed && entries.length === 0) {
      say(`  ${danger("!")} nothing known about "${subject}".`);
      say(dim(`     variants: ${VARIANT_IDS.join(", ")}`));
      say(dim("     lessons:  gear evolve lessons"));
      say();
      return 2;
    }
  }

  if (entries.length === 0) {
    say(dim("  No ledger history: never measured, never promoted."));
    say();
    return 0;
  }
  say(`  ${text("History")} ${dim(`· ${entries.length} row${entries.length === 1 ? "" : "s"}`)}`);
  say();
  for (const e of entries) {
    const when = dim(e.at.slice(0, 16).replace("T", " "));
    if (e.kind === "measurement") {
      const verdict = e.win ? ok("WIN     ") : warn("no change");
      const cost =
        e.costDelta === null || e.costDelta === undefined
          ? "no data"
          : `${((e.costDelta ?? 0) * 100).toFixed(1)}%`;
      say(
        `  ${when}  ${verdict} ${dim(`${e.mode} · ${e.compared} tasks · pass ${((e.rateDelta ?? 0) * 100).toFixed(1)}% · cost ${cost}`)}`,
      );
      for (const r of e.refusals ?? []) say(`                      ${faint(`· ${r}`)}`);
    } else if (e.kind === "promotion") {
      say(`  ${when}  ${ok("PROMOTED")} ${dim((e.configLines ?? []).join(" · "))}`);
    } else if (e.kind === "revert") {
      say(`  ${when}  ${warn("REVERTED")} ${dim(e.note ?? "")}`);
    } else {
      say(`  ${when}  ${danger("HALT")}     ${dim(e.note ?? "")}`);
    }
  }
  say();
  return 0;
}

/** Lineage for a notebook lesson. Returns false when the id matches nothing. */
function whyLesson(workspaceRoot: string, shortId: string): boolean {
  let store: NotebookStore;
  try {
    store = new NotebookStore(join(getGearHome(), "notebook.db"));
  } catch {
    return false;
  }
  try {
    const entry = store.getByPrefix(shortId);
    if (!entry) return false;
    say(`  ${accent("Why")} ${text(entry.title)} ${dim(`· ${entry.id.slice(-8)}`)}`);
    say();
    say(`  ${dim("says")}       ${text(entry.body)}`);
    say(`  ${dim("scope")}      ${entry.scope}${entry.repoKey ? dim(` · ${entry.repoKey}`) : ""}`);
    say(
      `  ${dim("born")}       ${entry.createdAt.slice(0, 10)}${entry.provenance.note ? dim(` · from \`${entry.provenance.note}\``) : ""}`,
    );
    say(
      `  ${dim("fired in")}   ${entry.provenance.sessions.length} session${entry.provenance.sessions.length === 1 ? "" : "s"}${
        entry.provenance.sessions.length
          ? dim(
              ` · ${entry.provenance.sessions
                .slice(-3)
                .map((s) => s.slice(-8))
                .join(", ")}`,
            )
          : ""
      }`,
    );
    say(
      `  ${dim("win curve")}  ${entry.uses === 0 ? dim("never injected") : `${entry.wins}/${entry.uses} (${pct(entry.wins / entry.uses)})`}`,
    );
    say(
      `  ${dim("stage")}      ${entry.retired ? warn("retired") : entry.stage === "active" ? ok("active") : entry.stage === "trial" ? info("trial") : dim("candidate — stored, never injected")}${entry.lastUsed ? dim(` · last used ${entry.lastUsed.slice(0, 10)}`) : ""}`,
    );
    say();
    return true;
  } finally {
    store.close();
  }
}

/**
 * `gear evolve backfill` — read history back into the notebook, as candidates.
 *
 * `recordLessons` had exactly one call site (the engine's per-run retro) and the
 * backfill never called it, which is why `gear evolve` could derive 128 retros
 * carrying lessons and the notebook still held zero pitfalls: the organ read
 * history and wrote nothing back.
 *
 * Everything it writes is a CANDIDATE, and candidates are never injected.
 * Reconstructing a lesson from a log is not the same as having watched it hold,
 * and a backfill that wrote believable lessons would put hundreds of unmeasured
 * claims into the prompt in one go. A candidate becomes a trial the ordinary
 * way: by being learned again, in a second session, from a real run.
 *
 * Dry by default. `--write` applies.
 */
function cmdBackfill(
  sm: SessionManager,
  workspaceRoot: string,
  opts: Record<string, string | true>,
): number {
  const days = num(opts.days, 90);
  const limit = num(opts.limit, 500);
  const apply = opts.write === true;
  const c = collectSamples(sm, { days, limit });

  const byRepo = new Map<string, { lessons: number; sessions: number }>();
  for (const s of c.samples) {
    if (s.retro.lessons.length === 0) continue;
    const key = repoKeyOf(s.workspaceRoot);
    const row = byRepo.get(key) ?? { lessons: 0, sessions: 0 };
    row.lessons += s.retro.lessons.length;
    row.sessions++;
    byRepo.set(key, row);
  }
  const totalLessons = [...byRepo.values()].reduce((n, r) => n + r.lessons, 0);

  say();
  say(
    `  ${accent("Backfill")} ${dim("·")} ${c.samples.length} runs over ${days} days ${dim("·")} ${totalLessons} lesson${totalLessons === 1 ? "" : "s"} across ${byRepo.size} repositor${byRepo.size === 1 ? "y" : "ies"}`,
  );
  say();
  if (totalLessons === 0) {
    say(dim("  Nothing to write back: no derived retro carries a lesson."));
    say();
    return 0;
  }
  if (!apply) {
    say(
      dim(
        "  Dry run. Every row would be written as a CANDIDATE — stored, never injected — because a",
      ),
    );
    say(
      dim("  lesson reconstructed from a log has not been watched to hold. Pass --write to apply."),
    );
    say();
    return 0;
  }

  let store: NotebookStore;
  try {
    store = new NotebookStore(join(getGearHome(), "notebook.db"));
  } catch {
    say(dim("  Could not open notebook.db"));
    return 1;
  }
  try {
    let written = 0;
    let retired = 0;
    for (const s of c.samples) {
      if (s.retro.lessons.length === 0) continue;
      const r = recordLessons(
        store,
        { repoKey: repoKeyOf(s.workspaceRoot), sessionId: s.sessionId },
        s.retro.lessons,
        [],
        "candidate",
      );
      written += r.written.length;
      retired += r.retired.length;
    }
    say(
      `  ${ok("Wrote")} ${written} candidate${written === 1 ? "" : "s"}${retired > 0 ? dim(` · ${retired} contradicted entr${retired === 1 ? "y" : "ies"} retired`) : ""}`,
    );
    say(
      dim(
        "  None of them is injected yet. A candidate becomes a trial by being learned again, in a second session, from a real run.",
      ),
    );
    say(dim(`  see: gear evolve lessons --all   ·   workspace ${workspaceRoot}`));
    say();
    return 0;
  } finally {
    store.close();
  }
}

/**
 * `gear evolve playbook [--enable|--disable]` — the consent gate for learned
 * skills.
 *
 * The playbook is a file the skills loader reads and the model can follow, so
 * turning it on is a capability change. It is off until a person says
 * otherwise, once, here. Nothing else in the codebase writes this file.
 */
function cmdPlaybook(workspaceRoot: string, opts: Record<string, string | true>): number {
  const home = gearHome(opts);
  say();
  if (opts.enable === true || opts.disable === true) {
    const on = opts.enable === true;
    setLearnedSkills(on, home);
    say(
      `  ${on ? ok("Learned skills ENABLED") : warn("Learned skills disabled")} ${dim(`· recorded at ${consentPath(home)}`)}`,
    );
    say();
    if (on) {
      say(
        dim(
          `  The next run that has an active lesson writes ${PLAYBOOK_REL} and the loader lists it to the model.`,
        ),
      );
      say(
        dim(
          "  Undo with `gear evolve playbook --disable`; the file stays for you to read or delete.",
        ),
      );
    } else {
      say(
        dim(
          `  New blocks go to ${PLAYBOOK_PENDING_REL} again. An existing ${PLAYBOOK_REL} is left alone — it is your file now, delete it if you want it gone.`,
        ),
      );
    }
    say();
    return 0;
  }

  const enabled = learnedSkillsEnabled(home);
  const live = join(workspaceRoot, PLAYBOOK_REL);
  const pending = join(workspaceRoot, PLAYBOOK_PENDING_REL);
  say(`  ${accent("Playbook")} ${dim("· the repository's active lessons, as a skill")}`);
  say();
  say(
    `  ${text("learned skills")}  ${enabled ? ok("enabled") : warn("not enabled")} ${dim(enabled ? "· the loader lists the playbook to the model" : "· nothing generated is loaded")}`,
  );
  say(`  ${text("live file")}      ${existsSync(live) ? info(PLAYBOOK_REL) : dim("none")}`);
  say(
    `  ${text("draft")}          ${existsSync(pending) ? info(PLAYBOOK_PENDING_REL) : dim("none")} ${dim("· readable, never loaded")}`,
  );
  say();
  say(
    dim(
      "  Only ACTIVE lessons reach it: ≥5 injections with a win rate above the ambient baseline.",
    ),
  );
  say(dim(`  enable: gear evolve playbook --enable`));
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
  if (sub === "ab") return cmdAb(workspaceRoot, rest, opts);
  if (sub === "promote") return cmdPromote(workspaceRoot, rest, opts);
  if (sub === "revert") return cmdRevert(rest, opts);
  if (sub === "resume") return cmdResume(opts);
  if (sub === "yardstick") return cmdYardstick(workspaceRoot, opts);
  if (sub === "playbook") return cmdPlaybook(workspaceRoot, opts);
  if (sub === "why") return cmdWhy(workspaceRoot, rest, opts);

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
    if (sub === "backfill") return cmdBackfill(sm, workspaceRoot, opts);
    say(
      dim(
        "  Usage: gear evolve [status|scorecard|lessons|tune|ab|promote|revert|why|yardstick|playbook|backfill|resume|gardener]",
      ),
    );
    say(
      dim(
        "         [--days N] [--by model|workspace] [--real] [--bless] [--enable] [--write] [--run]",
      ),
    );
    return 2;
  } finally {
    sm.close();
  }
}
