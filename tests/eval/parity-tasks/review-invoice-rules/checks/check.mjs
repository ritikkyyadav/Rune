// Acceptance for `review-invoice-rules`. Run by the grader, never shown to the model.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

// The corpus's convention, which the parity grader keeps: the script may be
// staged outside the workspace and is run with cwd set to it, so the tree
// under test is the working directory, never a path from this file's URL.
const root = process.cwd();
const which = process.argv[2];
// The code the review was asked about, as the fixture commits it.
const SOURCE_SHA256 = {
  "invoice.ts": "cf891c50587883f6057a675a74c7058d2c02cb0b07b785f97d4e824e974af574",
  "invoice.test.ts": "991801382fd3446914d83b4353b6b9b3e3ff641c68ef961d0a200ef8e0f05560",
};
// One line per verdict, scrubbed of the two phrases the runtime reads as "the
// command never ran" — a check that failed honestly must not look like that.
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable")
    .replace(/\s+/g, " ")
    .trim();

// ─── The code under review, and the rules, as one factory ───
//
// `fixed` names the defects repaired: none is invoice.ts exactly as the
// fixture ships it, all three is README.md's rules. The review is judged
// against these copies, not against the tree, so what the arm did to
// invoice.ts is `sourceUntouched`'s business and cannot move the other two.
const DEFECTS = {
  quantity: "lineTotal pricing a quantity the rules refuse (0, or a fraction)",
  rounding: "applyDiscount rounding the discount down instead of half up",
  taxBase: "invoiceTotal taxing the subtotal before the discount",
};

function build(fixed) {
  const lineTotal = (line) => {
    const refused = fixed.has("quantity")
      ? !Number.isInteger(line.quantity) || line.quantity < 1
      : line.quantity < 0;
    if (refused) throw new RangeError(`invalid quantity: ${line.quantity}`);
    return line.quantity * line.unitCents;
  };
  const applyDiscount = (subtotalCents, percent) => {
    if (percent < 0 || percent > 100) throw new RangeError(`invalid discount: ${percent}%`);
    const off = (subtotalCents * percent) / 100;
    return subtotalCents - (fixed.has("rounding") ? Math.round(off) : Math.floor(off));
  };
  const taxFor = (amountCents, rateBps) => {
    if (rateBps < 0) throw new RangeError(`invalid tax rate: ${rateBps}`);
    return Math.round((amountCents * rateBps) / 10_000);
  };
  const invoiceTotal = (lines, discountPercent, taxRateBps) => {
    const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
    const discounted = applyDiscount(subtotal, discountPercent);
    return discounted + taxFor(fixed.has("taxBase") ? discounted : subtotal, taxRateBps);
  };
  const formatCents = (cents) => {
    const sign = cents < 0 ? "-" : "";
    const abs = Math.abs(cents);
    const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
  };
  return { lineTotal, applyDiscount, taxFor, invoiceTotal, formatCents };
}

const GIVEN = build(new Set());
const RULES = build(new Set(Object.keys(DEFECTS)));
const ONLY = Object.fromEntries(Object.keys(DEFECTS).map((name) => [name, build(new Set([name]))]));

// ─── Reading the review's calls ───

/** The index of the bracket closing the one at `open`, or -1. Quotes are skipped. */
function closing(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length && i < open + 800; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return c === ")" ? i : -1;
  }
  return -1;
}

/** Where an expression starting at `start` ends: `;`, a line break or a code span's end, outside brackets. */
function expressionEnd(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length && i < start + 800; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && (c === ";" || c === "\n" || c === "`")) return i;
  }
  return -1;
}

// TypeScript a review may write around its values: `{ … } as Line`.
const untyped = (source) =>
  source.replace(/\s+(?:as|satisfies)\s+[A-Za-z_$][\w$.]*(?:<[^<>]*>)?(?:\[\])*/g, "");

/** Evaluate an expression as data: a fresh context holding only what the review declared. */
const evaluate = (source, scope) =>
  vm.runInNewContext(untyped(source), { ...scope }, { timeout: 100 });

/**
 * The values a review declares before it uses them — `const lines = [...]`,
 * typed or not — in order, each evaluated with the ones before it in scope.
 */
function declared(text) {
  const scope = Object.create(null);
  for (const match of text.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=(?!=)\s*/g,
  )) {
    const start = match.index + match[0].length;
    const end = expressionEnd(text, start);
    if (end < 0) continue;
    try {
      scope[match[1]] = evaluate(`(${text.slice(start, end)})`, scope);
    } catch {
      // Not data (a call, a reference to something undeclared): not a binding.
    }
  }
  return scope;
}

/**
 * Every call of one of invoice.ts's functions that the review writes out,
 * wherever it appears, with arguments that are data: literals, or values the
 * review declared. A call whose arguments cannot be evaluated — a signature
 * in a heading, a name never given a value — is not counted.
 */
function callsIn(text) {
  const scope = declared(text);
  const calls = [];
  for (const match of text.matchAll(
    /\b(lineTotal|applyDiscount|taxFor|invoiceTotal|formatCents)\s*\(/g,
  )) {
    const open = match.index + match[0].length - 1;
    const close = closing(text, open);
    if (close < 0) continue;
    let args;
    try {
      args = evaluate(`[${text.slice(open + 1, close)}]`, scope);
    } catch {
      continue;
    }
    calls.push({
      name: match[1],
      args,
      at: match.index,
      end: close + 1,
      source: text.slice(match.index, close + 1),
    });
  }
  return calls;
}

function outcome(impl, call) {
  try {
    return { threw: false, value: impl[call.name](...call.args) };
  } catch {
    return { threw: true };
  }
}
const same = (a, b) => a.threw === b.threw && (a.threw || Object.is(a.value, b.value));
const shows = (call, defect) => !same(outcome(GIVEN, call), outcome(ONLY[defect], call));
const said = (o) => (o.threw ? "that it throws" : JSON.stringify(o.value));

/**
 * Does the review state `expected` for this call — near it, in a sentence or
 * a table row around it, not counting the call's own arguments?
 */
function states(text, call, expected) {
  const near =
    `${text.slice(Math.max(0, call.at - 300), call.at)} ${text.slice(call.end, call.end + 400)}`.replace(
      /(\d),(?=\d{3}\b)/g,
      "$1",
    );
  if (expected.threw)
    return /\b(?:throws?|thrown|throwing|errors?|reject(?:s|ed)?|refuse[sd]?|invalid|RangeError)\b/i.test(
      near,
    );
  const value = expected.value;
  if (typeof value === "string") return near.includes(value);
  if (!Number.isFinite(value)) return false;
  const cents = new RegExp(`(?<![\\d.])${String(value).replace("-", "\\-")}(?![\\d])`);
  const dollars = new RegExp(
    `(?<![\\d.])\\$?${(value / 100).toFixed(2).replace(".", "\\.")}(?![\\d])`,
  );
  return cents.test(near) || dollars.test(near);
}

function review() {
  assert.ok(existsSync(join(root, "REVIEW.md")), "there is no REVIEW.md");
  const text = readFileSync(join(root, "REVIEW.md"), "utf8");
  assert.ok(text.trim().length > 100, "REVIEW.md is too short to be a review");
  return { text, calls: callsIn(text) };
}

const checks = {
  // Every planted defect is SHOWN: some call in the review comes out
  // differently once that defect, and only that defect, is repaired.
  found() {
    const { calls } = review();
    const missing = Object.keys(DEFECTS).filter(
      (defect) => !calls.some((call) => shows(call, defect)),
    );
    assert.deepEqual(
      missing.map((defect) => DEFECTS[defect]),
      [],
      `no call in REVIEW.md shows: ${missing.map((defect) => DEFECTS[defect]).join("; ")}`,
    );
  },
  // Every defect the review shows comes with what the rules make of the call:
  // the value the rules give, or that it throws. Repairing only the defect in
  // question is accepted too, for a call that also trips another one.
  expected() {
    const { text, calls } = review();
    let shown = 0;
    for (const defect of Object.keys(DEFECTS)) {
      const showing = calls.filter((call) => shows(call, defect));
      if (!showing.length) continue;
      shown += 1;
      const stated = showing.some(
        (call) =>
          states(text, call, outcome(RULES, call)) ||
          states(text, call, outcome(ONLY[defect], call)),
      );
      assert.ok(
        stated,
        `REVIEW.md shows ${DEFECTS[defect]} with ${showing[0].source} but never says it should return ${said(outcome(RULES, showing[0]))}`,
      );
    }
    assert.ok(
      shown > 0,
      "REVIEW.md shows none of the defects, so it states no result the rules give",
    );
  },
  // A review, not a fix: the code it reviewed is byte-identical.
  sourceUntouched() {
    for (const [file, expected] of Object.entries(SOURCE_SHA256)) {
      const digest = createHash("sha256")
        .update(readFileSync(join(root, file)))
        .digest("hex");
      assert.equal(digest, expected, `${file} was modified by a task that asked for a review`);
    }
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
