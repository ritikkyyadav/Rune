// Acceptance for `explain-quote-handling`. Run by the runtime, never shown to the model.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];
const SOURCE_SHA256 = "c439756c35a2c9b5bcdf9a8b90de5bde5861122eb0a5d689a45326e3153493db";
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");

const checks = {
  // An explanation can only be checked for the subjects it was asked to cover.
  // Whether the prose is RIGHT is a person's judgement, and this criterion does
  // not claim otherwise.
  subjects() {
    const text = readFileSync(join(root, "ANSWER.md"), "utf8");
    assert.ok(text.trim().length > 200, "the answer is too short to be an explanation");
    for (const [label, pattern] of [
      ["the doubled-quote rule", /doubl\w* quote|two quotes|""/i],
      ["a newline inside a quoted field", /crlf|\\r\\n|newline inside|inside quotes/i],
      ["the leading BOM", /bom|u\+feff|feff/i],
    ])
      assert.match(text, pattern, `the answer never addresses ${label}`);
  },
  sourceUntouched() {
    const digest = createHash("sha256")
      .update(readFileSync(join(root, "csv.ts")))
      .digest("hex");
    assert.equal(
      digest,
      SOURCE_SHA256,
      "csv.ts was modified by a task that asked for no code change",
    );
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
