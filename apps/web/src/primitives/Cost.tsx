// ─── Cost — what this run has spent ───
//
// Money is measured, never estimated on screen: `usd` is a number the ledger
// recorded, and `null` is rendered as "—" rather than as $0.00. The cost audit
// (2026-08-29) exists because a meter that was never installed reported $0.07
// for $55.81 of work, so the one thing this primitive will not do is print a
// confident zero.

import { z } from "zod";
import { Frame, baseProps, compactNumber } from "./kit";

export const CostSchema = z.strictObject({
  ...baseProps,
  usd: z.number().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable().optional(),
  outputTokens: z.number().int().nonnegative().nullable().optional(),
  cachedTokens: z.number().int().nonnegative().nullable().optional(),
  model: z.string().max(80).optional(),
  /** A ceiling the run is working under, if one was set. */
  budgetUsd: z.number().positive().optional(),
});
export type CostProps = z.infer<typeof CostSchema>;

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(2)}`;
}

function tokens(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : compactNumber(v);
}

export function Cost(props: CostProps) {
  const over = props.budgetUsd !== undefined && props.usd !== null && props.usd > props.budgetUsd;
  return (
    <Frame
      kind="p-cost"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.usd === null && props.inputTokens == null && props.outputTokens == null}
      emptyText="No spend recorded."
      skeleton={2}
      as="div"
    >
      <div className="p-cost-row">
        <span className={`p-cost-amount ${over ? "over" : ""}`}>{money(props.usd)}</span>
        {props.budgetUsd !== undefined ? (
          <span className="p-cost-budget">of {money(props.budgetUsd)}</span>
        ) : null}
        {props.model ? <span className="p-cost-model">{props.model}</span> : null}
      </div>
      <dl className="p-cost-tokens">
        <div>
          <dt>in</dt>
          <dd>{tokens(props.inputTokens)}</dd>
        </div>
        <div>
          <dt>out</dt>
          <dd>{tokens(props.outputTokens)}</dd>
        </div>
        <div>
          <dt>cached</dt>
          <dd>{tokens(props.cachedTokens)}</dd>
        </div>
      </dl>
    </Frame>
  );
}
