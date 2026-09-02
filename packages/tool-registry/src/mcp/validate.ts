// ─── Validating a tool call against the server's own inputSchema ───
//
// Validation used to be required-presence only. A wrong type, an off-enum
// value or a malformed date travelled to the server, cost a round trip, and
// came back as whatever prose that server felt like — often something the
// model could not act on ("Invalid request"). Caught here it is a precise,
// local, free correction, and the message names the parameter and what was
// expected.
//
// This is deliberately NOT a full JSON Schema implementation. It covers what
// MCP tool schemas actually use — types, enum, required, ranges, lengths,
// patterns, the common string formats, arrays and one level of nesting — and
// it IGNORES anything it does not understand rather than guessing. A validator
// that rejects a valid call is far worse than one that lets an unusual one
// through: the server is still the authority.

type Json = Record<string, unknown>;

const FORMATS: Record<string, RegExp> = {
  // Deliberately permissive: these catch obvious mistakes (a title where a
  // date belongs), not RFC-exact conformance.
  "date-time": /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2})?([.,]\d+)?([Zz]|[+-]\d{2}:?\d{2})?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}(:\d{2})?$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^[a-zA-Z][a-zA-Z0-9+.-]*:/,
  url: /^https?:\/\/\S+$/i,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
};

/** The JSON Schema type name for a runtime value. */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  return t;
}

/** Whether a value satisfies one declared type name. */
function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

function describe(value: unknown): string {
  const t = typeOf(value);
  if (t === "string") return `string ${JSON.stringify(String(value).slice(0, 40))}`;
  if (t === "array") return `array of ${(value as unknown[]).length}`;
  if (t === "object") return "object";
  return `${t} ${JSON.stringify(value)}`;
}

/**
 * Validate `args` against a JSON-Schema-shaped `schema`.
 * Returns human-readable errors; an empty array means valid.
 *
 * @param depth guards against a schema that references itself through $ref-ish
 *              structures; three levels is deeper than any real tool schema.
 */
export function validateAgainstSchema(schema: Json, args: unknown, depth = 0): string[] {
  return validateValue(schema, args, "", depth);
}

function validateValue(schema: Json, value: unknown, path: string, depth: number): string[] {
  const errors: string[] = [];
  if (depth > 3 || !schema || typeof schema !== "object") return errors;
  const at = path || "argument";

  // A union of schemas: valid if ANY branch accepts. Report nothing specific,
  // because naming one branch's complaint would mislead.
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      const ok = branches.some(
        (b) => validateValue(b as Json, value, path, depth + 1).length === 0,
      );
      if (!ok) errors.push(`${at}: does not match any accepted shape`);
      return errors;
    }
  }

  // Type.
  const declared = schema.type;
  const types = Array.isArray(declared)
    ? (declared as string[])
    : typeof declared === "string"
      ? [declared]
      : [];
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    errors.push(`${at}: expected ${types.join(" or ")}, got ${describe(value)}`);
    return errors; // Everything below assumes the type held.
  }

  // Enum.
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((a) => a === value)) {
      errors.push(
        `${at}: must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}, got ${JSON.stringify(value)}`,
      );
    }
  }
  if ("const" in schema && schema.const !== value) {
    errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") {
    const min = schema.minLength;
    const max = schema.maxLength;
    if (typeof min === "number" && value.length < min) {
      errors.push(`${at}: shorter than the minimum ${min} characters`);
    }
    if (typeof max === "number" && value.length > max) {
      errors.push(`${at}: longer than the maximum ${max} characters`);
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${at}: does not match the required pattern ${schema.pattern}`);
        }
      } catch {
        // An invalid pattern in the SERVER's schema is not the caller's fault.
      }
    }
    if (typeof schema.format === "string") {
      const re = FORMATS[schema.format];
      if (re && !re.test(value)) {
        errors.push(`${at}: not a valid ${schema.format}`);
      }
    }
  }

  if (typeof value === "number") {
    const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema as Record<
      string,
      unknown
    >;
    if (typeof minimum === "number" && value < minimum) errors.push(`${at}: below the minimum ${minimum}`);
    if (typeof maximum === "number" && value > maximum) errors.push(`${at}: above the maximum ${maximum}`);
    if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
      errors.push(`${at}: must be greater than ${exclusiveMinimum}`);
    }
    if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
      errors.push(`${at}: must be less than ${exclusiveMaximum}`);
    }
    if (typeof multipleOf === "number" && multipleOf > 0 && value % multipleOf !== 0) {
      errors.push(`${at}: must be a multiple of ${multipleOf}`);
    }
  }

  if (Array.isArray(value)) {
    const { minItems, maxItems, items, uniqueItems } = schema as Record<string, unknown>;
    if (typeof minItems === "number" && value.length < minItems) {
      errors.push(`${at}: needs at least ${minItems} item${minItems === 1 ? "" : "s"}`);
    }
    if (typeof maxItems === "number" && value.length > maxItems) {
      errors.push(`${at}: accepts at most ${maxItems} item${maxItems === 1 ? "" : "s"}`);
    }
    if (uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${at}: items must be unique`);
    }
    if (items && typeof items === "object" && !Array.isArray(items)) {
      value.forEach((entry, i) => {
        errors.push(...validateValue(items as Json, entry, `${at}[${i}]`, depth + 1));
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Json;
    const props = (schema.properties ?? {}) as Record<string, Json>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj) || obj[key] === undefined) {
          errors.push(`missing required ${path ? `${at}.` : ""}${key}`);
        }
      }
    }
    // An unknown property is usually a HALLUCINATED one, and naming the real
    // ones is the fastest possible correction. Only reported when the schema
    // says the object is closed — an open schema means the server accepts
    // extras and we have no business refusing them.
    if (schema.additionalProperties === false && Object.keys(props).length > 0) {
      const known = new Set(Object.keys(props));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) {
          errors.push(`unknown parameter "${key}"; accepted: ${[...known].join(", ")}`);
        }
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (!(key in obj) || obj[key] === undefined) continue;
      errors.push(...validateValue(sub, obj[key], path ? `${at}.${key}` : key, depth + 1));
    }
  }

  // Cap the report: twenty complaints about one call is noise, and the model
  // will re-send after fixing the first few anyway.
  return errors.slice(0, 8);
}
