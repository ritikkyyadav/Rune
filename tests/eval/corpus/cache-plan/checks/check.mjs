// Acceptance for `cache-plan`. Run by the runtime, never shown to the model.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

// The acceptance script is STAGED OUTSIDE the workspace and run with cwd set
// to the workspace (see rune-cli's --acceptance help). A path resolved from
// import.meta.url would point at the staging directory, not at the tree under
// test, so the tree is addressed through the working directory.
const root = process.cwd();
const which = process.argv[2];
const SOURCE_SHA256 = "117791f1b331e4f22d95962d866d10cef4b159b16b045135f0ebecf465460c58";
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");

// A step is a numbered heading ("## Step 1", "### 2") OR a top-level numbered
// list item ("1. …", "2) …"). The heading-only reading failed every plan both
// agents wrote in the 2026-09-28 series — each a plain numbered list with a file
// and a check per step — so it measured markdown dialect, not the plan
// (README Changes, 2026-09-28).
const STEP = /^ {0,3}(?:#{1,6}[ \t]*(?:step[ \t]*)?\d+\b|(?:step[ \t]*)?\d+[.)][ \t])/im;
// The risks section's header: a heading, a bold label, or a "Risks:" line.
// Only header-shaped lines count, so a sentence that begins "Risks are…"
// inside a step does not cut the plan short.
const RISKS = /^ {0,3}(?:#{1,6}[ \t]*risks?\b|(?:\*\*|__)risks?\b|risks?[ \t]*:)/im;

const checks = {
  // Three steps, each naming a file it touches and how it will be checked.
  // Whether the plan is GOOD is a person's judgement; this is its shape.
  // Steps are counted BEFORE the risks section, so a numbered list of risks
  // cannot pad a two-step plan to three.
  steps() {
    const text = readFileSync(join(root, "PLAN.md"), "utf8");
    const risksAt = text.search(RISKS);
    const body = risksAt >= 0 ? text.slice(0, risksAt) : text;
    const steps = body.split(STEP).slice(1);
    assert.ok(steps.length >= 3, `the plan has ${steps.length} numbered steps, fewer than three`);
    steps.forEach((step, index) => {
      assert.match(
        step,
        /[\w./-]+\.(?:ts|tsx|js|mjs|json|md)\b/i,
        `step ${index + 1} names no file`,
      );
      assert.match(
        step,
        /verif|test|check|measur/i,
        `step ${index + 1} says nothing about verification`,
      );
    });
  },
  // What the plan must DECIDE, not how it is shaped.
  //
  // `steps` is a shape check, and the omission arm — "expiry and single-flight
  // are never planned" — was caught by it only because that arm also stopped at
  // two steps. A plan padded to three well-shaped steps with the same omission
  // passed both criteria, so this row measured step COUNT and reported it as an
  // omission caught (V6 finding 20). A response cache has to say when an entry
  // stops being usable and what two concurrent misses do; the prompt also asks
  // for the risks at the end. Those are the task's content, and they are named
  // here rather than left to a reader's judgement.
  covers() {
    const text = readFileSync(join(root, "PLAN.md"), "utf8");
    assert.match(
      text,
      /expir|evict|stale|max ?age|ttl|invalidat/i,
      "the plan never says when a cached entry stops being used",
    );
    assert.match(
      text,
      /single[- ]?flight|in[- ]?flight|concurrent|share a request|dedup/i,
      "the plan never says what two concurrent misses for one URL do",
    );
    // The section must SAY something: "Risks: an unbounded map leaks" counts,
    // a bare "## Risks" with nothing after it does not.
    const risksAt = text.search(RISKS);
    const section = risksAt >= 0 ? text.slice(risksAt) : "";
    const content = section
      .replace(RISKS, "")
      .replace(/^[\s:*_—-]+/, "")
      .split(/^ {0,3}#{1,6}\s/m)[0];
    assert.ok(
      content.trim().length > 0,
      "the plan has no risks section, which the prompt asks for at the end",
    );
  },
  sourceUntouched() {
    const digest = createHash("sha256")
      .update(readFileSync(join(root, "fetcher.ts")))
      .digest("hex");
    assert.equal(digest, SOURCE_SHA256, "fetcher.ts was modified by a task that asked for a plan");
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
