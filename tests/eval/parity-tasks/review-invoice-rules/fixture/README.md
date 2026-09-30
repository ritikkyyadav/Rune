# invoice

Invoice arithmetic for the billing service. `invoice.ts` has to follow these rules.

## Rules

1. Every amount is an integer number of cents.
2. A line's quantity is a whole number, at least 1. Any other quantity is an error.
3. A line's total is its quantity times its unit price, and the subtotal is the sum of the line
   totals.
4. A discount is a percentage of the subtotal, from 0 to 100. The discount amount is rounded half
   up to the nearest cent, and the discounted subtotal is the subtotal less that amount.
5. Tax is charged on the discounted subtotal, at a rate in basis points (825 is 8.25%), rounded
   half up to the nearest cent.
6. The total is the discounted subtotal plus tax.
7. An amount is shown in dollars with a thousands separator and two decimals, `$1,234.05`. A
   negative amount, such as a refund, is shown as `-$1.05`.

## Development

```sh
bun test
```
