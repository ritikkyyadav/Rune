// ─── Comparison — two or three options, on the same rows ───
//
// A table would do this, and does it badly: the question in a comparison is
// "which is better on THIS row", and a table answers "what does each cell say".
// So the rows carry a `better` marker naming the winning option, and the marker
// is a word, not a green cell.
//
// Three options maximum. A four-way comparison is a Table, and pretending
// otherwise gives you 60px columns.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const ComparisonSchema = z.strictObject({
  ...baseProps,
  /**
   * Two or three. The lower bound is not enforced: an empty list is the empty
   * state, and it is also what a composer puts in a block's static props before
   * the binding fills it. Four would need 60px columns, so the upper bound is.
   */
  options: z.array(z.strictObject({ id: z.string().max(60), name: z.string().max(120) })).max(3),
  rows: z
    .array(
      z.strictObject({
        criterion: z.string().min(1).max(160),
        /** Keyed by option id. */
        values: z.record(z.string(), z.string().max(300)),
        /** The option id that wins this row, if one does. */
        better: z.string().max(60).optional(),
      }),
    )
    .max(40),
  /** The option the agent recommends, if it has one. */
  recommend: z.string().max(60).optional(),
  because: z.string().max(400).optional(),
});
export type ComparisonProps = z.infer<typeof ComparisonSchema>;

export function Comparison(props: ComparisonProps) {
  return (
    <Frame
      kind="p-comparison"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.rows.length === 0}
      emptyText="Nothing compared yet."
      skeleton={4}
    >
      <div className="p-table-scroll">
        <table className="p-comp-table">
          <thead>
            <tr>
              <th scope="col" />
              {props.options.map((o) => (
                <th
                  key={o.id}
                  scope="col"
                  className={props.recommend === o.id ? "is-recommended" : ""}
                >
                  {o.name}
                  {props.recommend === o.id ? (
                    <span className="p-comp-rec">recommended</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{r.criterion}</th>
                {props.options.map((o) => (
                  <td key={o.id} className={r.better === o.id ? "is-better" : ""}>
                    {r.values[o.id] ?? "—"}
                    {r.better === o.id ? <span className="p-comp-better">better</span> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.because ? <p className="p-comp-because">{props.because}</p> : null}
    </Frame>
  );
}
