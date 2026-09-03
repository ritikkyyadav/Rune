// ─── Terminal — a command and what it printed ───
//
// The command is on its own line with a `$`, because "which command produced
// this" is the first question and scrolling to the top of an output block to
// answer it is the first annoyance. The exit code is shown when it is known and
// omitted when it is not: absent means no data, never zero.
//
// Output is truncated at the HEAD, not the tail. A failing command puts its
// reason in the last lines; a log that keeps the first 40 lines of a 4,000-line
// build keeps the part nobody needs.

import { z } from "zod";
import { Frame, baseProps, durationText } from "./kit";

export const TerminalSchema = z.strictObject({
  ...baseProps,
  command: z.string().max(2000),
  output: z.string().max(200_000).optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
  cwd: z.string().max(300).optional(),
  /** Lines kept from the END of the output. Default 40. */
  tail: z.number().int().positive().max(2000).optional(),
});
export type TerminalProps = z.infer<typeof TerminalSchema>;

export function Terminal(props: TerminalProps) {
  const all = (props.output ?? "").replace(/\n$/, "");
  const lines = all.length === 0 ? [] : all.split("\n");
  const keep = props.tail ?? 40;
  const clipped = lines.length > keep;
  const shown = clipped ? lines.slice(lines.length - keep) : lines;
  const failed = props.exitCode !== undefined && props.exitCode !== 0;

  return (
    <Frame
      kind={`p-terminal ${failed ? "failed" : ""}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.command.trim().length === 0}
      emptyText="No command."
      skeleton={4}
    >
      <div className="p-term-head">
        <span className="p-term-prompt" aria-hidden>
          $
        </span>
        <code className="p-term-command">{props.command}</code>
        <span className="p-term-meta">
          {props.cwd ? <span className="p-term-cwd">{props.cwd}</span> : null}
          {props.durationMs !== undefined ? <span>{durationText(props.durationMs)}</span> : null}
          {props.exitCode !== undefined ? (
            <span className={failed ? "p-term-exit bad" : "p-term-exit"}>
              exit {props.exitCode}
            </span>
          ) : null}
        </span>
      </div>
      {shown.length > 0 ? (
        <pre className="p-term-out">
          {clipped ? (
            <span className="p-term-clip">
              … {lines.length - keep} earlier lines
              {"\n"}
            </span>
          ) : null}
          {shown.join("\n")}
        </pre>
      ) : props.output !== undefined ? (
        <p className="p-term-silent">no output</p>
      ) : null}
    </Frame>
  );
}
