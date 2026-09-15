// ─── The capture rig hands the child no credential ───
//
// Promoted from tests/verification/v6-p4b-capture-scrub-shape-incomplete.ts
// (V6 finding 23).
//
// `scripts/tui-capture/capture.py` drives the real CLI under a pty to take the
// frames the reports are read from, and its docstring promises the child gets
// no key. The promise was kept by a roster of ten provider names, then by a
// roster of two SUFFIXES — and the registry already held a provider that
// matched neither (`SCW_SECRET_KEY`), while bedrock and vertex authenticate
// from the machine's AWS/GCP credential chain, whose variables end in no secret
// suffix at all. The rig's own `assert not leaked` guard used the same two
// suffixes, so it could not see its own blind spot.
//
// The rule is now a stated predicate — secret suffixes, the documented chain
// variables, and every `envVar` the registries declare, read from their source
// rather than retyped — and this test asks the rig's own predicate about the
// names the registries declare TODAY. A preset added tomorrow is covered by the
// rig; a suffix or chain variable that stops being covered fails here.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";
import { keyedSearchPresets } from "../../../packages/shared/src/search-providers";

const repo = join(import.meta.dir, "../../..");

/** Ask the rig itself which of these names it would scrub. */
function scrubbedByTheRig(names: string[]): string[] {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(repo, "scripts/tui-capture"))})
import capture
print(json.dumps(capture.secret_names({n: "x" for n in json.loads(sys.argv[1])})))
`;
  const run = spawnSync("python3", ["-c", script, JSON.stringify(names)], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`capture.py would not load: ${run.stderr}`);
  return JSON.parse(run.stdout) as string[];
}

test("every envVar the provider and search registries declare is credential-shaped to the rig", () => {
  const declared = new Set<string>();
  for (const preset of PROVIDER_PRESETS as unknown as { envVar?: string }[])
    if (preset.envVar) declared.add(preset.envVar);
  for (const preset of keyedSearchPresets() as unknown as { envVar?: string }[])
    if (preset.envVar) declared.add(preset.envVar);
  expect(declared.size).toBeGreaterThan(20);
  const names = [...declared].sort();
  expect(scrubbedByTheRig(names)).toEqual(names);
});

test("the AWS and GCP credential chains bedrock and vertex authenticate from are scrubbed", () => {
  // provider-registry.ts: "AWS signs each request from the machine's own
  // credential chain"; VertexProvider reads the ambient GCP credentials.
  const chain = [
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ];
  expect(scrubbedByTheRig(chain)).toEqual(chain);
});

test("a credential-shaped name nobody has declared yet is scrubbed too", () => {
  const invented = [
    "SOMEHOST_API_KEY",
    "SOMEHOST_TOKEN",
    "SOMEHOST_SECRET",
    "SOMEHOST_PASSWORD",
    "SOMEHOST_CREDENTIALS",
    "SOMEHOST_AUTH",
  ].sort();
  expect(scrubbedByTheRig(invented)).toEqual(invented);
});

test("the rig's own variables survive, or the scrub is what breaks the capture", () => {
  const rigOwn = ["RUNE_HOME", "TERM", "LANG", "RUNE_TOOLS_BIN", "RUNE_TOOLS_BINARY"];
  expect(scrubbedByTheRig(rigOwn)).toEqual([]);
  // Not credentials, and not the rig's: a capture still needs an inherited PATH.
  expect(scrubbedByTheRig(["PATH", "HOME", "COLUMNS", "RUNE_WORKSPACE"])).toEqual([]);
});
