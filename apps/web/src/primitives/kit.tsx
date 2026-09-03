// ─── The primitive kit — what every one of the thirty shares ───
//
// A primitive is two things bolted together: a zod schema that IS the contract
// (the composer validates model-supplied props against it, so a small model
// cannot reach past the vocabulary) and a React component that renders it in
// four states — ready, empty, loading, error.
//
// The four states are not decoration. A surface the agent composes is a surface
// where every block can be waiting on a tool, be bound to a path that resolved
// to nothing, or be bound to a path that threw. A primitive without those three
// states pushes the problem up into the shell, and the shell then grows a
// dialect per primitive. So they live here, once, and every primitive gets them
// by wrapping its body in `Frame`.
//
// One convention that looks like an omission and is not: a primitive's own
// identifying string — a hypothesis's `text`, an approval's `grant`, a file's
// `path` — is bounded with `.max()` and never with `.min(1)`. The empty string
// IS the empty state, and it is also what a persona composer puts in a block's
// static props before a binding fills it, so a `.min(1)` there would make every
// spine block fail validation on a task that has not started yet. Strings inside
// an ARRAY keep their `.min(1)`: there the empty state is the empty array, and a
// blank row is a defect rather than a stage.
//
// House rules the kit enforces mechanically:
//   • no `box-shadow` on content — depth is a hairline (see primitives.css)
//   • radii from {6, 8, 10} via --r-chip / --r / --r-composer
//   • one accent; status colour only for status
//   • nothing accepts raw HTML; `dangerouslySetInnerHTML` appears in exactly
//     one file in this directory (Preview.tsx) and a test pins that
//   • every interactive affordance is a real <button> or <a>, so keyboard
//     reachability is a consequence of the markup rather than a tabindex

import type { ReactNode } from "react";
import { z } from "zod";

/** The load state a block can be in, independent of its data being empty. */
export const StatusSchema = z.enum(["ready", "loading", "error"]);
export type PrimitiveStatus = z.infer<typeof StatusSchema>;

/**
 * The props every primitive accepts on top of its own.
 *
 * `label` is the accessible name and the visible eyebrow; `state` and `error`
 * carry the two non-ready states. Spread into each primitive's schema rather
 * than nested, because a projection block's props are flat on the wire and a
 * model writing `{ "state": "loading" }` should not have to guess at a wrapper
 * object.
 *
 * It is `state` and not `status` deliberately. Four primitives have a DOMAIN
 * status of their own — a hypothesis is `refuted`, an agent is `working`, a
 * pending decision is `resolved` — and P11.1 names that field `status` on the
 * task state. A base key called `status` would collide with it on every one of
 * them, and a projection binding a hypothesis to a card would silently overwrite
 * its verdict with a load state. Two different questions, two different words.
 */
export const baseProps = {
  label: z.string().max(120).optional(),
  state: StatusSchema.optional(),
  error: z.string().max(400).optional(),
} as const;

export interface BaseProps {
  label?: string;
  state?: PrimitiveStatus;
  error?: string;
}

/** A tone that maps to a status colour. Never used for emphasis. */
export const ToneSchema = z.enum(["neutral", "ok", "caution", "danger", "accent"]);
export type Tone = z.infer<typeof ToneSchema>;

/**
 * A locator: where a claim, a citation or a log line actually came from.
 *
 * `path` plus an optional line range, or a URL. The product's whole claim is
 * that a number on screen traces to the thing that produced it, so the locator
 * is a first-class shape rather than a string a component parses.
 */
export const LocatorSchema = z.strictObject({
  kind: z.enum(["file", "url", "command", "span", "check"]),
  ref: z.string().max(400),
  line: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative().optional(),
  excerpt: z.string().max(400).optional(),
});
export type Locator = z.infer<typeof LocatorSchema>;

/** Render a locator as the one line a person reads: `path:12–18` or a host. */
export function locatorText(l: Locator): string {
  if (l.kind === "url") {
    try {
      const u = new URL(l.ref);
      return u.host + (u.pathname === "/" ? "" : u.pathname);
    } catch {
      return l.ref;
    }
  }
  if (l.line === undefined) return l.ref;
  return l.endLine !== undefined && l.endLine !== l.line
    ? `${l.ref}:${l.line}–${l.endLine}`
    : `${l.ref}:${l.line}`;
}

// ─── Frame ───

export interface FrameProps extends BaseProps {
  /** The primitive's own class, e.g. `p-metric`. */
  kind: string;
  /** True when the data is present but has nothing in it. */
  empty?: boolean;
  /** What "nothing here" reads as. One short clause, never a shrug. */
  emptyText?: string;
  /** Skeleton rows to draw while loading, so the block does not collapse. */
  skeleton?: number;
  /** Rendered instead of a <section> when the primitive is inline. */
  as?: "section" | "div";
  children: ReactNode;
}

/**
 * The state machine every primitive runs through, drawn once.
 *
 * Order matters: error beats loading beats empty. A block that failed while
 * refreshing is failed — showing a skeleton over a stale error is how an
 * interface tells a person everything is fine while it is not.
 */
export function Frame(props: FrameProps) {
  const Tag = props.as === "div" ? "div" : "section";
  const view =
    props.state === "error"
      ? "error"
      : props.state === "loading"
        ? "loading"
        : props.empty
          ? "empty"
          : "ready";

  return (
    <Tag
      className={`pf ${props.kind} is-${view}`}
      aria-label={props.label}
      aria-busy={view === "loading" || undefined}
    >
      {props.label ? <div className="pf-label">{props.label}</div> : null}
      {view === "error" ? (
        <p className="pf-error" role="status">
          <WarnGlyph />
          <span>{props.error ?? "This block could not be read."}</span>
        </p>
      ) : view === "loading" ? (
        <div className="pf-loading" role="status" aria-label="Loading">
          {Array.from({ length: props.skeleton ?? 2 }, (_, i) => (
            <span className="pf-skel" key={i} style={{ width: `${88 - i * 17}%` }} />
          ))}
        </div>
      ) : view === "empty" ? (
        <p className="pf-empty">{props.emptyText ?? "Nothing yet."}</p>
      ) : (
        props.children
      )}
    </Tag>
  );
}

// ─── Small shared marks ───
//
// Inline geometry rather than an icon import, for the same reason Icons.tsx
// gives: a glyph that inherits `currentColor` can never disagree with the token
// next to it.

export function WarnGlyph() {
  return (
    <svg className="pf-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M12 4.5 21 20H3L12 4.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 10v4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="17.2" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function CheckGlyph() {
  return (
    <svg className="pf-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="m5 12.5 4.5 4.5L19 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Chevron(props: { open: boolean }) {
  return (
    <svg
      className={`pf-chev ${props.open ? "open" : ""}`}
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <path
        d="m9 5 7 7-7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A status word, in the status colour, never larger than the text beside it. */
export function ToneWord(props: { tone: Tone; children: ReactNode }) {
  return <span className={`pf-tone tone-${props.tone}`}>{props.children}</span>;
}

// ─── Number formatting ───
//
// Tabular numerals are a CSS rule; these are the two shapes a person reads.

export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${trim(n / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(n / 1_000)}k`;
  return n.toLocaleString("en-US");
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** Seconds and minutes, never "0.00s". */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}
