// ─── Metric — one number, and what it moved from ───
//
// "Latency 182 → 487 ms" is the whole wireframe. A metric with no comparison is
// a number nobody can act on, so `from` is first-class and the delta is DERIVED
// rather than supplied: a model cannot hand this component a percentage that
// disagrees with the two values printed beside it.
//
// Direction is stated, never inferred from the sign — latency going up is bad,
// throughput going up is good, and the component has no way to know which. With
// `goodDirection` absent the change is reported without a verdict, which is the
// honest default for a number whose meaning nobody declared.

import { z } from "zod";
import { Frame, ToneWord, baseProps } from "./kit";

export const MetricSchema = z.strictObject({
  ...baseProps,
  name: z.string().max(80),
  value: z.union([z.number(), z.string()]),
  unit: z.string().max(16).optional(),
  from: z.union([z.number(), z.string()]).optional(),
  /** What an increase MEANS. Absent means no verdict. */
  goodDirection: z.enum(["up", "down"]).optional(),
  note: z.string().max(120).optional(),
});
export type MetricProps = z.infer<typeof MetricSchema>;

function delta(from: unknown, to: unknown): number | null {
  if (typeof from !== "number" || typeof to !== "number" || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

export function Metric(props: MetricProps) {
  const raw = props.from === undefined ? null : delta(props.from, props.value);
  // A change that rounds to 0.0% is not a change, and "0.0%" under a number is
  // a line of type that says nothing. `0.4 → 0.4` reports itself.
  const pct = raw !== null && Math.abs(raw) < 0.05 ? null : raw;
  const rose = pct !== null && pct > 0;
  const tone =
    pct === null || Math.abs(pct) < 0.5 || props.goodDirection === undefined
      ? "neutral"
      : rose === (props.goodDirection === "up")
        ? "ok"
        : "danger";

  return (
    <Frame
      kind="p-metric"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.value === ""}
      emptyText="No reading."
      skeleton={2}
      as="div"
    >
      <div className="p-metric-name">{props.name}</div>
      <div className="p-metric-row">
        {props.from !== undefined ? (
          <>
            <span className="p-metric-from">{props.from}</span>
            <span className="p-metric-arrow" aria-hidden>
              →
            </span>
          </>
        ) : null}
        <span className="p-metric-value">{props.value}</span>
        {props.unit ? <span className="p-metric-unit">{props.unit}</span> : null}
      </div>
      {pct !== null ? (
        <div className="p-metric-delta">
          <ToneWord tone={tone}>
            {rose ? "+" : ""}
            {pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%
          </ToneWord>
          {props.note ? <span className="p-metric-note">{props.note}</span> : null}
        </div>
      ) : props.note ? (
        <div className="p-metric-delta">
          <span className="p-metric-note">{props.note}</span>
        </div>
      ) : null}
    </Frame>
  );
}
