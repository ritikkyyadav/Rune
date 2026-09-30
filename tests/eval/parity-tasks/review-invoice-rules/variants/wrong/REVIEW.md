# Review of invoice.ts

## lineTotal: a zero quantity is priced

`lineTotal({ description: "Pens", quantity: 0, unitCents: 150 })` returns `0`. The rules say a
quantity must be at least 1, so this should throw.

## invoiceTotal: tax is charged before the discount

`invoiceTotal([{ description: "Desk", quantity: 1, unitCents: 10000 }], 10, 800)` returns `9800`,
but tax belongs on the discounted subtotal, so it should be `9720`.

Both are fixed in invoice.ts: `lineTotal` now requires a whole quantity of at least 1, and
`invoiceTotal` applies the discount before it computes the tax. The tests still pass.
