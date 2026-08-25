import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  hasHighConfidenceFinding,
  scanForInjection,
} from "../../../packages/orchestrator/src/security";

// The committed false-positive corpus (tests/fixtures/probe-corpus): the
// probe's real-world contract, pinned as files. `benign/` is content that
// historically risks false positives — credential vocabulary on code lines,
// security documentation, base64/eval mentions, role phrases in prose — and
// must NEVER clear the high-confidence bar that adds the security warning.
// `malicious/` is genuine steering and must ALWAYS clear it. Adding a file
// to either directory IS adding a regression test.

const CORPUS = join(import.meta.dir, "..", "..", "fixtures", "probe-corpus");

function corpusFiles(kind: "benign" | "malicious"): string[] {
  return readdirSync(join(CORPUS, kind)).sort();
}

describe("probe false-positive corpus", () => {
  test("fixture directories are populated", () => {
    expect(corpusFiles("benign").length).toBeGreaterThanOrEqual(10);
    expect(corpusFiles("malicious").length).toBeGreaterThanOrEqual(5);
  });

  for (const name of corpusFiles("benign")) {
    test(`benign/${name} never trips the high-confidence bar`, () => {
      const scan = scanForInjection(readFileSync(join(CORPUS, "benign", name), "utf8"));
      expect({ name, high: hasHighConfidenceFinding(scan), findings: scan.findings }).toEqual({
        name,
        high: false,
        findings: scan.findings, // echoed so a failure shows WHAT matched
      });
      expect(hasHighConfidenceFinding(scan)).toBe(false);
    });
  }

  for (const name of corpusFiles("malicious")) {
    test(`malicious/${name} always flags high`, () => {
      const scan = scanForInjection(readFileSync(join(CORPUS, "malicious", name), "utf8"));
      expect(hasHighConfidenceFinding(scan)).toBe(true);
    });
  }
});
