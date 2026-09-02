// ─── Run a task, then read back what it actually did ───
//
//   bun run examples/sdk/run-task.ts
//
// The point of this example is the second half. Running a prompt from a script
// is table stakes; every agent SDK does it. What Gear gives a script that no
// other one does is the receipt: `gear audit` reads the session back as one
// page — the plan with its evidence, every safety decision and why, the held
// steps, the cost — from the same database the run wrote. A script that ran an
// agent and cannot say what it did has not automated anything.
//
// With no `gear serve` running this stands up its own, against a fake model, so
// the example works on a fresh clone with no API key. With one running it
// drives that.

import { GearClient } from "@gear/sdk";

import { calls, says, startMockGear, runningServer, type MockGear } from "./mock-engine";

const PROMPT = "check the shell works, then tell me it is done";

async function main(): Promise<number> {
  const live = await runningServer();
  let mock: MockGear | null = null;
  let endpoint: { url: string; token: string };

  if (live) {
    console.log(`· driving the gear serve already running at ${live.url}\n`);
    endpoint = live;
  } else {
    console.log("· no gear serve running — standing one up against a fake model\n");
    mock = await startMockGear([
      calls("call_1", "bash", { command: "echo evidence-from-the-example" }),
      says("Done — the shell answered."),
    ]);
    endpoint = { url: mock.url, token: mock.token };
  }

  const decisions: string[] = [];

  const gear = await GearClient.connect(endpoint, {
    // The turn, event by event. The same 22-member union the terminal renders.
    onEvent(event) {
      if (event.type === "text_delta") process.stdout.write(event.text);
      if (event.type === "tool_call_start") process.stdout.write(`\n  · ${event.toolName}`);
      if (event.type === "tool_call_end") {
        process.stdout.write(event.output.isError ? "  (failed)\n" : "  ok\n");
      }
    },

    // An agent stops for a human. A script IS the human here, and answering is
    // a decision it should be able to explain afterwards — so it is recorded.
    async onPermission(prompt) {
      decisions.push(`allow_once  ${prompt.toolName}  ${prompt.argsSummary}`);
      return { kind: "allow_once" };
    },

    // Auto mode's end-of-turn ledger: outward steps it declined to take with
    // nobody watching. They stay unrun until a person approves them by id.
    onHeldSteps(steps) {
      for (const step of steps) {
        console.log(`\n  · held: ${(step as { summary?: string }).summary ?? "(step)"}`);
      }
    },
  });

  const sessionId = await gear.createSession();
  console.log(`  session ${sessionId}\n`);
  await gear.run(sessionId, PROMPT);
  gear.close();

  console.log("\n\n─── the audit ───\n");
  if (mock) {
    // `gear audit` opens the session database read-only: no engine, no
    // provider, instant. Pointing it at this run's database is the only
    // difference between the example and what you would type yourself.
    const audit = await mock.gear(["audit", sessionId]);
    process.stdout.write(audit.stdout || audit.stderr);
  } else {
    console.log(`  gear audit ${sessionId}`);
  }

  if (decisions.length > 0) {
    console.log("─── what this script answered ───\n");
    for (const d of decisions) console.log(`  ${d}`);
    console.log();
  }

  await mock?.stop();
  return 0;
}

process.exit(await main());
