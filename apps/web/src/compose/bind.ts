// ─── Binding — how a block's props meet live state ───
//
// "A projection binds primitives to state paths, so the surface updates live as
// events arrive without re-composing." That sentence is this file.
//
// The composer runs ONCE per task-kind change. Everything after that is the
// renderer resolving `bind` paths against the current state on each render:
// a `hypothesis_updated` event that flips a hypothesis to `refuted` changes
// what the Hypothesis card says and whether it is folded, and no projection is
// recomputed, no block is added, no layout moves.
//
// Path resolution is deliberately dumb: split on ".", walk own properties, stop
// at anything that is not a plain object or array. It refuses `__proto__`,
// `prototype` and `constructor` at the schema AND here, because the schema
// guards the model's paths and this guards ours.

import type { AnyProps, PrimitiveEntry } from "../primitives";
import type { FoldPredicate, ProjectionBlock } from "./projection";

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/** Resolve a dotted path against a value. `undefined` for anything unreachable. */
export function resolvePath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    if (FORBIDDEN.has(segment)) return undefined;
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether a bound value counts as "nothing there". Drives the `empty` predicate. */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim().length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

/**
 * Evaluate a fold predicate against one bound value.
 *
 * There is no default-true case: an unknown predicate cannot arrive (the schema
 * is an enum) and `never` is spelled out, so every branch here is reachable and
 * every one of them is a rule somebody wrote down.
 */
export function shouldFold(predicate: FoldPredicate | undefined, value: unknown): boolean {
  if (predicate === undefined || predicate === "never") return false;
  if (predicate === "empty") return isEmptyValue(value);
  if (!isPlainObject(value)) return false;
  if (predicate === "refuted") return value.status === "refuted";
  if (predicate === "completed") return value.status === "completed" || value.status === "done";
  return value.resolution !== null && value.resolution !== undefined;
}

/**
 * One rendering of a block: the props to hand the component, and a key.
 *
 * A `repeat` block resolves to MANY renderings — one per element of the bound
 * array — which is why this returns a list rather than a props object. That is
 * what lets a projection composed when there was one hypothesis draw four of
 * them ten seconds later without being recomposed.
 */
export interface BoundRender {
  key: string;
  props: AnyProps;
  folded: boolean;
}

export function bindBlock(
  block: ProjectionBlock,
  entry: PrimitiveEntry,
  state: unknown,
): BoundRender[] {
  const own = block.props as AnyProps;
  if (block.bind === undefined || entry.bind.mode === "none") {
    return [{ key: block.id, props: own, folded: shouldFold(block.foldWhen, own) }];
  }

  const value = resolvePath(state, block.bind);

  if (entry.bind.mode === "repeat") {
    const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return items.map((item, i) => {
      const merged: AnyProps = isPlainObject(item)
        ? { ...own, ...item }
        : { ...own, [entry.bind.key ?? "value"]: item };
      // A repeated block is ONE labelled group, not n labelled blocks. The
      // block's label belongs to the first rendering; printing "Agents" above
      // every agent row is how a fleet of four reads as four fleets. A label
      // the ITEM carries is its own and survives.
      if (i > 0 && merged.label === own.label) delete merged.label;
      const folded = shouldFold(block.foldWhen, item);
      return {
        key: `${block.id}-${isPlainObject(item) && typeof item.id === "string" ? item.id : i}`,
        props: folded && entry.foldable ? { ...merged, folded: true } : merged,
        folded,
      };
    });
  }

  if (entry.bind.mode === "merge") {
    const props = isPlainObject(value) ? { ...own, ...value } : own;
    return [{ key: block.id, props, folded: shouldFold(block.foldWhen, value) }];
  }

  // assign
  const key = entry.bind.key;
  const props = key === undefined || value === undefined ? own : { ...own, [key]: value };
  const folded = shouldFold(block.foldWhen, value);
  return [
    {
      key: block.id,
      props: folded && entry.foldable ? { ...props, folded: true } : props,
      folded,
    },
  ];
}
