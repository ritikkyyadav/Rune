# Review of invoice.ts

Checked against the rules in README.md. Three defects; `taxFor` and `formatCents` follow the rules.

## `lineTotal` prices quantities the rules refuse

Rule 2 makes a quantity a whole number of at least 1, and anything else an error. The guard only
refuses negative numbers, so zero and fractional quantities are priced.

- `lineTotal({ description: "Pens", quantity: 0, unitCents: 150 })` returns `0` now. The rules
  say it should throw, as a negative quantity already does.
- `lineTotal({ description: "Pens", quantity: 1.5, unitCents: 150 })` returns `225` now. It
  should throw too.

## `applyDiscount` rounds the discount down, not half up

Rule 4 rounds the discount amount half up to the nearest cent; `Math.floor` always rounds it down.

- `applyDiscount(1005, 10)` returns `905` now: the discount is 100.5 cents, floored to 100. Rounded
  half up it is 101, so the call should return `904`.

## `invoiceTotal` taxes the undiscounted subtotal

Rule 5 charges tax on the discounted subtotal, but `invoiceTotal` computes the tax from the
subtotal before the discount comes off.

- `invoiceTotal([{ description: "Desk", quantity: 1, unitCents: 10000 }], 10, 800)` returns `9800`
  now: 9000 after the discount plus 800 of tax on the full 10000. Tax on the discounted 9000 is
  720, so it should return `9720`.
