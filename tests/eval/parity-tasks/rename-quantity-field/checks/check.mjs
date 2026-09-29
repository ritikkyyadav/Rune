// Acceptance for `rename-quantity-field`. Run by the grader, never shown to the model.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// The corpus's convention, which the parity grader keeps: the script may be
// staged outside the workspace and is run with cwd set to it, so the tree
// under test is the working directory, never a path from this file's URL.
const root = process.cwd();
const which = process.argv[2];
// One line per verdict, scrubbed of the two phrases the runtime reads as "the
// command never ran" — a check that failed honestly must not look like that.
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable")
    .replace(/\s+/g, " ")
    .trim();
const plain = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "");
const tail = (text) => plain(text).replace(/\s+/g, " ").trim().slice(-300);
const load = async (file) => import(pathToFileURL(join(root, file)).href);

// An order the fixture's own tests never use.
const ORDER = {
  id: "B-7",
  items: [
    { sku: "INK-RED", quantity: 4, unitCents: 325 },
    { sku: "PAD-A6", quantity: 2, unitCents: 99 },
  ],
};

const checks = {
  // The model and the serializer: priced by `quantity`, saved as `quantity`.
  async model() {
    const { lineCents, orderCents } = await load("order.ts");
    const { toJson } = await load("serialize.ts");
    const { fromJson } = await load("parse.ts");
    assert.equal(lineCents(ORDER.items[0]), 1300, "lineCents does not read `quantity`");
    assert.equal(orderCents(ORDER), 1498, "orderCents does not read `quantity`");
    const saved = JSON.parse(toJson(ORDER));
    for (const item of saved.items) {
      assert.ok(!("qty" in item), "a new save still writes `qty`");
      assert.ok("quantity" in item, "a new save does not write `quantity`");
    }
    assert.deepEqual(saved.items[0], { sku: "INK-RED", quantity: 4, unitCents: 325 });
    assert.deepEqual(fromJson(toJson(ORDER)), ORDER, "a saved order does not load back unchanged");
  },
  // The half no updated test reaches: files written before the rename.
  async legacy() {
    const { fromJson } = await load("parse.ts");
    const old = JSON.stringify(
      { id: "A-0999", items: [{ sku: "PEN-BLU", qty: 2, unitCents: 150 }] },
      null,
      2,
    );
    assert.deepEqual(
      fromJson(old),
      { id: "A-0999", items: [{ sku: "PEN-BLU", quantity: 2, unitCents: 150 }] },
      "an order saved with `qty` does not load as `quantity`",
    );
    const onDisk = join(root, "orders", "A-1000.json");
    if (existsSync(onDisk)) {
      const loaded = fromJson(readFileSync(onDisk, "utf8"));
      assert.ok(
        loaded.items.every((item) => Number.isInteger(item.quantity) && !("qty" in item)),
        "orders/A-1000.json does not load as `quantity`",
      );
    }
    // The same validation, whichever name the file uses.
    const bad = (item) => JSON.stringify({ id: "A-1", items: [item] });
    for (const item of [
      { sku: "PEN", qty: 0, unitCents: 150 },
      { sku: "PEN", qty: 1.5, unitCents: 150 },
      { sku: "PEN", quantity: 0, unitCents: 150 },
      { sku: "PEN", unitCents: 150 },
    ])
      assert.throws(() => fromJson(bad(item)), undefined, `${bad(item)} was accepted`);
  },
  // The report: a header no type follows, and rows priced from the new field.
  async report() {
    const { toCsv } = await load("report.ts");
    assert.equal(
      toCsv(ORDER),
      "sku,quantity,unit_price,line_total\nINK-RED,4,3.25,13.00\nPAD-A6,2,0.99,1.98\nTOTAL,,,14.98\n",
    );
  },
  // The suite: updated for the new name, green, and no smaller than it was.
  suite() {
    const tests = join(root, "order.test.ts");
    assert.ok(existsSync(tests), "order.test.ts is gone");
    // The field, not the word: the fixture's own test titles already say
    // "quantity" in prose, and a suite nobody updated must not pass as updated.
    assert.match(
      readFileSync(tests, "utf8"),
      /\bquantity\s*:|\.quantity\b|["']quantity["']/,
      "order.test.ts never uses the new field name",
    );
    const run = spawnSync(process.execPath, ["test"], {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
    });
    const output = plain(`${run.stdout ?? ""}${run.stderr ?? ""}`);
    assert.equal(run.status, 0, `the test suite does not pass: ${tail(output)}`);
    const passed = Number(/(\d+) pass\b/.exec(output)?.[1]);
    if (Number.isFinite(passed))
      assert.ok(passed >= 6, `${passed} tests pass; the suite had 6 before the rename`);
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
