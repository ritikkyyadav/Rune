// ─── Preview — the ONLY primitive that renders markup, and it renders it in a jail ───
//
// Everything else in this catalogue takes text and produces text nodes. This one
// exists because a task that builds a page has to show the page, and a
// screenshot of it is not the same thing.
//
// The jail, and why each bar is there:
//   • an <iframe srcDoc>, never `dangerouslySetInnerHTML` — same-document
//     injection would put model output in the app's own DOM, with the app's
//     own origin, next to the token in memory
//   • `sandbox="allow-scripts"` and NOTHING else — no allow-same-origin (the
//     combination of the two is documented by the HTML spec as equivalent to
//     removing the sandbox), no allow-forms, no allow-popups, no
//     allow-top-navigation
//   • a `csp`-shaped <meta> injected ahead of the document, so a preview cannot
//     reach the network even if it is handed a <script src>
//   • `referrerPolicy="no-referrer"`, and `loading="lazy"` so a folded preview
//     costs nothing
//
// The image form takes a URL and renders an <img>; the schema's scheme
// allowlist keeps it to https and data:image, which is what a screenshot the
// harness captured actually is.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

const IMAGE_SRC = /^(https:\/\/|\/|data:image\/(png|jpeg|gif|webp|svg\+xml);base64,)/i;

export const PreviewSchema = z.strictObject({
  ...baseProps,
  form: z.enum(["html", "image"]),
  /** For `html`: the document. For `image`: unused. */
  html: z.string().max(400_000).optional(),
  /** For `image`: https, root-relative or a base64 data image. */
  src: z
    .string()
    .max(2_000_000)
    .refine((s) => IMAGE_SRC.test(s), { message: "src must be https, root-relative or data:image" })
    .optional(),
  alt: z.string().max(300).optional(),
  /** CSS height for the frame. Numbers only, in px. */
  height: z.number().int().positive().max(2000).optional(),
  caption: z.string().max(200).optional(),
});
export type PreviewProps = z.infer<typeof PreviewSchema>;

/** The policy the framed document runs under, prepended to whatever it sent. */
const CSP =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
  "img-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'\">";

export function Preview(props: PreviewProps) {
  const empty = props.form === "html" ? !props.html : !props.src;
  return (
    <Frame
      kind="p-preview"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={empty}
      emptyText="Nothing to preview."
      skeleton={3}
    >
      {props.form === "html" ? (
        <iframe
          className="p-preview-frame"
          title={props.label ?? props.alt ?? "Preview"}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          style={{ height: `${props.height ?? 320}px` }}
          srcDoc={CSP + (props.html ?? "")}
        />
      ) : (
        <img
          className="p-preview-img"
          src={props.src}
          alt={props.alt ?? props.label ?? "Preview"}
          loading="lazy"
          style={{ maxHeight: `${props.height ?? 320}px` }}
        />
      )}
      {props.caption ? <p className="p-preview-caption">{props.caption}</p> : null}
    </Frame>
  );
}
