// ─── Table — rows of facts, aligned so they can be compared ───
//
// Columns declare their own alignment and whether they are numeric, because
// alignment is the whole reason a table beats a list: numbers right, tabular
// figures, and a monospace column for paths and ids. A model that hands this a
// column of numbers as strings still gets them right-aligned, because the
// column says so and the cell does not get a vote.
//
// A real <table> with a real <thead>: a grid of divs is unreadable to a screen
// reader and unselectable in three of four browsers.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const TableColumnSchema = z.strictObject({
  key: z.string().min(1).max(60),
  header: z.string().max(80),
  align: z.enum(["left", "right"]).optional(),
  /** Paths, ids, hashes — set in Geist Mono at the small step. */
  mono: z.boolean().optional(),
  /** Quiet column: timestamps, counts nobody sorts by. */
  muted: z.boolean().optional(),
});

export const TableSchema = z.strictObject({
  ...baseProps,
  columns: z.array(TableColumnSchema).min(1).max(12),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(500),
  caption: z.string().max(200).optional(),
  /** A row key that reads as the current one, drawn with the accent rail. */
  highlight: z.string().max(120).optional(),
  /** Which column carries the row key matched against `highlight`. */
  keyColumn: z.string().max(60).optional(),
});
export type TableProps = z.infer<typeof TableSchema>;

function cellText(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return typeof v === "number" ? v.toLocaleString("en-US") : v;
}

export function Table(props: TableProps) {
  const keyCol = props.keyColumn ?? props.columns[0]!.key;
  return (
    <Frame
      kind="p-table"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.rows.length === 0}
      emptyText="No rows."
      skeleton={4}
    >
      <div className="p-table-scroll">
        <table>
          {props.caption ? <caption>{props.caption}</caption> : null}
          <thead>
            <tr>
              {props.columns.map((c) => (
                <th key={c.key} scope="col" className={c.align === "right" ? "num" : ""}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, i) => (
              <tr
                key={i}
                className={
                  props.highlight !== undefined && String(row[keyCol]) === props.highlight
                    ? "is-current"
                    : ""
                }
              >
                {props.columns.map((c) => (
                  <td
                    key={c.key}
                    className={[
                      c.align === "right" ? "num" : "",
                      c.mono ? "mono" : "",
                      c.muted ? "muted" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {cellText(row[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}
