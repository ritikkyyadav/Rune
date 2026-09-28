// Regenerates golden.jsonl and mixed-rune.jsonl from rows.ts:
//
//   bun tests/fixtures/parity/write-fixtures.ts
//
// parity-report.test.ts fails if the checked-in files and the builders differ.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { goldenFile, mixedRuneFile, toJsonl } from "./rows";

const dir = import.meta.dir;
writeFileSync(join(dir, "golden.jsonl"), toJsonl(goldenFile()));
writeFileSync(join(dir, "mixed-rune.jsonl"), toJsonl(mixedRuneFile()));
