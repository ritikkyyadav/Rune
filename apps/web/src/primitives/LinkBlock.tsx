// ─── Link — somewhere else worth going ───
//
// External links open in a new tab with `noopener noreferrer`, always: a task
// surface composed from model output is exactly the place a `window.opener`
// handle must not exist. The scheme allowlist lives in the SCHEMA rather than
// the component, so a `javascript:` URL fails validation inside the composer
// and the block never reaches the DOM at all.
//
// The file is `LinkBlock.tsx` because `Link` is the export and a bare `Link.tsx`
// beside React Router's is the kind of import ambiguity that costs an hour.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

const SAFE_SCHEME = /^(https?:\/\/|\/|mailto:)/i;

export const LinkSchema = z.strictObject({
  ...baseProps,
  text: z.string().max(160),
  href: z
    .string()
    .max(2000)
    .refine((h) => SAFE_SCHEME.test(h), {
      message: "href must be http(s), mailto: or root-relative",
    }),
  hint: z.string().max(120).optional(),
});
export type LinkProps = z.infer<typeof LinkSchema>;

export function Link(props: LinkProps) {
  const external = /^https?:/i.test(props.href);
  return (
    <Frame
      kind="p-link"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.text.length === 0}
      emptyText="No destination."
      skeleton={1}
      as="div"
    >
      <a
        className="p-link-a"
        href={props.href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        <span>{props.text}</span>
        {external ? (
          <svg className="p-link-out" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path
              d="M14 5h5v5M19 5l-8 8M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5H10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </a>
      {props.hint ? <span className="p-link-hint">{props.hint}</span> : null}
    </Frame>
  );
}
