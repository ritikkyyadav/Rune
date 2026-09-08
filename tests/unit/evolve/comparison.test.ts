import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { COMPARISON_TASKS } from "../../eval/comparison/tasks";
import { seedTask, checkTask, providerFailureReason, runPilot } from "../../eval/comparison/runner";
import { predictionFor, loadInstances } from "../../eval/comparison/swebench";
import { opencodeCost, runeCost } from "../../eval/comparison/harness";
import { runProcess } from "../../eval/comparison/process";
import { rmTemp } from "../../helpers/tmp";
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "rune-comparison-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  // Windows holds a just-exited child's cwd for a moment; a plain rmSync
  // throws EBUSY there and fails the test after it has already passed.
  for (const dir of dirs.splice(0)) rmTemp(dir);
});
function git(root: string, ...args: string[]) {
  const p = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (p.status !== 0) throw new Error(p.stderr);
  return p.stdout.trim();
}

test("provider interruptions are distinguished from task failures without publishing error data", () => {
  expect(providerFailureReason({ type: "error", error: "Quota exceeded on codex/model" })).toBe(
    "provider_quota",
  );
  expect(
    providerFailureReason({
      type: "error",
      error: {
        data: {
          statusCode: 429,
          message: "The usage limit has been reached",
          headers: { cookie: "secret" },
        },
      },
    }),
  ).toBe("provider_quota");
  expect(providerFailureReason({ type: "error", error: { data: { statusCode: 503 } } })).toBe(
    "provider_unavailable",
  );
  expect(providerFailureReason({ type: "error", error: { data: { statusCode: 401 } } })).toBe(
    "provider_authentication",
  );
  expect(
    providerFailureReason({ type: "tool_result", error: "rate-limit unit test failed" }),
  ).toBeUndefined();
  expect(
    providerFailureReason({ type: "text", text: "The usage limit has been reached" }),
  ).toBeUndefined();
  expect(
    providerFailureReason({ type: "error", error: "Worker could not integrate changed files" }),
  ).toBeUndefined();
});

test("a mid-run quota failure retains usage, excludes the score and stops further inference", async () => {
  const dir = temp();
  const fake = join(dir, "interrupted.ts");
  writeFileSync(
    fake,
    `import {Database} from 'bun:sqlite';
    if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
    const db = new Database(process.env.RUNE_HOME+'/rune.db');
    db.exec('CREATE TABLE events (payload_json TEXT)');
    db.prepare('INSERT INTO events VALUES (?)').run(JSON.stringify({type:'cost',payload:{model:'gpt-5.6-sol',provider:'codex',priced:true,listCostUsd:0.2}}));
    db.close();
    console.log(JSON.stringify({type:'error',error:'Quota exceeded after one completed request'}));
    process.exit(1);`,
  );
  const report = await runPilot({
    out: join(dir, "report"),
    model: "gpt-5.6-sol",
    runeProvider: "codex",
    opencodeProvider: "openai",
    budgetUsd: 1,
    timeoutMs: 2000,
    runs: 1,
    tasks: ["csv-state-machine"],
    runeCommand: [process.execPath, fake],
    opencodeCommand: [process.execPath, fake],
  });
  expect(report.results).toHaveLength(1);
  expect(report.results[0]).toMatchObject({
    entries: 1,
    listUsd: 0.2,
    scored: false,
    unscoredReason: "provider_quota",
    success: false,
  });
});

test("independent acceptance rejects each broken coding fixture and accepts a correct working-tree implementation", () => {
  for (const task of COMPARISON_TASKS.filter((t) => !t.browser)) {
    const dir = temp(),
      root = join(dir, "work");
    seedTask(task, root);
    expect(checkTask(task, root, dir).passed).toBe(false);
  }
  const task = COMPARISON_TASKS.find((t) => t.id === "working-tree-integration")!;
  const dir = temp(),
    root = join(dir, "work");
  seedTask(task, root);
  writeFileSync(
    join(root, "orders.ts"),
    `import {parseMinor} from './money'; export function summarizeOrders(rows) { const out={}; for(const r of rows) { if(r.refunded)continue; if(!/^[A-Z]{3}$/.test(r.currency))throw Error('currency'); const v=out[r.currency]??{count:0,totalMinor:0}; v.count++;v.totalMinor+=parseMinor(r.amount);if(!Number.isSafeInteger(v.totalMinor))throw Error('overflow');out[r.currency]=v;} return out;}`,
  );
  expect(checkTask(task, root, dir).passed).toBe(true);
  writeFileSync(
    join(root, "money.ts"),
    readFileSync(join(root, "money.ts"), "utf8") + "// changed\n",
  );
  expect(checkTask(task, root, dir).passed).toBe(false);
});

test("SWE predictions include actual new and deleted files while preserving the user's index", () => {
  const dir = temp();
  seedTask(
    COMPARISON_TASKS.find((t) => t.id === "csv-state-machine")!,
    dir,
  );
  const base = git(dir, "rev-parse", "HEAD"),
    index = readFileSync(join(dir, ".git/index"));
  rmSync(join(dir, "csv.ts"));
  writeFileSync(join(dir, "created.ts"), "export const fixed = true;\n");
  const prediction = predictionFor(
    dir,
    {
      instance_id: "owner__repo-1",
      repo: "owner/repo",
      base_commit: base,
      problem_statement: "Fix",
    },
    "rune/model",
  );
  expect(prediction.model_patch).toContain("new file mode");
  expect(prediction.model_patch).toContain("deleted file mode");
  expect(prediction.model_patch).toContain("export const fixed = true");
  expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
  expect(prediction.instance_id).toBe("owner__repo-1");
  const path = join(temp(), "dataset.jsonl"),
    row = {
      instance_id: "owner__repo-1",
      repo: "owner/repo",
      base_commit: base,
      problem_statement: "Fix",
    };
  writeFileSync(path, JSON.stringify(row) + "\n" + JSON.stringify(row) + "\n");
  expect(() => loadInstances(path)).toThrow("duplicate");
});

test("cost readers aggregate child sessions and reject zero-usage or unpriced completion as a cost result", () => {
  const root = temp();
  mkdirSync(join(root, "opencode"));
  const oc = new Database(join(root, "opencode/opencode.db"));
  oc.exec("CREATE TABLE message (data TEXT)");
  const insert = oc.prepare("INSERT INTO message VALUES (?)");
  insert.run(
    JSON.stringify({ role: "assistant", modelID: "gpt-5.6-sol", tokens: { input: 0, output: 0 } }),
  );
  expect(opencodeCost(root, "gpt-5.6-sol").entries).toBe(0);
  for (const session of ["parent", "child"])
    insert.run(
      JSON.stringify({
        role: "assistant",
        sessionID: session,
        modelID: "gpt-5.6-sol",
        tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 50 } },
      }),
    );
  expect(opencodeCost(root, "gpt-5.6-sol").entries).toBe(2);
  expect(opencodeCost(root, "gpt-5.6-sol").listUsd).toBeGreaterThan(0);
  oc.close();
  const db = new Database(join(root, "rune.db"));
  db.exec("CREATE TABLE events (payload_json TEXT)");
  const add = (priced: boolean) =>
    db.prepare("INSERT INTO events VALUES (?)").run(
      JSON.stringify({
        type: "cost",
        payload: { model: "m", provider: "p", priced, listCostUsd: priced ? 0.1 : 0 },
      }),
    );
  add(true);
  expect(runeCost(root).listUsd).toBeCloseTo(0.1);
  add(false);
  expect(runeCost(root).listUsd).toBeNull();
  db.close();
});

test("benchmark timeout and cost cancellation terminate process trees without interpolating arguments", async () => {
  for (const mode of ["timeout", "cost"]) {
    const dir = temp(),
      marker = join(dir, "leaked");
    const script = `import {spawn} from 'node:child_process'; spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'leak'),650)`)}],{stdio:'inherit'}); console.log('stop');setInterval(()=>{},1000);`;
    const result = await runProcess({
      command: [process.execPath, "-e", script],
      cwd: dir,
      timeoutMs: mode === "timeout" ? 200 : 2000,
      stdoutPath: join(dir, "out"),
      stderrPath: join(dir, "err"),
      onLine: mode === "cost" ? (line) => line === "stop" : undefined,
    });
    expect(result.stopped).toBe(mode === "cost" ? "cost limit" : "timeout");
    await Bun.sleep(700);
    expect(existsSync(marker)).toBe(false);
  }
});
