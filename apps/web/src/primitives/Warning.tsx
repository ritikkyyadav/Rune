// ─── Warning — something the person should know before they act ───
//
// Three severities, and they map to the three status colours and to nothing
// else. There is deliberately no "info" severity that borrows the accent: the
// accent belongs to the mark, the focus ring and the primary action, and a blue
// banner is how a surface starts shouting about things nobody asked about.

import { z } from "zod";
import { Frame, WarnGlyph, baseProps } from "./kit";

export const WarningSchema = z.strictObject({
  ...baseProps,
  text: z.string().max(600),
  severity: z.enum(["note", "caution", "danger"]).optional(),
  /** Where it came from, so a warning is never anonymous. */
  source: z.string().max(160).optional(),
});
export type WarningProps = z.infer<typeof WarningSchema>;

export function Warning(props: WarningProps) {
  const severity = props.severity ?? "caution";
  return (
    <Frame
      kind={`p-warning sev-${severity}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.text.trim().length === 0}
      emptyText="No warnings."
      skeleton={1}
      as="div"
    >
      <div className="p-warning-row" role="note">
        <WarnGlyph />
        <div className="p-warning-body">
          <span className="p-warning-text">{props.text}</span>
          {props.source ? <span className="p-warning-source">{props.source}</span> : null}
        </div>
      </div>
    </Frame>
  );
}
