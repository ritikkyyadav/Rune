// ─── Timeline — what happened, in the order it happened ───
//
// The rail on the left is a hairline with a mark per event; the marks carry
// status colour and nothing else does. `at` is rendered verbatim: the harness
// records ISO timestamps and the surface shows the clock time a person would
// have seen, so the component formats but never invents — an event with no
// timestamp shows no timestamp rather than "now".

import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const TimelineEventSchema = z.strictObject({
  at: z.string().max(40).optional(),
  text: z.string().max(300),
  tone: z.enum(["neutral", "ok", "caution", "danger", "accent"]).optional(),
  detail: z.string().max(300).optional(),
});

export const TimelineSchema = z.strictObject({
  ...baseProps,
  events: z.array(TimelineEventSchema).max(300),
  /** The last event is live; its mark pulses on the accent. */
  live: z.boolean().optional(),
});
export type TimelineProps = z.infer<typeof TimelineSchema>;

function clock(at: string | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function Timeline(props: TimelineProps) {
  return (
    <Frame
      kind="p-timeline"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.events.length === 0}
      emptyText="Nothing has happened yet."
      skeleton={4}
    >
      <ol className="p-timeline-list">
        {props.events.map((e, i) => {
          const isLast = i === props.events.length - 1;
          return (
            <li key={i} className={`p-timeline-item tone-${e.tone ?? "neutral"}`}>
              <span
                className={`p-timeline-mark ${props.live && isLast ? "live" : ""}`}
                aria-hidden
              />
              <span className="p-timeline-at">{clock(e.at)}</span>
              <span className="p-timeline-body">
                <span className="p-timeline-text">{e.text}</span>
                {e.detail ? <span className="p-timeline-detail">{e.detail}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </Frame>
  );
}
