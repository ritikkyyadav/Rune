// ─── Artifact — a thing the task produced, that outlives it ───
//
// A file, a diff, a report, a chart, a table, a preview. The row says what it
// is, where it is, and how big; the actions are the two a person actually
// wants — open it, and copy the path so it can be pasted into a terminal.
//
// Actions are declared, not invented: the component takes callbacks, and a
// projection block that has no handler renders the row without them rather than
// with a dead button.

import { z } from "zod";
import { Frame, baseProps, compactNumber } from "./kit";

export const ArtifactKindSchema = z.enum(["file", "diff", "report", "chart", "table", "preview"]);

export const ArtifactSchema = z.strictObject({
  ...baseProps,
  id: z.string().max(120).optional(),
  kind: ArtifactKindSchema,
  name: z.string().max(300),
  ref: z.string().max(600),
  bytes: z.number().int().nonnegative().optional(),
  at: z.string().max(40).optional(),
  note: z.string().max(200).optional(),
});
export type ArtifactProps = z.infer<typeof ArtifactSchema> & {
  onOpen?: (ref: string) => void;
};

const GLYPH: Record<z.infer<typeof ArtifactKindSchema>, string> = {
  file: "◫",
  diff: "±",
  report: "❡",
  chart: "◔",
  table: "▤",
  preview: "◧",
};

export function Artifact(props: ArtifactProps) {
  return (
    <Frame
      kind="p-artifact"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.name.trim().length === 0}
      emptyText="No artifact."
      skeleton={2}
      as="div"
    >
      <div className="p-artifact-row">
        <span className="p-artifact-glyph" aria-hidden>
          {GLYPH[props.kind]}
        </span>
        <span className="p-artifact-main">
          <span className="p-artifact-name">{props.name}</span>
          <span className="p-artifact-ref">{props.ref}</span>
        </span>
        <span className="p-artifact-meta">
          <span className="p-artifact-kind">{props.kind}</span>
          {props.bytes !== undefined ? <span>{compactNumber(props.bytes)} B</span> : null}
        </span>
        {props.onOpen ? (
          <button type="button" className="p-btn" onClick={() => props.onOpen?.(props.ref)}>
            Open
          </button>
        ) : null}
      </div>
      {props.note ? <p className="p-artifact-note">{props.note}</p> : null}
    </Frame>
  );
}
