// ─── Tree — a hierarchy, drawn with guides rather than boxes ───
//
// Files, a module graph, a plan's sub-steps. The nesting is a flat list with a
// `depth` on each row: a nested prop shape means a model has to emit a
// recursive structure correctly to get anything on screen, and a flat list with
// a depth degrades to a list when it gets it wrong.
//
// Rows with children are <button>s that toggle; leaves are not focusable, which
// keeps a 200-row tree from being 200 tab stops.

import { useState } from "react";
import { z } from "zod";
import { Chevron, Frame, baseProps } from "./kit";

export const TreeNodeSchema = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  depth: z.number().int().nonnegative().max(12),
  kind: z.enum(["dir", "file", "symbol"]).optional(),
  meta: z.string().max(60).optional(),
  /** Drawn with the accent rail: the node the surface is about. */
  current: z.boolean().optional(),
});

export const TreeSchema = z.strictObject({
  ...baseProps,
  nodes: z.array(TreeNodeSchema).max(500),
});
export type TreeProps = z.infer<typeof TreeSchema>;

export function Tree(props: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const hasChildren = (i: number) => {
    const next = props.nodes[i + 1];
    return next !== undefined && next.depth > props.nodes[i]!.depth;
  };

  const visible: Array<{ node: z.infer<typeof TreeNodeSchema>; index: number }> = [];
  let hideBelow: number | null = null;
  props.nodes.forEach((node, i) => {
    if (hideBelow !== null && node.depth > hideBelow) return;
    hideBelow = null;
    visible.push({ node, index: i });
    if (collapsed.has(node.id)) hideBelow = node.depth;
  });

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Frame
      kind="p-tree"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.nodes.length === 0}
      emptyText="Nothing to show."
      skeleton={5}
    >
      <ul className="p-tree-list" role="tree">
        {visible.map(({ node, index }) => {
          const parent = hasChildren(index);
          const open = !collapsed.has(node.id);
          const inner = (
            <>
              {parent ? <Chevron open={open} /> : <span className="p-tree-spacer" aria-hidden />}
              <span className={`p-tree-name kind-${node.kind ?? "file"}`}>{node.name}</span>
              {node.meta ? <span className="p-tree-meta">{node.meta}</span> : null}
            </>
          );
          return (
            <li
              key={node.id}
              role="treeitem"
              aria-expanded={parent ? open : undefined}
              className={`p-tree-row ${node.current ? "is-current" : ""}`}
              style={{ paddingLeft: `${node.depth * 14}px` }}
            >
              {parent ? (
                <button type="button" className="p-tree-btn" onClick={() => toggle(node.id)}>
                  {inner}
                </button>
              ) : (
                <span className="p-tree-btn">{inner}</span>
              )}
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}
