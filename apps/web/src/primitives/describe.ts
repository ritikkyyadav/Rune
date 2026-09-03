// ─── Reading a prop schema back out, for the gallery ───
//
// The gallery shows each primitive's contract beside the primitive. It reads
// the ACTUAL zod schema rather than a hand-written table, because a hand-written
// table is a second source of truth that goes stale on the first prop anybody
// adds — and this page exists to be trusted at a glance.
//
// zod 4 keeps the shape on `def.shape` even after `.refine()`, so one walk
// covers every schema in the catalogue. Anything the walk does not recognise
// renders as its zod type name, which is honest and never wrong; it is a
// description, not a serialiser, and it has no other consumer.

import type { z } from "zod";

export interface FieldDoc {
  name: string;
  type: string;
  optional: boolean;
}

interface Def {
  type?: string;
  shape?: Record<string, unknown>;
  innerType?: unknown;
  element?: unknown;
  options?: unknown[];
  entries?: Record<string, unknown> | unknown[];
  values?: unknown[];
  valueType?: unknown;
}

function def(schema: unknown): Def {
  return ((schema as { def?: Def })?.def ?? {}) as Def;
}

/** A one-line type for a field: `string`, `number?`, `"a" | "b"`, `Locator[]`. */
export function typeName(schema: unknown, depth = 0): string {
  const d = def(schema);
  switch (d.type) {
    case "optional":
    case "nullable":
    case "default":
      return typeName(d.innerType, depth);
    case "array":
      return `${typeName(d.element, depth + 1)}[]`;
    case "union":
      return (d.options ?? []).map((o) => typeName(o, depth + 1)).join(" | ");
    case "enum": {
      const entries = d.entries;
      const values = Array.isArray(entries) ? entries : Object.values(entries ?? {});
      return values.map((v) => `"${String(v)}"`).join(" | ");
    }
    case "literal": {
      const values = Array.isArray(d.entries) ? d.entries : (d.values ?? []);
      return values.map((v) => (typeof v === "string" ? `"${v}"` : String(v))).join(" | ");
    }
    case "record":
      return "object";
    case "object": {
      if (depth > 0) return "{…}";
      return "object";
    }
    default:
      return d.type ?? "unknown";
  }
}

/** Every field of a prop schema, in declaration order. */
export function describeSchema(schema: z.ZodType): FieldDoc[] {
  const shape = def(schema).shape;
  if (!shape) return [];
  return Object.entries(shape).map(([name, field]) => ({
    name,
    type: typeName(field),
    optional: def(field).type === "optional",
  }));
}
