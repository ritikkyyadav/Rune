// ─── /gallery — the whole vocabulary on one screen ───
//
// Linked from nowhere in the product. It is served by `gear serve --web` because
// the SPA fallback hands `index.html` to any unknown path, and it exists for one
// reader: the founder, judging thirty primitives in four states on two grounds
// without running a task.
//
// The layout is the argument. Cells are paired light | dark so a colour that
// only works on paper shows up as a defect rather than as something you have to
// toggle to find, and every state is on the page at once rather than behind a
// control, because the states nobody designs are the states nobody clicks to.
// Wide primitives — a table, a diff, a chart — take a half-row each so they are
// judged at a width they will actually be rendered at.
//
// Under each row sits the schema, read from the ACTUAL zod object rather than
// from a table somebody typed, because "what can the agent put in this" is the
// second question after "what does it look like".
//
// Both grounds live in one document because `tokens.css` now defines the theme
// on any `[data-theme]` container, not only on `:root`.
//
// The page ends with the six composed surfaces. Thirty primitives that each look
// right and compose into a mess is the failure this page exists to catch.

import { useMemo, useState } from "react";

import { BLOCK_TYPES, PRIMITIVES, type AnyProps, type BlockType } from "../primitives";
import { API_LATENCY_TASK } from "../compose/fixture";
import { composeTaskSurface } from "../compose/model-choice";
import { ProjectionView } from "../compose/Surface";
import { TASK_KINDS, deriveView, type TaskKind } from "../compose/state";
import { SAMPLES } from "./samples";
import { describeSchema } from "../primitives/describe";

type Ground = "light" | "dark";
const GROUNDS: Ground[] = ["light", "dark"];

/**
 * Primitives that need room. Each takes half a row per ground rather than a
 * quarter, because a diff judged at 340px is a diff nobody judged.
 */
const WIDE: ReadonlySet<BlockType> = new Set<BlockType>([
  "table",
  "chart",
  "diff",
  "file",
  "terminal",
  "comparison",
  "relationship",
  "preview",
  "log",
  "transcript",
  "timeline",
  "approval",
  "choice",
  "form",
  "decision",
  "checklist",
  "text",
  "tree",
  "hypothesis",
  "evidence",
  "source",
  "artifact",
  "agent",
]);

/** One primitive, one ground, one state. */
function Cell(props: { type: BlockType; state: string; render: AnyProps; wide: boolean }) {
  const Component = PRIMITIVES[props.type].Component;
  return (
    <>
      {GROUNDS.map((ground) => (
        <div
          key={ground}
          className={`gal-cell ${props.wide ? "wide" : ""}`}
          data-theme={ground}
          data-state={props.state}
        >
          <div className="gal-tag">
            <span className="gal-state">{props.state}</span>
            <span className="gal-ground">{ground}</span>
          </div>
          <div className="gal-render">
            <Component {...props.render} />
          </div>
        </div>
      ))}
    </>
  );
}

function SchemaLine(props: { type: BlockType }) {
  const entry = PRIMITIVES[props.type];
  const fields = useMemo(() => describeSchema(entry.schema), [entry.schema]);
  return (
    <div className="gal-schema">
      <span className="gal-schema-key">
        <code>{props.type}</code>
        <span className="gal-bind">
          bind {entry.bind.mode}
          {entry.bind.key ? ` → ${entry.bind.key}` : ""}
        </span>
        {entry.foldable ? <span className="gal-flag">foldable</span> : null}
        {entry.interactive ? <span className="gal-flag">interactive</span> : null}
      </span>
      <ul className="gal-fields">
        {fields.map((f) => (
          <li key={f.name} className={f.optional ? "opt" : ""}>
            <code>{f.name}</code>
            {f.optional ? "?" : ""}
            <span className="gal-type">{f.type}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PrimitiveSection(props: { type: BlockType; index: number }) {
  const entry = PRIMITIVES[props.type];
  const sample = SAMPLES[props.type];
  const wide = WIDE.has(props.type);
  return (
    <section className="gal-section" id={`p-${props.type}`}>
      <header className="gal-head">
        <span className="gal-num">{String(props.index + 1).padStart(2, "0")}</span>
        <h2>{entry.title}</h2>
        <p>{entry.summary}</p>
      </header>
      <div className="gal-grid">
        <Cell type={props.type} state="ready" render={sample.ready} wide={wide} />
        {(sample.extra ?? []).map((v) => (
          <Cell key={v.label} type={props.type} state={v.label} render={v.props} wide={wide} />
        ))}
        <Cell type={props.type} state="empty" render={sample.empty} wide={false} />
        <Cell
          type={props.type}
          state="loading"
          render={{ ...sample.ready, state: "loading" } as AnyProps}
          wide={false}
        />
        <Cell
          type={props.type}
          state="error"
          render={
            {
              ...sample.ready,
              state: "error",
              error: "the engine closed the stream while this block was loading",
            } as AnyProps
          }
          wide={false}
        />
      </div>
      <SchemaLine type={props.type} />
    </section>
  );
}

function SurfaceSection() {
  const [persona, setPersona] = useState<TaskKind>("investigate");
  const state = useMemo(() => deriveView(API_LATENCY_TASK), []);
  const result = useMemo(
    () => composeTaskSurface(state, { persona, emphasis: [] }),
    [state, persona],
  );
  return (
    <section className="gal-section" id="surfaces">
      <header className="gal-head">
        <span className="gal-num">31</span>
        <h2>The composed surface</h2>
        <p>
          One Task State through each of the six personas. Nothing below was written by hand: a
          composer produced a projection and the renderer resolved its bind paths against the state.
        </p>
      </header>
      <div className="gal-personas">
        {TASK_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`gal-persona ${k === persona ? "is-on" : ""}`}
            onClick={() => setPersona(k)}
            aria-pressed={k === persona}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="gal-grid">
        {GROUNDS.map((g) => (
          <div className="gal-cell surface-cell" data-theme={g} key={g}>
            <div className="gal-tag">
              <span className="gal-state">{persona}</span>
              <span className="gal-ground">{g}</span>
            </div>
            <div className="gal-render">
              <ProjectionView projection={result.projection} state={state} />
            </div>
          </div>
        ))}
      </div>
      <div className="gal-schema">
        <span className="gal-schema-key">
          <code>projection</code>
          <span className="gal-bind">
            {result.projection.blocks.length} blocks · persona {result.projection.persona}
          </span>
        </span>
        <ul className="gal-fields">
          {(["header", "primary", "side", "actions"] as const).map((r) => (
            <li key={r}>
              <code>{r}</code>
              <span className="gal-type">
                {(r === "side"
                  ? (result.projection.regions.side ?? [])
                  : result.projection.regions[r]
                ).join(" · ") || "—"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default function Gallery() {
  return (
    <main className="gal">
      <header className="gal-top">
        <h1>The primitive catalogue</h1>
        <p>
          Thirty primitives, four states each, on both grounds, plus the surfaces the composer
          builds from them. The content is the API latency investigation from the Phase 11
          wireframes. Served by <code>gear serve --web</code> at <code>/gallery</code>; linked from
          nowhere in the product.
        </p>
        <nav className="gal-nav" aria-label="Primitives">
          {BLOCK_TYPES.map((t) => (
            <a key={t} href={`#p-${t}`}>
              {t}
            </a>
          ))}
          <a href="#surfaces">surfaces</a>
        </nav>
      </header>
      {BLOCK_TYPES.map((t, i) => (
        <PrimitiveSection key={t} type={t} index={i} />
      ))}
      <SurfaceSection />
    </main>
  );
}
