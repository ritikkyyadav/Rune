// ─── Agent — one row of the fleet ───
//
// A port of the fleet panel's row into the vocabulary, with the same discipline
// the terminal one has: the row is a fixed height, the current tool is
// truncated rather than wrapped, and the elapsed clock is the only thing that
// moves. A fleet of six agents whose rows reflow as their tool names change is
// unreadable at a glance, which is the only way anybody reads a fleet.
//
// `step` is the ledger step the agent OWNS, so a plan and a fleet are the same
// picture from two directions.

import { z } from "zod";
import { Frame, baseProps, durationText } from "./kit";

export const AgentStatusSchema = z.enum(["queued", "working", "waiting", "done", "failed"]);

export const AgentSchema = z.strictObject({
  ...baseProps,
  id: z.string().max(80).optional(),
  name: z.string().max(80),
  status: AgentStatusSchema,
  /** What it is doing right now. One clause. */
  activity: z.string().max(160).optional(),
  /** The ledger step this agent claimed. */
  step: z.string().max(300).optional(),
  elapsedMs: z.number().nonnegative().optional(),
  model: z.string().max(60).optional(),
  usd: z.number().nonnegative().nullable().optional(),
});
export type AgentProps = z.infer<typeof AgentSchema>;

export function Agent(props: AgentProps) {
  return (
    <Frame
      kind={`p-agent st-${props.status}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.name.trim().length === 0}
      emptyText="No agents."
      skeleton={1}
      as="div"
    >
      <div className="p-agent-row">
        <span className={`p-agent-dot st-${props.status}`} aria-hidden />
        <span className="p-agent-name">{props.name}</span>
        <span className="p-agent-activity">{props.activity ?? props.step ?? "—"}</span>
        <span className="p-agent-meta">
          {props.model ? <span className="p-agent-model">{props.model}</span> : null}
          {props.usd !== null && props.usd !== undefined ? (
            <span>${props.usd.toFixed(2)}</span>
          ) : null}
          {props.elapsedMs !== undefined ? (
            <span className="p-agent-elapsed">{durationText(props.elapsedMs)}</span>
          ) : null}
          <span className={`p-agent-status st-${props.status}`}>{props.status}</span>
        </span>
      </div>
    </Frame>
  );
}
