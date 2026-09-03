// ─── Chart — line and bar, drawn by hand in SVG ───
//
// No charting library. Three reasons, in order of weight: a library ships its
// own colour system and the brand checklist allows exactly one chromatic hue
// outside the three status colours; a library ships its own radii, shadows and
// tooltips, which is a second design system arriving through a dependency; and
// a task surface needs two chart forms, not forty.
//
// The dataviz rules this follows:
//   • the grid is FAINT — a hairline at the token, never ink; it is scaffolding
//   • the last point is EMPHASIZED — a filled dot and its value in text, because
//     "where did it end up" is the question a person actually has
//   • every figure is tabular — axis labels and the endpoint readout align
//   • one series, one accent. A second series would need a second hue, and the
//     honest answer to "I have five series" is a Table.
//   • no tooltip. A hover-only fact is a fact nobody printed.
//
// The axis is drawn from the data, so a model cannot supply a y-range that
// flatters its own numbers.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const ChartPointSchema = z.strictObject({
  x: z.string().max(40),
  y: z.number(),
});

export const ChartSchema = z.strictObject({
  ...baseProps,
  form: z.enum(["line", "bar"]),
  points: z.array(ChartPointSchema).max(200),
  unit: z.string().max(16).optional(),
  /** A horizontal reference line: a budget, an SLO, the value before a change. */
  baseline: z.number().optional(),
  baselineLabel: z.string().max(40).optional(),
  /** Bars/points at or above this read in the caution colour. */
  threshold: z.number().optional(),
  caption: z.string().max(200).optional(),
});
export type ChartProps = z.infer<typeof ChartSchema>;

const W = 520;
const H = 132;
const PAD = { top: 10, right: 46, bottom: 20, left: 8 };

function niceTicks(min: number, max: number): number[] {
  if (max === min) return [min];
  const raw = (max - min) / 3;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

export function Chart(props: ChartProps) {
  const pts = props.points;
  const ys = pts.map((p) => p.y);
  const extra = [props.baseline, props.threshold].filter((v): v is number => v !== undefined);
  const lo = Math.min(0, ...ys, ...extra);
  const hi = Math.max(...ys, ...extra, lo + 1);
  const pad = (hi - lo) * 0.12;
  const yMin = props.form === "bar" ? Math.min(0, lo) : lo - pad;
  const yMax = hi + pad;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  // A line's points sit ON the axis, edge to edge; a bar sits in the MIDDLE of
  // its band. Sharing one scale is what puts half the first bar off the left of
  // the plot, which is a bug you only see once there is a bar chart on a page.
  const band = plotW / Math.max(pts.length, 1);
  const xAt = (i: number) =>
    props.form === "bar"
      ? PAD.left + (i + 0.5) * band
      : PAD.left + (pts.length <= 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
  const yAt = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const last = pts[pts.length - 1];
  const ticks = niceTicks(yMin, yMax);

  return (
    <Frame
      kind={`p-chart form-${props.form}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={pts.length === 0}
      emptyText="No series yet."
      skeleton={3}
    >
      <svg
        className="p-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${props.form} chart${props.label ? `: ${props.label}` : ""}. ${pts
          .map((p) => `${p.x} ${p.y}${props.unit ?? ""}`)
          .join(", ")}`}
        preserveAspectRatio="none"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="p-chart-grid"
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yAt(t)}
              y2={yAt(t)}
            />
            <text className="p-chart-tick" x={W - PAD.right + 6} y={yAt(t) + 3.5}>
              {t.toLocaleString("en-US")}
            </text>
          </g>
        ))}

        {props.baseline !== undefined ? (
          <line
            className="p-chart-baseline"
            x1={PAD.left}
            x2={W - PAD.right}
            y1={yAt(props.baseline)}
            y2={yAt(props.baseline)}
          />
        ) : null}

        {props.form === "bar"
          ? pts.map((p, i) => {
              // Capped as well as proportional. The SVG is stretched to the
              // block's width (`preserveAspectRatio="none"`), so a three-bar
              // chart at 56% of its band draws three blocks rather than three
              // bars, and a bar wider than it is tall stops reading as a bar.
              const bw = Math.min(26, Math.max(3, band * 0.42));
              const y = yAt(p.y);
              const zero = yAt(Math.max(yMin, 0));
              const over = props.threshold !== undefined && p.y >= props.threshold;
              return (
                <rect
                  key={`${p.x}-${i}`}
                  className={`p-chart-bar ${over ? "over" : ""}`}
                  x={xAt(i) - bw / 2}
                  y={Math.min(y, zero)}
                  width={bw}
                  height={Math.max(1, Math.abs(zero - y))}
                  rx="1"
                />
              );
            })
          : null}

        {props.form === "line" && pts.length > 1 ? (
          <polyline
            className="p-chart-line"
            points={pts.map((p, i) => `${xAt(i)},${yAt(p.y)}`).join(" ")}
          />
        ) : null}

        {props.form === "line" && last ? (
          <circle className="p-chart-end" cx={xAt(pts.length - 1)} cy={yAt(last.y)} r="3.25" />
        ) : null}

        {/* A line has two axis labels — where it started and where it ended.
            A bar chart's x is categorical, and a category with no name on it is
            a rectangle. */}
        {props.form === "bar"
          ? pts.map((p, i) => (
              <text className="p-chart-axis mid" key={`${p.x}-label-${i}`} x={xAt(i)} y={H - 5}>
                {p.x}
              </text>
            ))
          : pts.length > 0 && (
              <>
                <text className="p-chart-axis" x={PAD.left} y={H - 5}>
                  {pts[0]!.x}
                </text>
                {pts.length > 1 ? (
                  <text className="p-chart-axis end" x={W - PAD.right} y={H - 5}>
                    {last!.x}
                  </text>
                ) : null}
              </>
            )}
      </svg>

      <div className="p-chart-foot">
        {last ? (
          <span className="p-chart-readout">
            {last.x} <b>{last.y.toLocaleString("en-US")}</b>
            {props.unit ? <span className="p-chart-unit">{props.unit}</span> : null}
          </span>
        ) : null}
        {props.baseline !== undefined ? (
          <span className="p-chart-legend">
            {props.baselineLabel ?? "baseline"} {props.baseline.toLocaleString("en-US")}
            {props.unit ?? ""}
          </span>
        ) : null}
        {props.caption ? <span className="p-chart-caption">{props.caption}</span> : null}
      </div>
    </Frame>
  );
}
