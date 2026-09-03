// ─── The renderer — a projection plus live state, on screen ───
//
// The composer runs once. This runs on every state change, and it is the reason
// a projection is a layout rather than a render: `bind` paths are resolved HERE,
// against the current state, so a `hypothesis_updated` event redraws one card
// and nothing else moves.
//
// Props are re-validated at render, not only at compose. That is not belt and
// braces: compose-time validation sees the block's STATIC props, and everything
// interesting arrives later through a binding. A malformed row from the wire
// renders that one block's error state with the reason on it, and the other
// nineteen blocks are unaffected — which is the difference between a surface
// that degrades and a surface that blanks.

import type { ReactNode } from "react";

import { PRIMITIVES, type AnyProps } from "../primitives";
import { bindBlock } from "./bind";
import { blocksOf, type Projection, type RegionName } from "./projection";

export interface ProjectionViewProps {
  projection: Projection;
  /** The live task state. Any shape; `bind` paths resolve against it. */
  state: unknown;
  /**
   * Callbacks for the interactive primitives, by block id. The projection can
   * describe an Approval; only the shell can answer one.
   */
  handlers?: Record<string, AnyProps>;
}

/** One block, bound and validated, possibly repeated over an array. */
function renderBlock(
  block: ReturnType<typeof blocksOf>[number],
  state: unknown,
  handlers: Record<string, AnyProps> | undefined,
): ReactNode[] {
  const entry = PRIMITIVES[block.type];
  // `hasOwnProperty`-guarded because a block id is a string that reached us
  // through a projection, and `handlers["constructor"]` on a plain object is a
  // function rather than the `undefined` this code reads it as. The id schema
  // refuses the prototype keys too; this is the lock nearest the door.
  const extra =
    handlers !== undefined && Object.prototype.hasOwnProperty.call(handlers, block.id)
      ? handlers[block.id]
      : undefined;
  return bindBlock(block, entry, state).map(({ key, props }) => {
    const merged: AnyProps = extra ? { ...props, ...extra } : props;
    const parsed = entry.schema.safeParse(merged);
    const Component = entry.Component;
    if (!parsed.success) {
      const reason = parsed.error.issues
        .slice(0, 2)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return (
        <Component
          key={key}
          {...({ state: "error", error: `${block.type}: ${reason}` } as AnyProps)}
        />
      );
    }
    // The callbacks are stripped by the schema parse (they are not props the
    // contract knows about), so they go back on afterwards.
    const safe = extra ? { ...(parsed.data as AnyProps), ...extra } : (parsed.data as AnyProps);
    return <Component key={key} {...safe} />;
  });
}

export function Region(props: {
  projection: Projection;
  state: unknown;
  region: RegionName;
  handlers?: Record<string, AnyProps>;
  className?: string;
}) {
  const blocks = blocksOf(props.projection, props.region);
  if (blocks.length === 0) return null;
  return (
    <div className={props.className ?? `region region-${props.region}`}>
      {blocks.flatMap((b) => renderBlock(b, props.state, props.handlers))}
    </div>
  );
}

/**
 * The whole surface: header, primary, an optional side, and the actions.
 *
 * The regions are a grid, not a component tree the model chose — P11.3 owns the
 * shell around this. What is here is the part that must be identical wherever a
 * projection is drawn.
 */
export function ProjectionView(props: ProjectionViewProps) {
  const hasSide = (props.projection.regions.side ?? []).length > 0;
  return (
    <div
      className={`surface ${hasSide ? "with-side" : ""}`}
      data-persona={props.projection.persona}
    >
      <Region {...props} region="header" className="surface-header" />
      <div className="surface-body">
        <Region {...props} region="primary" className="surface-primary" />
        {hasSide ? <Region {...props} region="side" className="surface-side" /> : null}
      </div>
      <Region {...props} region="actions" className="surface-actions" />
    </div>
  );
}
