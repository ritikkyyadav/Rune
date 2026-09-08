// `rune --help` must not carry a hand-written provider list.
//
// The `-p` line said `anthropic|openai|openrouter|google|ollama-turbo|ollama`
// long after the roster reached 37 presets, so the installed binary's own help
// told people that thirty-one of their options did not exist. Rune has been
// bitten by a rotted hand-written provider list before — a sticky `codex` pick
// was rejected at boot by two of them — which is why `ProviderName` is an open
// type and `PROVIDER_PRESETS` is the one source.
//
// This spawns the real CLI, because the defect only exists in the string the
// binary prints.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";

const CLI = join(import.meta.dir, "../../../packages/orchestrator/src/bin/rune-cli.ts");

async function help(): Promise<string> {
  const p = Bun.spawn(["bun", CLI, "--help"], {
    env: { ...process.env, NO_COLOR: "1", RUNE_ASCII: "1", TERM: "dumb", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return out;
}

describe("rune --help, the -p line", () => {
  test("is derived from the registry, not restated", async () => {
    const line = (await help()).split("\n").find((l) => l.includes("-p, --provider"))!;
    expect(line).toBeDefined();

    // The stale union, verbatim. If it ever comes back, so does the rot.
    expect(line).not.toContain("ollama-turbo|ollama)");

    // It names real preset ids and says how many more there are, so the number
    // moves with the roster instead of being maintained by hand.
    const first = PROVIDER_PRESETS[0]!.id;
    expect(line).toContain(first);
    const more = Number(line.match(/and (\d+) more/)?.[1]);
    expect(Number.isFinite(more)).toBe(true);
    const named = line.match(/\(([^)]*?) and \d+ more/)?.[1]?.split("|").length ?? 0;
    expect(named + more).toBe(PROVIDER_PRESETS.length);

    // And it points at the command that prints the whole list.
    expect(line).toContain("rune providers");
  }, 30_000);
});
