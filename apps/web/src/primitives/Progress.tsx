// ─── Progress — steps closed on evidence, over steps ───
//
// The percentage is NOT a guess and the primitive refuses to let it become one:
// `done` and `total` are counts, the ratio is computed here, and there is no
// prop that accepts a bare percentage. That is the whole point of the ledger —
// progress in this product means "steps with evidence over steps", and a model
// that wants to report 90% has to close nine steps.
//
// `total === 0` is not 0%; it is "no plan yet", which is a different sentence.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const ProgressSchema = z.strictObject({
  ...baseProps,
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** Steps closed WITHOUT a passing check — drawn as the unproven remainder. */
  unproven: z.number().int().nonnegative().optional(),
  /** What the RUN is doing, distinct from `state`, which is this block's load state. */
  runState: z.enum(["working", "waiting", "done", "failed"]).optional(),
  note: z.string().max(120).optional(),
});
export type ProgressProps = z.infer<typeof ProgressSchema>;

export function Progress(props: ProgressProps) {
  const total = props.total;
  const done = Math.min(props.done, total);
  const unproven = Math.min(props.unproven ?? 0, done);
  const proven = done - unproven;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const run = props.runState ?? (total > 0 && done === total ? "done" : "working");

  return (
    <Frame
      kind={`p-progress st-${run}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={total === 0}
      emptyText="No plan yet."
      skeleton={2}
      as="div"
    >
      <div className="p-progress-row">
        <div
          className="p-progress-track"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={props.label ?? "Progress"}
        >
          <span className="p-progress-fill" style={{ width: `${(proven / total) * 100}%` }} />
          {unproven > 0 ? (
            <span
              className="p-progress-fill unproven"
              style={{
                left: `${(proven / total) * 100}%`,
                width: `${(unproven / total) * 100}%`,
              }}
            />
          ) : null}
        </div>
        <span className="p-progress-pct">{pct}%</span>
      </div>
      <div className="p-progress-foot">
        <span className="p-progress-count">
          {done} of {total} steps
          {unproven > 0 ? ` · ${unproven} unproven` : ""}
        </span>
        {props.note ? <span className="p-progress-note">{props.note}</span> : null}
      </div>
    </Frame>
  );
}
