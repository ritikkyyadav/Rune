// Acceptance for `json-output-flag`. Run by the grader, never shown to the model.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// The corpus's convention, which the parity grader keeps: the script may be
// staged outside the workspace and is run with cwd set to it, so the tree
// under test is the working directory, never a path from this file's URL.
const root = process.cwd();
const which = process.argv[2];
// One line per verdict, scrubbed of the two phrases the runtime reads as "the
// command never ran" — a check that failed honestly must not look like that.
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable")
    .replace(/\s+/g, " ")
    .trim();
const plain = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "");
const tail = (text) => plain(text).replace(/\s+/g, " ").trim().slice(-300);

/** Run the CLI the way its user does: a process, in the workspace. */
function cli(...args) {
  const run = spawnSync(process.execPath, ["cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

// A log the fixture's own tests never saw: no DEBUG line, one CRLF line, and
// two lines that must not be counted.
const LOG = [
  "2026-09-30T08:00:00Z INFO boot",
  "2026-09-30T08:00:01Z WARN disk 91% full",
  "2026-09-30T08:00:02Z INFO ready\r",
  "2026-09-30T08:00:03Z ERROR worker 3 crashed",
  "WARN a line with no timestamp is not counted",
  "2026-09-30T08:00:04Z WARN retrying",
  "2026-09-30T08:00:05Z INFO done",
  "",
].join("\n");

// The table the fixture prints for LOG, pinned: "must not change" is checked
// against the original format, not against whatever the tree prints now.
const row = (label, count) => `${label.padEnd(6)}${String(count).padStart(6)}`;
const TABLE =
  [row("DEBUG", 0), row("INFO", 3), row("WARN", 2), row("ERROR", 1), row("TOTAL", 6)].join("\n") +
  "\n";

function withLog(body) {
  const dir = mkdtempSync(join(tmpdir(), "logstats-check-"));
  try {
    const file = join(dir, "sample.log");
    writeFileSync(file, LOG);
    body(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseJson(stdout, what) {
  try {
    return JSON.parse(stdout);
  } catch {
    assert.fail(`${what} did not print one JSON object: ${JSON.stringify(stdout.slice(0, 200))}`);
  }
}

/** Test files anywhere in the tree, outside dependencies and dot-directories. */
function testFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const checks = {
  // The flag's output, its combination with --level, and the table untouched.
  json() {
    withLog((file) => {
      const table = cli(file);
      assert.equal(
        table.code,
        0,
        `without --json the CLI exited ${table.code}: ${tail(table.stderr)}`,
      );
      assert.equal(table.stdout, TABLE, "the table printed without --json changed");
      const json = cli("--json", file);
      assert.equal(json.code, 0, `--json exited ${json.code}: ${tail(json.stderr)}`);
      assert.deepEqual(parseJson(json.stdout, "--json"), {
        total: 6,
        levels: { DEBUG: 0, INFO: 3, WARN: 2, ERROR: 1 },
      });
      const filtered = cli("--level", "WARN", "--json", file);
      assert.equal(filtered.code, 0, `--level WARN --json exited ${filtered.code}`);
      assert.deepEqual(
        parseJson(filtered.stdout, "--level WARN --json"),
        { total: 2, levels: { DEBUG: 0, INFO: 0, WARN: 2, ERROR: 0 } },
        "--json does not combine with --level",
      );
    });
  },
  // The half a model's own tests never reach, part one.
  help() {
    const help = cli("--help");
    assert.equal(help.code, 0, `--help exited ${help.code}`);
    assert.match(help.stdout, /--json\b/, "the --help text does not list --json");
    assert.match(help.stdout, /--level\b/, "the --help text lost --level");
  },
  // Part two: the documentation, in the section the prompt named.
  readme() {
    const text = readFileSync(join(root, "README.md"), "utf8");
    const usage = text.split(/^## /m).find((section) => /^Usage\b/i.test(section));
    assert.ok(usage, "README.md has no Usage section");
    assert.match(usage, /--json\b/, "the Usage section of README.md does not document --json");
  },
  // A test that names the flag, and a suite that still passes and did not shrink.
  tests() {
    assert.ok(
      testFiles(root).some((file) => /--json\b/.test(readFileSync(file, "utf8"))),
      "no test file exercises --json",
    );
    const run = spawnSync(process.execPath, ["test"], {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
    });
    const output = plain(`${run.stdout ?? ""}${run.stderr ?? ""}`);
    assert.equal(run.status, 0, `the test suite does not pass: ${tail(output)}`);
    const passed = Number(/(\d+) pass\b/.exec(output)?.[1]);
    if (Number.isFinite(passed))
      assert.ok(passed >= 5, `${passed} tests pass; the suite had 4 and gained one for --json`);
  },
};

const run = checks[which];
if (!run) {
  console.log(`acceptance failed: unknown criterion ${which}`);
  process.exit(1);
}
try {
  await run();
  console.log(`acceptance ok: ${which}`);
  process.exit(0);
} catch (error) {
  console.log(`acceptance failed: ${which} — ${safe(error?.message ?? error)}`);
  process.exit(1);
}
