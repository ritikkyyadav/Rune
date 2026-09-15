// ─── `rune doctor` + `rune incidents`: the black box's terminal surfaces ───
// Both open ~/.rune/blackbox.db directly (read-only usage) — no Engine boot, no
// provider validation, instant. Deliberately plain output: this is the page an
// annoyed user reads right after something broke.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  getRuneHome,
  loadSavedBrowserState,
  pruneCheckpoints,
  reportCheckpoints,
  resolveInitialBrowser,
} from "@rune/shared";
import type { IncidentRecord } from "@rune/shared";
import { BlackboxStore } from "@rune/telemetry";
import { mergedServers, preflightServer } from "@rune/tool-registry";
import { accent, danger, dim, faint, info, ok, text, warn } from "./ui/theme";
import { formatAutoSafetyMetrics, readAutoSafetyMetrics } from "../auto-metrics";
import { providerRouteLines, readProviderRouteReport } from "../provider-health-report";
import { glyph } from "./ui/glyphs";
import { probeBrowserRuntime } from "../visual-verification";

const HOME = () => getRuneHome();
const DB = () => join(HOME(), "blackbox.db");
const SENTINEL = () => join(HOME(), "blackbox.sentinel.json");
const LAST_RESORT = () => join(HOME(), "blackbox.last-resort.log");

function openStore(): BlackboxStore | null {
  try {
    return new BlackboxStore(DB());
  } catch {
    return null;
  }
}

function shortTs(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

/**
 * A wall-clock stamp, in the reader's own timezone.
 *
 * The build line used to go through shortTs(new Date(...).toISOString()), which
 * renders UTC. Everything the reader would check it against -- the file's mtime,
 * the clock in the corner of their screen, their memory of running the installer
 * -- is local, so a binary compiled at 15:03 reported itself as built at 09:33
 * and read as five and a half hours stale. The one line whose whole job is to
 * make the build trustworthy was the line quietly changing timezone.
 *
 * The incident timestamps above keep shortTs: those are ISO strings stored in
 * the database, compared against each other, and are not claims about now.
 */
function localTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function sevPaint(severity: string, s: string): string {
  if (severity === "critical") return danger(s);
  if (severity === "error") return danger(s);
  if (severity === "warn") return warn(s);
  return dim(s);
}

// ─── doctor ───

export function runDoctor(): void {
  console.log(`\n  ${dim("§ RUNE DOCTOR")}\n`);

  // Auto mode's own false-positive record, read from the session log.
  //
  // This sits at the top rather than the bottom because it is the one number on
  // this page that describes the harness getting in the user's way rather than
  // the harness breaking. A rising rate here is not an incident and will never
  // appear in the black box, which is exactly why it went unmeasured.
  {
    const sessionDb = join(HOME(), "rune.db");
    if (existsSync(sessionDb)) {
      const metrics = readAutoSafetyMetrics(sessionDb);
      console.log(`  ${dim("auto mode:")}`);
      for (const line of formatAutoSafetyMetrics(metrics)) console.log(`    ${dim(line)}`);
      console.log();
    }
  }

  // Recorder store health
  const store = openStore();
  if (!store) {
    console.log(`  ${danger(glyph("failure"))} black box: cannot open ${DB()}`);
  } else {
    const size = existsSync(DB()) ? statSync(DB()).size : 0;
    console.log(`  ${ok("✓")} black box: ${info(DB())} ${dim(`(${(size / 1024).toFixed(0)} KB)`)}`);
    const counts = store.counts({ sinceDays: 7 });
    const parts = (["critical", "error", "warn", "debug"] as const)
      .filter((s) => counts[s])
      .map((s) => sevPaint(s, `${counts[s]} ${s}`));
    console.log(
      `    ${dim("last 7 days:")} ${parts.length > 0 ? parts.join(dim(" · ")) : ok("no incidents")}`,
    );
    const pending = store.list({ outcome: "pending", limit: 500 }).length;
    if (pending > 0) console.log(`    ${dim("pending outcomes:")} ${pending}`);

    const top = store.top({ limit: 5, sinceDays: 7 });
    if (top.length > 0) {
      console.log(`\n  ${dim("top recurring (7d):")}`);
      for (const f of top) {
        console.log(
          `    ${warn(String(f.count).padStart(3))}× ${text(f.class)} ${dim("·")} ${faint(
            f.messageSample.slice(0, 70),
          )}`,
        );
      }
    }
  }

  // Crash sentinels: pid-scoped markers, present while a session is live OR
  // after a hard kill. Live pids = running instances; dead pids = crashes the
  // next startup will file as dirty-exit incidents. The legacy single-file
  // path is reported too until every install has cycled past it.
  {
    const paths: string[] = [];
    const dir = join(HOME(), "sentinels");
    if (existsSync(dir)) {
      try {
        for (const name of readdirSync(dir)) {
          if (/^sentinel-\d+\.json$/.test(name)) paths.push(join(dir, name));
        }
      } catch {
        console.log(`  ${warn("!")} sentinels: unreadable (${dir})`);
      }
    }
    if (existsSync(SENTINEL())) paths.push(SENTINEL());
    let live = 0;
    let stale = 0;
    for (const p of paths) {
      try {
        const meta = JSON.parse(readFileSync(p, "utf-8")) as { pid?: number };
        if (meta.pid !== undefined && processAlive(meta.pid)) live++;
        else stale++;
      } catch {
        stale++;
      }
    }
    if (paths.length === 0) {
      console.log(`  ${ok("✓")} sentinels: clean (no session running, last exit was clean)`);
    } else {
      if (live > 0)
        console.log(`  ${ok("✓")} sentinels: ${live} live session${live === 1 ? "" : "s"} running`);
      if (stale > 0)
        console.log(
          `  ${warn("!")} sentinels: ${stale} leftover from dead processes — next \`rune\` run files dirty-exit incident${stale === 1 ? "" : "s"}`,
        );
    }
  }

  doctorCheckpoints();

  doctorProviderRoutes();

  doctorToolchain();
  doctorBrowser();
  doctorMcp();

  // The recorder's own failures land here — this file should not exist.
  if (existsSync(LAST_RESORT())) {
    const tail = readFileSync(LAST_RESORT(), "utf-8").trim().split("\n").slice(-2);
    console.log(`  ${danger(glyph("failure"))} recorder self-errors (${LAST_RESORT()}):`);
    for (const line of tail) console.log(`    ${faint(line.slice(0, 100))}`);
  } else {
    console.log(`  ${ok("✓")} recorder: no internal failures`);
  }

  console.log(
    `\n  ${dim("browse:")} ${info("rune incidents")} ${dim("·")} ${info("rune incidents top")} ${dim("·")} ${info("rune incidents show <id>")}\n`,
  );
  store?.close();
}

// ─── checkpoints ───

const SESSION_DB = () => process.env.RUNE_DB_PATH || join(HOME(), "rune.db");

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * What the checkpoints table is costing, and how much of it is dead weight.
 *
 * It earned a line on this page the hard way: measured on the founder's own
 * database on 2026-09-10 it held 747 rows / 184 MiB of a 250 MiB file, written
 * on every file edit since May and read by nothing, because the run id was
 * minted from `Date.now()` and no row could ever be addressed again. The
 * writes are bounded now and superseded rows rotate; what accumulated before
 * that is still there, and this is where a person finds out.
 */
function doctorCheckpoints(): void {
  const path = SESSION_DB();
  if (!existsSync(path)) return;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const report = reportCheckpoints(db);
    if (report.rows === 0) {
      console.log(`  ${ok("✓")} checkpoints: none stored`);
      return;
    }
    const span =
      report.oldest && report.newest
        ? ` ${dim(`${shortTs(report.oldest)} → ${shortTs(report.newest)}`)}`
        : "";
    const mark = report.reclaimableBytes > 32 * 1024 * 1024 ? warn("!") : ok("✓");
    console.log(
      `  ${mark} checkpoints: ${text(String(report.rows))} row${report.rows === 1 ? "" : "s"} ` +
        `across ${report.runs} run${report.runs === 1 ? "" : "s"}, ` +
        `${text(fmtBytes(report.bytes))}${span}`,
    );
    if (report.reclaimableRows > 0) {
      console.log(
        `    ${dim("reclaimable:")} ${report.reclaimableRows} superseded or orphaned row` +
          `${report.reclaimableRows === 1 ? "" : "s"}, ${fmtBytes(report.reclaimableBytes)} ` +
          `${dim("—")} ${info("rune doctor prune-checkpoints")} ${dim("(dry run; --apply removes them)")}`,
      );
    }
  } catch {
    console.log(`  ${warn("!")} checkpoints: cannot read ${path}`);
  } finally {
    db?.close();
  }
}

/**
 * `rune doctor prune-checkpoints [--apply] [--keep N]`
 *
 * DRY RUN by default, and deliberately so: this is the founder's own history,
 * and a report must never be able to delete it by accident. It removes only
 * rows that are superseded (a newer version of the same run exists, beyond
 * `--keep`) or orphaned (their session is gone) — never the newest checkpoint
 * of a run whose session still exists.
 */
export function runCheckpointPrune(args: string[]): number {
  const apply = args.includes("--apply");
  const keepFlag = args.indexOf("--keep");
  const keep = keepFlag >= 0 ? Number(args[keepFlag + 1]) : 2;
  if (!Number.isFinite(keep) || keep < 1) {
    console.error(`  ${danger(glyph("failure"))} --keep must be a positive integer`);
    return 1;
  }
  const path = SESSION_DB();
  if (!existsSync(path)) {
    console.error(`  ${danger(glyph("failure"))} no session database at ${path}`);
    return 1;
  }
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: !apply });
    const before = reportCheckpoints(db);
    const result = pruneCheckpoints(db, { apply, keep: Math.floor(keep) });
    console.log(
      `
  ${dim("§ CHECKPOINTS")} ${faint(path)}

` +
        `  ${before.rows} row${before.rows === 1 ? "" : "s"} across ${before.runs} run` +
        `${before.runs === 1 ? "" : "s"}, ${fmtBytes(before.bytes)}
`,
    );
    if (result.removedRows === 0) {
      console.log(`  ${ok("✓")} nothing to prune — every row is a run's newest ${keep}
`);
      return 0;
    }
    console.log(
      result.applied
        ? `  ${ok("✓")} removed ${result.removedRows} row${result.removedRows === 1 ? "" : "s"}, ` +
            `${fmtBytes(result.removedBytes)} reclaimed ` +
            `${dim("(run VACUUM to return it to the filesystem)")}
`
        : `  ${warn("!")} would remove ${result.removedRows} row` +
            `${result.removedRows === 1 ? "" : "s"}, ${fmtBytes(result.removedBytes)} ` +
            `${dim("— nothing was deleted.")} ${info("rune doctor prune-checkpoints --apply")}
`,
    );
    return 0;
  } catch (err) {
    console.error(
      `  ${danger(glyph("failure"))} ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    db?.close();
  }
}

/**
 * The routes this machine can reach, and what the gateway remembers about them.
 *
 * `~/.rune/provider-health.json` is pruned on write, so a machine that stopped
 * making calls keeps records nobody believes. The person then has no way to ask
 * "is my Codex cap over?" without starting a session and finding out. This
 * section answers it offline, and says plainly when a record is stale or was
 * filed against the wrong route.
 */
function doctorProviderRoutes(): void {
  const now = Date.now();
  const lines = providerRouteLines(readProviderRouteReport({ home: HOME(), now }), now);
  for (const line of lines) {
    const mark =
      line.level === "ok" ? ok("✓") : line.level === "warn" ? warn("!") : danger(glyph("failure"));
    console.log(`  ${mark} ${line.level === "ok" ? line.text : text(line.text)}`);
    for (const sub of line.sub) console.log(`    ${faint(sub)}`);
  }
}

// ─── connectors, on paper ───
//
// One line, and it never starts a server: `rune doctor` is the page someone
// reads while already annoyed, and spawning half a dozen npx wrappers to fill
// in a status would cost it the one property it has. What IS free is reading
// the config and checking that each command and path exists — which is exactly
// the failure that has actually happened here. The live check is one command
// away and this line says so.

function doctorMcp(): void {
  let servers: ReturnType<typeof mergedServers>["servers"];
  try {
    servers = mergedServers(process.cwd()).servers;
  } catch {
    return;
  }
  const active = servers.filter((s) => s.config.enabled !== false);
  if (active.length === 0) {
    console.log(`  ${dim("mcp: no connectors configured")} ${faint("— rune mcp add notion")}`);
    return;
  }
  const broken = active.flatMap((s) => preflightServer(s.name, s.config));
  if (broken.length === 0) {
    console.log(
      `  ${ok("✓")} mcp: ${active.length} connector${active.length === 1 ? "" : "s"} configured, none misconfigured ${faint("— live health: rune mcp doctor")}`,
    );
    return;
  }
  console.log(
    `  ${danger(glyph("failure"))} mcp: ${broken.length} misconfigured — ${broken[0]!.problem} ${faint(`(${broken[0]!.fix})`)}`,
  );
  for (const p of broken.slice(1)) {
    console.log(`    ${faint(`${p.problem} — ${p.fix}`)}`);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── toolchain: rune-tools presence + compiled-binary freshness ───
// The doctor half of the stale-`rune-compiled` trap (the launcher warns at
// startup; this page explains it on demand): a fix lands in the TypeScript,
// the installed binary predates it, and "nothing changed" until a rebuild.

/** First .ts source under <root>/packages newer than builtAtMs — early exit,
 *  same contract as the launcher's `find -newer -print -quit`. */
function newerSourceThan(root: string, builtAtMs: number): string | null {
  const skip = new Set(["node_modules", "dist", "target", ".git"]);
  const stack = [join(root, "packages")];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) stack.push(path);
      else if (name.endsWith(".ts") && stats.mtimeMs > builtAtMs) return path;
    }
  }
  return null;
}

function gitHead(root: string): string | null {
  try {
    const result = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    const head = new TextDecoder().decode(result.stdout).trim();
    return head || null;
  } catch {
    return null;
  }
}

function doctorToolchain(): void {
  // rune-tools: same candidate order as the CLI's startup lookup.
  const candidates: string[] = [];
  if (process.env.RUNE_TOOLS_BIN) candidates.push(process.env.RUNE_TOOLS_BIN);
  candidates.push(
    new URL("../../../../target/release/rune-tools", import.meta.url).pathname,
    new URL("../../../../target/debug/rune-tools", import.meta.url).pathname,
    join(HOME(), "bin", "rune-tools"),
  );
  const tools = candidates.find((c) => existsSync(c)) ?? Bun.which("rune-tools");
  if (tools) {
    console.log(`  ${ok("✓")} rune-tools: ${info(tools)}`);
  } else {
    console.log(
      `  ${danger(glyph("failure"))} rune-tools: not found — set RUNE_TOOLS_BIN, re-run scripts/install.sh, or \`cargo build --release -p rune-tools\``,
    );
    for (const c of candidates) console.log(`    ${dim("searched:")} ${faint(c)}`);
  }

  // Build freshness, from the meta file the installer writes next to the binary.
  const metaPath = join(dirname(process.execPath), "rune-compiled.meta");
  if (!existsSync(metaPath)) {
    console.log(
      `  ${dim("·")} build freshness: no rune-compiled.meta next to this binary ${dim("(running from source, or an unmanaged install)")}`,
    );
    return;
  }
  try {
    const meta = Object.fromEntries(
      readFileSync(metaPath, "utf-8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    ) as Record<string, string>;
    const sourceRoot = meta.RUNE_SOURCE_ROOT ?? "";
    const builtAtMs = Number(meta.RUNE_BUILT_AT ?? 0) * 1000;
    if (!sourceRoot || !existsSync(join(sourceRoot, "packages")) || !(builtAtMs > 0)) {
      console.log(
        `  ${dim("·")} build freshness: meta unreadable or the source tree moved ${faint(`(${metaPath})`)}`,
      );
      return;
    }
    const builtLabel = localTs(builtAtMs);
    const sourceCommit = meta.RUNE_SOURCE_COMMIT ?? "";
    const sourceBranch = meta.RUNE_SOURCE_BRANCH || "detached";
    const dirty = meta.RUNE_SOURCE_DIRTY === "1";
    const provenance = sourceCommit
      ? `${sourceBranch}@${sourceCommit.slice(0, 8)}${dirty ? "+dirty" : ""}`
      : "legacy meta (commit unknown)";
    const currentCommit = gitHead(sourceRoot);
    const newer = newerSourceThan(sourceRoot, builtAtMs);
    if (sourceCommit && currentCommit && sourceCommit !== currentCommit) {
      console.log(
        `  ${warn("!")} build: STALE — installed ${provenance}, source is now ${currentCommit.slice(0, 8)}`,
      );
      console.log(`    ${dim("source:")} ${faint(sourceRoot)}`);
      console.log(`    ${dim("rebuild:")} ${info(`cd ${sourceRoot} && ./scripts/install.sh`)}`);
    } else if (newer) {
      console.log(
        `  ${warn("!")} build: STALE — built ${builtLabel} from ${provenance}; source changed since: ${faint(newer)}`,
      );
      console.log(`    ${dim("rebuild:")} ${info(`cd ${sourceRoot} && ./scripts/install.sh`)}`);
    } else {
      console.log(
        `  ${ok("✓")} build: current — ${provenance}, built ${builtLabel} from ${faint(sourceRoot)}`,
      );
    }
  } catch {
    console.log(`  ${dim("·")} build freshness: could not evaluate ${faint(metaPath)}`);
  }
}

/**
 * The agent browser: on or off, and whether this machine could actually run it.
 *
 * `buildBrowserServerSpec` runs `bunx @playwright/mcp@latest --browser
 * chromium`, which needs two things Rune never installs: the MCP package (a
 * network fetch the first time) and a managed Chromium (`playwright install
 * chromium`). Until now neither absence was visible anywhere: a run with
 * `--browser` set and no Chromium on disk failed at its first navigate call,
 * mid-run, after the expensive part. The handoff asks for browser runtime
 * dependencies to be validated BEFORE an expensive model run — this is the
 * free, offline half of that, and `AgentLoop`'s pre-flight notice is the other.
 */
function doctorBrowser(): void {
  const enabled = resolveInitialBrowser({
    env: process.env.RUNE_BROWSER_ENABLED ?? null,
    saved: loadSavedBrowserState(HOME()),
    configured: null,
  });
  const probe = probeBrowserRuntime();
  const parts: string[] = [];
  parts.push(
    probe.mcpModule ? "@playwright/mcp installed" : "@playwright/mcp fetched by bunx on first use",
  );
  parts.push(
    probe.playwrightModule
      ? `playwright module ${probe.playwrightModule}`
      : "no playwright module resolved here",
  );
  parts.push(
    probe.chromium.length > 0
      ? `chromium ${probe.chromium[0]}`
      : probe.browsersDir
        ? "no chromium in the playwright cache"
        : "no playwright browser cache",
  );
  const runnable = probe.chromium.length > 0;
  if (!enabled) {
    console.log(
      `  ${dim("\u00b7")} browser: off by config ${faint(`(${parts.join("; ")})`)} ${dim("\u2014")} ${info("/browser on")} ${dim("or")} ${info("rune --browser")}`,
    );
    return;
  }
  if (runnable) {
    console.log(`  ${ok("\u2713")} browser: on \u2014 ${faint(parts.join("; "))}`);
  } else {
    console.log(
      `  ${warn("!")} browser: on, but no Chromium is installed \u2014 ${faint(parts.join("; "))}`,
    );
    console.log(`    ${dim("install:")} ${info("bunx playwright install chromium")}`);
  }
}

// ─── incidents ───

export function runIncidents(positionals: string[], values: Record<string, unknown>): void {
  const store = openStore();
  if (!store) {
    console.log(dim(`  No black box found at ${DB()} — nothing recorded yet.`));
    return;
  }
  const sub = positionals[1] ?? "list";

  if (sub === "list") {
    const rows = store.list({
      limit: 25,
      // --all includes the debug tier (salvages, schema retries); default hides it
      minSeverity: values.all ? "debug" : "warn",
    });
    if (rows.length === 0) {
      console.log(dim("  No incidents recorded. That is the good outcome."));
    } else {
      console.log(
        `\n  ${dim("§ INCIDENTS")} ${faint(values.all ? "(all)" : "(warn+ — use --all for debug too)")}\n`,
      );
      for (const r of rows) {
        console.log(
          `  ${info(r.id.slice(-8))} ${dim(shortTs(r.ts))} ` +
            `${sevPaint(r.severity, r.severity.padEnd(8))} ${text(r.class.padEnd(36))} ` +
            `${outcomePaint(r.outcome)}\n` +
            `           ${faint(r.message.replace(/\s+/g, " ").slice(0, 96))}`,
        );
      }
      console.log(`\n  ${dim("details:")} ${info("rune incidents show <id>")}\n`);
    }
  } else if (sub === "show") {
    const prefix = positionals[2];
    if (!prefix) {
      console.log(dim("  Usage: rune incidents show <id-prefix>"));
    } else {
      const r = store.getByPrefix(prefix);
      if (!r) {
        console.log(dim(`  No unique incident matching "${prefix}".`));
      } else {
        printIncident(r);
      }
    }
  } else if (sub === "top") {
    if (values["by-version"]) {
      printByVersion(store);
    } else {
      const top = store.top({ limit: 15 });
      if (top.length === 0) {
        console.log(dim("  Nothing recorded yet."));
      } else {
        console.log(`\n  ${dim("§ TOP RECURRING INCIDENTS")}\n`);
        for (const f of top) {
          console.log(
            `  ${warn(String(f.count).padStart(4))}× ${text(f.class.padEnd(36))} ${dim(
              `first ${shortTs(f.firstSeen)} · last ${shortTs(f.lastSeen)} · v${f.versions.join(", v")}`,
            )}\n        ${faint(f.messageSample.slice(0, 90))}`,
          );
        }
        console.log("");
      }
    }
  } else if (sub === "export") {
    const out =
      (values.out as string | undefined) ??
      join(process.cwd(), `rune-incidents-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const rows = store.list({ limit: 10_000, minSeverity: "debug" });
    // Everything was redacted at capture time; export as-is, newest first.
    writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(
      `  ${ok("✓")} exported ${rows.length} incidents → ${info(out)}\n  ${dim(
        "redacted at capture — safe to attach to a bug report",
      )}`,
    );
  } else {
    console.log(
      dim("  Usage: rune incidents [list|show <id>|top [--by-version]|export [--out <path>]]"),
    );
  }
  store.close();
}

function outcomePaint(outcome: string): string {
  if (outcome === "recovered") return ok(outcome);
  if (outcome === "pending") return dim(outcome);
  return warn(outcome);
}

function printIncident(r: IncidentRecord): void {
  console.log(`\n  ${dim("§ INCIDENT")} ${info(r.id)}\n`);
  const row = (k: string, v: string) => console.log(`  ${dim(k.padEnd(11))} ${v}`);
  row("when", `${shortTs(r.ts)}  ${dim(`v${r.version}`)}`);
  row("what", `${sevPaint(r.severity, r.severity)} ${text(r.class)}`);
  row("where", `${r.component} ${dim("·")} ${faint(r.where)}`);
  if (r.sessionId)
    row("session", `${r.sessionId.slice(0, 8)}${r.turn ? dim(` · run ${r.turn}`) : ""}`);
  row("outcome", outcomePaint(r.outcome));
  console.log(`\n  ${dim("message")}\n    ${text(r.message)}`);
  if (r.stack) {
    console.log(`\n  ${dim("stack")}`);
    for (const line of r.stack.split("\n").slice(0, 8)) console.log(`    ${faint(line)}`);
  }
  const ctx = Object.entries(r.context ?? {}).filter(([, v]) => v !== undefined);
  if (ctx.length > 0) {
    console.log(`\n  ${dim("context")}`);
    for (const [k, v] of ctx) console.log(`    ${faint(`${k}: ${String(v)}`)}`);
  }
  if (r.trail.length > 0) {
    console.log(`\n  ${dim("trail (what Rune did leading up to this)")}`);
    for (const t of r.trail) {
      console.log(
        `    ${dim(String(t.seq).padStart(3))} ${info(t.kind.padEnd(16))} ${faint(t.summary)}`,
      );
    }
  }
  console.log("");
}

/** Compare the two most recent versions: new / persisting / fixed fingerprints. */
function printByVersion(store: BlackboxStore): void {
  const byV = store.byVersion();
  const versions = [...byV.keys()].sort();
  if (versions.length === 0) {
    console.log(dim("  Nothing recorded yet."));
    return;
  }
  if (versions.length === 1) {
    console.log(dim(`  Only one version recorded (v${versions[0]}) — nothing to compare yet.`));
    return;
  }
  const [prev, curr] = versions.slice(-2);
  const prevSet = new Set((byV.get(prev) ?? []).map((f) => f.fingerprint));
  const currRows = byV.get(curr) ?? [];
  const currSet = new Set(currRows.map((f) => f.fingerprint));

  const fresh = currRows.filter((f) => !prevSet.has(f.fingerprint));
  const persisting = currRows.filter((f) => prevSet.has(f.fingerprint));
  const gone = (byV.get(prev) ?? []).filter((f) => !currSet.has(f.fingerprint));

  console.log(`\n  ${dim("§ VERSION DIFF")}  v${prev} → v${curr}\n`);
  const section = (label: string, rows: typeof currRows, painter: (s: string) => string) => {
    console.log(`  ${painter(label)} ${dim(`(${rows.length})`)}`);
    for (const f of rows.slice(0, 8)) {
      console.log(`    ${text(f.class.padEnd(36))} ${faint(f.messageSample.slice(0, 60))}`);
    }
    if (rows.length > 8) console.log(`    ${dim(`… ${rows.length - 8} more`)}`);
    console.log("");
  };
  section("new in this version", fresh, accent);
  section("still occurring", persisting, warn);
  section("not seen since — likely fixed", gone, ok);
}
