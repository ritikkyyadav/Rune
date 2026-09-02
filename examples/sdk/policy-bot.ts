// ─── Answering permissions from a policy instead of from a person ───
//
//   bun run examples/sdk/policy-bot.ts
//
// A permission prompt is the one thing that stops an agent being scriptable,
// and the usual answer to that is `--yolo`: approve everything, which is not a
// policy, it is the absence of one. This is the other answer. The bot holds a
// small allow/deny list, answers each request from it, and refuses anything it
// was not told about — so the set of things this run may do is written down
// before it starts, and every decision has a rule behind it.
//
// The important line is the last one in `decide`: an unmatched request is
// DENIED. A policy whose default is "allow" only documents the requests you
// happened to think of.
//
// With no `gear serve` running this stands up its own against a fake model.

import { GearClient, type PermissionPrompt, type UserPermissionDecision } from "@gear/sdk";

import { calls, says, startMockGear, runningServer, type MockGear } from "./mock-engine";

// ─── The policy ───

interface Rule {
  tool: string;
  /** Matched against the request's argument summary. Omit to match any args. */
  when?: RegExp;
  allow: boolean;
  because: string;
}

const POLICY: Rule[] = [
  { tool: "read_file", allow: true, because: "reads are free" },
  { tool: "grep", allow: true, because: "reads are free" },
  { tool: "bash", when: /^\s*(echo|ls|cat|git status)\b/, allow: true, because: "read-only shell" },
  {
    tool: "bash",
    when: /\brm\b|\bcurl\b|\bsudo\b/,
    allow: false,
    because: "destructive or outward",
  },
  { tool: "write_file", allow: false, because: "this bot reviews, it does not edit" },
];

export interface Verdict {
  decision: UserPermissionDecision;
  because: string;
}

/**
 * The whole bot, and the only part worth unit-testing: prompt in, decision out,
 * with the reason attached. Nothing in here touches a socket.
 */
export function decide(prompt: Pick<PermissionPrompt, "toolName" | "argsSummary">): Verdict {
  // The host labels a summary with the tool it belongs to (`bash: rm -rf …`).
  // Strip that before matching, so a rule reads like the command it is about
  // and not like the string the UI happens to render.
  const args = prompt.argsSummary.replace(new RegExp(`^${prompt.toolName}:\\s*`), "");
  for (const rule of POLICY) {
    if (rule.tool !== prompt.toolName) continue;
    if (rule.when && !rule.when.test(args)) continue;
    return {
      decision: { kind: rule.allow ? "allow_once" : "deny" },
      because: rule.because,
    };
  }
  // The default that makes this a policy rather than a rubber stamp.
  return { decision: { kind: "deny" }, because: "no rule covers this" };
}

// ─── The run ───

async function main(): Promise<number> {
  const live = await runningServer();
  let mock: MockGear | null = null;
  let endpoint: { url: string; token: string };

  if (live) {
    console.log(`· driving the gear serve already running at ${live.url}\n`);
    endpoint = live;
  } else {
    console.log("· no gear serve running — standing one up against a fake model\n");
    // One request the policy allows, one it refuses. The refusal is the half
    // that matters: the agent is told no and has to carry on without it.
    mock = await startMockGear([
      calls("call_1", "bash", { command: "echo checking-the-tree" }),
      calls("call_2", "bash", { command: "rm -rf /tmp/anything" }),
      says("The second command was refused by policy; stopping there."),
    ]);
    endpoint = { url: mock.url, token: mock.token };
  }

  const log: string[] = [];

  const gear = await GearClient.connect(endpoint, {
    onEvent(event) {
      if (event.type === "text_delta") process.stdout.write(event.text);
    },
    async onPermission(prompt) {
      const { decision, because } = decide(prompt);
      const mark = decision.kind === "deny" ? "deny " : "allow";
      const line = `${mark}  ${prompt.toolName}  ${prompt.argsSummary}  — ${because}`;
      log.push(line);
      console.log(`\n  ${line}`);
      return decision;
    },
    // The bot has no opinions to offer, so it answers nothing and the host
    // applies its stated policy: the model proceeds and names its assumption.
    // Leaving a handler unset is a real choice, not an oversight.
  });

  const sessionId = await gear.createSession();
  await gear.run(sessionId, "tidy the tree up");
  gear.close();

  console.log("\n\n─── the policy's decisions ───\n");
  for (const line of log) console.log(`  ${line}`);
  console.log(
    `\n  ${log.filter((l) => l.startsWith("allow")).length} allowed, ${
      log.filter((l) => l.startsWith("deny")).length
    } denied\n`,
  );

  await mock?.stop();
  return 0;
}

if (import.meta.main) process.exit(await main());
