// ─── `gear doctor` + `gear incidents`: the black box's terminal surfaces ───
// Both open ~/.gear/blackbox.db directly (read-only usage) — no Engine boot, no
// provider validation, instant. Deliberately plain output: this is the page an
// annoyed user reads right after something broke.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getGearHome } from "@gear/shared";
import type { IncidentRecord } from "@gear/shared";
import { BlackboxStore } from "@gear/telemetry";
import { accent, danger, dim, faint, info, ok, text, warn } from "./ui/theme";
import { glyph } from "./ui/glyphs";

const HOME = () => getGearHome();
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

function sevPaint(severity: string, s: string): string {
  if (severity === "critical") return danger(s);
  if (severity === "error") return danger(s);
  if (severity === "warn") return warn(s);
  return dim(s);
}

// ─── doctor ───

export function runDoctor(): void {
  console.log(`\n  ${dim("§ GEAR DOCTOR")}\n`);

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
          `  ${warn("!")} sentinels: ${stale} leftover from dead processes — next \`gear\` run files dirty-exit incident${stale === 1 ? "" : "s"}`,
        );
    }
  }

  doctorToolchain();

  // The recorder's own failures land here — this file should not exist.
  if (existsSync(LAST_RESORT())) {
    const tail = readFileSync(LAST_RESORT(), "utf-8").trim().split("\n").slice(-2);
    console.log(`  ${danger(glyph("failure"))} recorder self-errors (${LAST_RESORT()}):`);
    for (const line of tail) console.log(`    ${faint(line.slice(0, 100))}`);
  } else {
    console.log(`  ${ok("✓")} recorder: no internal failures`);
  }

  console.log(
    `\n  ${dim("browse:")} ${info("gear incidents")} ${dim("·")} ${info("gear incidents top")} ${dim("·")} ${info("gear incidents show <id>")}\n`,
  );
  store?.close();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── toolchain: gear-tools presence + compiled-binary freshness ───
// The doctor half of the stale-`gear-compiled` trap (the launcher warns at
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
  // gear-tools: same candidate order as the CLI's startup lookup.
  const candidates: string[] = [];
  if (process.env.GEAR_TOOLS_BIN) candidates.push(process.env.GEAR_TOOLS_BIN);
  candidates.push(
    new URL("../../../../target/release/gear-tools", import.meta.url).pathname,
    new URL("../../../../target/debug/gear-tools", import.meta.url).pathname,
    join(HOME(), "bin", "gear-tools"),
  );
  const tools = candidates.find((c) => existsSync(c)) ?? Bun.which("gear-tools");
  if (tools) {
    console.log(`  ${ok("✓")} gear-tools: ${info(tools)}`);
  } else {
    console.log(
      `  ${danger(glyph("failure"))} gear-tools: not found — set GEAR_TOOLS_BIN, re-run scripts/install.sh, or \`cargo build --release -p gear-tools\``,
    );
    for (const c of candidates) console.log(`    ${dim("searched:")} ${faint(c)}`);
  }

  // Build freshness, from the meta file the installer writes next to the binary.
  const metaPath = join(dirname(process.execPath), "gear-compiled.meta");
  if (!existsSync(metaPath)) {
    console.log(
      `  ${dim("·")} build freshness: no gear-compiled.meta next to this binary ${dim("(running from source, or an unmanaged install)")}`,
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
    const sourceRoot = meta.GEAR_SOURCE_ROOT ?? "";
    const builtAtMs = Number(meta.GEAR_BUILT_AT ?? 0) * 1000;
    if (!sourceRoot || !existsSync(join(sourceRoot, "packages")) || !(builtAtMs > 0)) {
      console.log(
        `  ${dim("·")} build freshness: meta unreadable or the source tree moved ${faint(`(${metaPath})`)}`,
      );
      return;
    }
    const builtLabel = shortTs(new Date(builtAtMs).toISOString());
    const sourceCommit = meta.GEAR_SOURCE_COMMIT ?? "";
    const sourceBranch = meta.GEAR_SOURCE_BRANCH || "detached";
    const dirty = meta.GEAR_SOURCE_DIRTY === "1";
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
      console.log(`\n  ${dim("details:")} ${info("gear incidents show <id>")}\n`);
    }
  } else if (sub === "show") {
    const prefix = positionals[2];
    if (!prefix) {
      console.log(dim("  Usage: gear incidents show <id-prefix>"));
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
      join(process.cwd(), `gear-incidents-${new Date().toISOString().slice(0, 10)}.jsonl`);
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
      dim("  Usage: gear incidents [list|show <id>|top [--by-version]|export [--out <path>]]"),
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
    console.log(`\n  ${dim("trail (what Gear did leading up to this)")}`);
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
