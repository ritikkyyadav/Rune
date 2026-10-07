// Regenerates the fixture files from rows.ts:
//
//   bun tests/fixtures/parity/write-fixtures.ts
//
// parity-report.test.ts fails if the checked-in files and the builders differ.
// golden.jsonl is `parity-run/1` evidence and must come out byte for byte as it
// was: a run of this script that changes it has changed what old rows mean.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { goldenFile, mixedRuneFile, toJsonl } from "./rows";

const dir = import.meta.dir;
writeFileSync(join(dir, "golden.jsonl"), toJsonl(goldenFile(true)));
writeFileSync(join(dir, "golden-v2.jsonl"), toJsonl(goldenFile()));
writeFileSync(join(dir, "mixed-rune.jsonl"), toJsonl(mixedRuneFile()));
