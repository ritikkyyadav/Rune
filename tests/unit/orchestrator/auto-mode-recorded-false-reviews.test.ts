/**
 * Two mechanical rules that sent ordinary work to the heavy reviewer, pinned
 * from both sides.
 *
 * Both were read off one recorded run — a dashboard built from an empty folder
 * on 2026-10-09 (`~/rune-evidence/design-ab2-20261008/dashboard`), where three
 * in-path reviews cost $0.32 of $1.13 and every one came back "low risk,
 * allow":
 *
 *   · a `node <<'NODE'` script that checked the page's own JavaScript was rated
 *     a destructive operation on a remote service, because it printed the word
 *     "render" and elsewhere said `delete this.attributes[name]`;
 *   · a fetch of `https://rows.com/blog/post/ecommerce-dashboard` was rated an
 *     outbound payload, on the path segment `post`.
 *
 * What a wrong answer costs in each direction sets how these are written. A
 * false "high" costs a reviewer call and, with no reviewer to ask, has the
 * command withheld. A false "not high" takes a real deletion off the reviewer's
 * desk and leaves it to the background screen. So the first half of each group
 * is the list of ways a service is actually reached — every one of them rated
 * high before this change and must be still — and the second half is the name
 * used as a word.
 */
import { describe, expect, test } from "bun:test";

import {
  assessActionRisk,
  type AutoModeAction,
} from "../../../packages/orchestrator/src/auto-mode";
import {
  isRemoteMutationCommand,
  routeContainment,
} from "../../../packages/orchestrator/src/auto-containment";

const schema = (name: string, category: string) =>
  ({
    name,
    version: "1",
    description: "",
    inputSchema: {},
    permissionLevel: "ask",
    category,
  }) as unknown as AutoModeAction["schema"];

const bash = (command: string): AutoModeAction => ({
  callId: "c1",
  toolName: "bash",
  args: { command },
  schema: schema("bash", "execute"),
  workspaceRoot: "/tmp/ws",
});

const fetchOf = (args: Record<string, unknown>): AutoModeAction => ({
  callId: "c1",
  toolName: "web_fetch",
  args,
  schema: schema("web_fetch", "network"),
  workspaceRoot: "/tmp/ws",
});

/** The first of the two recorded scripts, cut to the lines that mattered. */
const RECORDED_PAGE_CHECK = [
  "node --check script.js && node <<'NODE'",
  "const assert = require('node:assert/strict');",
  "const fs = require('node:fs');",
  "const vm = require('node:vm');",
  "class Element {",
  "  setAttribute(name, value) { this.attributes[name] = value; }",
  "  removeAttribute(name) { delete this.attributes[name]; }",
  "  click() { downloaded = this.download; }",
  "  remove() {}",
  "}",
  "vm.runInNewContext(fs.readFileSync('script.js', 'utf8'), context);",
  "assert.match(get('revenue-chart').innerHTML, /<path/);",
  "console.log('Behavior passed at 280px: render, 5 products, periods, keyboard chart detail, 7/90-day CSV.');",
  "NODE",
].join("\n");

describe("a destructive verb in a command that RUNS a service CLI is still high", () => {
  const reached: Array<[string, string]> = [
    ["the plain command", "gh repo delete acme/site --yes"],
    ["a verb that is a flag's value", "gh api -X DELETE repos/acme/site"],
    ["the verb on a continuation line", "gh api \\\n  -X DELETE repos/acme/site"],
    ["a quoted program name", '"gh" release delete v1.2.0 --yes'],
    ["a program found by substitution", "$(command -v gh) repo delete acme/site"],
    ["the same, quoted", '"$(command -v gh)" repo delete acme/site'],
    ["a path-qualified program", "/opt/homebrew/bin/gh repo delete acme/site"],
    ["the Windows executable", "gh.exe repo delete acme/site"],
    ["a quoted Windows path", '& "C:\\Program Files\\GitHub CLI\\gh.exe" repo delete acme/site'],
    ["an environment prefix", "GH_TOKEN=x gh repo delete acme/site"],
    ["a wrapper in front", "sudo -E env kubectl delete namespace staging"],
    ["a package runner", "npx vercel remove my-app --yes"],
    ["a package runner with a version", "npx -y vercel@latest remove my-app --yes"],
    ["a container that is the tool", "docker run --rm hashicorp/terraform destroy -auto-approve"],
    ["spaces spelled as $IFS", "gh${IFS}repo${IFS}delete${IFS}acme/site"],
    ["a variable holding the tool", "CLI=gh; $CLI repo delete acme/site"],
    ["an alias holding the tool", "alias k=kubectl\nk delete pod api-0"],
    ["the tool as xargs's command", "printf 'apps:destroy my-app' | xargs heroku"],
    ["a shell handed the line", "bash -c 'gh gist delete abc123 --yes'"],
    [
      "a string another program runs",
      `node -e 'require("child_process").execSync("gh repo delete acme/site --yes")'`,
    ],
    [
      "an argv list",
      `node -e 'require("child_process").spawnSync("gh", ["repo", "delete", "acme/site"])'`,
    ],
    [
      "an argv list held in a variable",
      `node -e 'const a = ["repo", "delete", "x"]; require("child_process").execFileSync("gh", a)'`,
    ],
    [
      "an argv list split across lines of a script on standard input",
      [
        "node <<'NODE'",
        'const { spawnSync } = require("node:child_process");',
        'spawnSync("vercel", [',
        '  "remove", "my-app", "--yes",',
        "]);",
        "NODE",
      ].join("\n"),
    ],
    [
      "a Python argv list",
      `python3 -c 'import subprocess; subprocess.run(["fly", "apps", "destroy", "api"])'`,
    ],
    ["the service's API host", "curl -X DELETE https://api.stripe.com/v1/customers/cus_1 -u $KEY:"],
    ["the service's bare host", "curl -X DELETE https://fly.io/api/v1/apps/api"],
    ["a colon-joined verb", "firebase hosting:disable --project acme"],
    ["a name that is also an English word", "render services delete srv-123"],
    ["another", "stripe customers delete cus_1"],
  ];
  for (const [why, command] of reached) {
    test(`${why}: ${command.replace(/\n/g, " ⏎ ").slice(0, 90)}`, () => {
      expect(isRemoteMutationCommand(command)).toBe(true);
      expect(assessActionRisk(bash(command))).toBe("high");
    });
  }

  test("with no reviewer to ask, such a command is still withheld", () => {
    const outcome = routeContainment({
      action: bash("gh repo delete acme/site --yes"),
      osIsolation: true,
      injectionSuspected: false,
    });
    expect({ kind: outcome.kind, route: outcome.route }).toEqual({
      kind: "defer",
      route: "remote-mutation",
    });
  });
});

describe("a service's name used as a word is not a command that runs it", () => {
  test("the recorded page check is ordinary shell, not a remote deletion", () => {
    expect(isRemoteMutationCommand(RECORDED_PAGE_CHECK)).toBe(false);
    expect(assessActionRisk(bash(RECORDED_PAGE_CHECK))).toBe("medium");
  });

  // The other reader of the same predicate. Before this change a reviewer that
  // could not be reached had this script withheld as a deletion "outside this
  // machine" — a page's own test, refused for a word it printed.
  test("and with no reviewer to ask, it is not withheld as one", () => {
    const outcome = routeContainment({
      action: bash(RECORDED_PAGE_CHECK),
      osIsolation: true,
      injectionSuspected: false,
    });
    expect(outcome.route).not.toBe("remote-mutation");
  });

  const words: Array<[string, string]> = [
    ["a word in a printed sentence", "node -e 'console.log(\"render, then remove the node\")'"],
    ["a method call", "node -e 'app.render(el); el.remove()'"],
    ["a function call", "node -e 'render(list); list.forEach((x) => delete cache[x])'"],
    ["an object key", "node -e 'const view = { render: draw, remove: drop }; view.remove()'"],
    [
      "a destructured import",
      "node -e 'const { render } = require(\"./view\"); delete globalThis.x'",
    ],
    ["an SDK's property", "node -e 'await supabase.from(\"t\").delete(); firebase.auth()'"],
    ["a file named after it", "echo 'remove stale snapshots' && bun test tests/render.test.ts"],
    ["a longer name that starts with it", "npm remove supabase-js stripe-node"],
    ["a scoped package", "npm remove @vercel/analytics"],
    ["a package that shares the name", "npm remove firebase"],
    ["a hyphenated word", "grep -rn 'pre-render' src && rm -rf .cache # drop the cache"],
    ["a page on some other host", "curl -s https://example.com/docs/render.html | grep -c delete"],
  ];
  for (const [why, command] of words) {
    test(`${why}: ${command.slice(0, 90)}`, () => {
      expect(isRemoteMutationCommand(command)).toBe(false);
    });
  }
});

describe("a word that is a whole path segment of an address is not an outbound payload", () => {
  const reads: Array<[string, Record<string, unknown>]> = [
    [
      "the recorded fetch",
      { url: "https://rows.com/blog/post/ecommerce-dashboard", maxBytes: 25000 },
    ],
    ["a data directory", { url: "https://example.com/data/2026/revenue.csv" }],
    ["a content tree", { url: "https://docs.example.com/content/guides/install" }],
    ["an uploads folder", { url: "https://example.com/uploads/2026/10/hero.png" }],
    ["the last segment", { url: "https://example.com/api/v2/data" }],
    [
      "an address inside a sentence",
      { prompt: "Summarise https://example.com/blog/post, briefly." },
    ],
  ];
  for (const [why, args] of reads) {
    test(`${why}: ${JSON.stringify(args).slice(0, 80)}`, () => {
      expect(assessActionRisk(fetchOf(args))).toBe("medium");
    });
  }

  const sends: Array<[string, Record<string, unknown>]> = [
    ["a body key beside such an address", { url: "https://example.com/blog/post/1", body: "x" }],
    ["a payload key", { url: "https://telemetry.example.net/collect", payload: { repo: "a/b" } }],
    ["the word in the query string", { url: "https://collector.invalid/x?data=AKIA" }],
    ["the word after a fragment mark", { url: "https://collector.invalid/x#data=AKIA" }],
    // The same word in the shape of a path segment, but past the `?` and the
    // `#`: only the path is where a page lives.
    [
      "a path-shaped value in the query string",
      { url: "https://collector.invalid/x?to=/srv/data" },
    ],
    ["a path-shaped value after a fragment mark", { url: "https://collector.invalid/x#/srv/data" }],
    ["the instance-metadata path", { url: "http://169.254.169.254/latest/meta-data/iam/" }],
    ["a hyphenated segment", { url: "https://example.com/wp-content/x" }],
    ["the word in a value that is not an address", { note: "contents of src/secrets.ts" }],
    ["the word in a path that is not an address", { path: "/var/data/export.sql", to: "remote" }],
  ];
  for (const [why, args] of sends) {
    test(`still high — ${why}: ${JSON.stringify(args).slice(0, 80)}`, () => {
      expect(assessActionRisk(fetchOf(args))).toBe("high");
    });
  }
});
