// ─── Source — a citation with a locator ───
//
// The difference between a citation and a link is the LOCATOR: not "the orders
// module" but `src/database/orders.ts:118–131`, not "the docs" but the URL and
// the line it was retrieved at. A source without a locator is a gesture at
// where something might be, and the product's claim is that every number on
// screen traces to the thing that produced it.
//
// `retrievedAt` is stamped because a web source is a claim about a moment.

import { z } from "zod";
import { Frame, LocatorSchema, baseProps, locatorText } from "./kit";

export const SourceSchema = z.strictObject({
  ...baseProps,
  id: z.string().max(120).optional(),
  title: z.string().max(300),
  locator: LocatorSchema,
  retrievedAt: z.string().max(40).optional(),
  /** How the agent came by it: a tool call, a search, the user. */
  via: z.string().max(80).optional(),
});
export type SourceProps = z.infer<typeof SourceSchema>;

const KIND_LABEL: Record<string, string> = {
  file: "file",
  url: "web",
  command: "command",
  span: "trace",
  check: "check",
};

export function Source(props: SourceProps) {
  const isUrl = props.locator.kind === "url";
  const loc = locatorText(props.locator);
  return (
    <Frame
      kind="p-source"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.title.trim().length === 0}
      emptyText="No source."
      skeleton={2}
      as="div"
    >
      <div className="p-source-row">
        <span className="p-source-kind">
          {KIND_LABEL[props.locator.kind] ?? props.locator.kind}
        </span>
        <span className="p-source-main">
          <span className="p-source-title">{props.title}</span>
          {isUrl ? (
            <a
              className="p-source-loc"
              href={props.locator.ref}
              target="_blank"
              rel="noopener noreferrer"
            >
              {loc}
            </a>
          ) : (
            <span className="p-source-loc">{loc}</span>
          )}
        </span>
        {props.retrievedAt ? <span className="p-source-at">{props.retrievedAt}</span> : null}
      </div>
      {props.locator.excerpt ? (
        <blockquote className="p-source-excerpt">{props.locator.excerpt}</blockquote>
      ) : null}
      {props.via ? <span className="p-source-via">via {props.via}</span> : null}
    </Frame>
  );
}
