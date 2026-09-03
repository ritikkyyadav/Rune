// ─── Relationship — a small graph, laid out deterministically ───
//
// "Small" is the contract: up to twelve nodes, and the layout is a function of
// the data rather than a simulation, so the same graph draws identically on
// every render, in every screenshot, on every machine. A force-directed layout
// that settles differently each time is a diagram nobody can point at in a
// review.
//
// Nodes are placed on concentric rings by `depth` — the root at the centre, its
// neighbours around it — which is the shape a dependency, a call path or a data
// flow actually has. Edges are hairlines; direction is an arrowhead, not a
// colour; the focus node is the only one carrying the accent.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const RelationshipSchema = z.strictObject({
  ...baseProps,
  nodes: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(60),
        name: z.string().min(1).max(60),
        /** 0 is the centre; 1 and 2 are the rings around it. */
        ring: z.number().int().min(0).max(2),
        focus: z.boolean().optional(),
        tone: z.enum(["neutral", "ok", "caution", "danger"]).optional(),
      }),
    )
    .max(12),
  edges: z
    .array(
      z.strictObject({
        from: z.string().max(60),
        to: z.string().max(60),
        label: z.string().max(40).optional(),
      }),
    )
    .max(30),
  caption: z.string().max(200).optional(),
});
export type RelationshipProps = z.infer<typeof RelationshipSchema>;

const W = 460;
const H = 240;
const CX = W / 2;
const CY = H / 2;
const RING = [0, 74, 112];

/** Deterministic polar placement: ring by depth, angle by index within the ring. */
function layout(nodes: RelationshipProps["nodes"]): Map<string, { x: number; y: number }> {
  const byRing = new Map<number, string[]>();
  for (const n of nodes) byRing.set(n.ring, [...(byRing.get(n.ring) ?? []), n.id]);
  const out = new Map<string, { x: number; y: number }>();
  for (const [ring, ids] of byRing) {
    const r = RING[ring] ?? RING[2]!;
    ids.forEach((id, i) => {
      if (r === 0) {
        out.set(id, { x: CX, y: CY });
        return;
      }
      const angle = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
      out.set(id, { x: CX + Math.cos(angle) * r * 1.55, y: CY + Math.sin(angle) * r * 0.78 });
    });
  }
  return out;
}

export function Relationship(props: RelationshipProps) {
  const pos = layout(props.nodes);
  return (
    <Frame
      kind="p-relationship"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.nodes.length === 0}
      emptyText="No relationships mapped."
      skeleton={3}
    >
      <svg
        className="p-rel-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${props.nodes.length} nodes: ${props.edges
          .map((e) => `${e.from} to ${e.to}`)
          .join("; ")}`}
      >
        <defs>
          <marker
            id="p-rel-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 1 L9 5 L0 9 z" className="p-rel-arrowhead" />
          </marker>
        </defs>
        {props.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          return (
            <g key={i}>
              <line
                className="p-rel-edge"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                markerEnd="url(#p-rel-arrow)"
              />
              {e.label ? (
                <text className="p-rel-edgelabel" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4}>
                  {e.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {props.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const w = Math.max(58, n.name.length * 6.4 + 16);
          return (
            <g
              key={n.id}
              className={`p-rel-node ${n.focus ? "focus" : ""} tone-${n.tone ?? "neutral"}`}
            >
              <rect x={p.x - w / 2} y={p.y - 12} width={w} height={24} rx="6" />
              <text x={p.x} y={p.y + 4}>
                {n.name}
              </text>
            </g>
          );
        })}
      </svg>
      {props.caption ? <p className="p-rel-caption">{props.caption}</p> : null}
    </Frame>
  );
}
