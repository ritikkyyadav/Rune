// ─── Gear · the holds ───
// The second surface, and it is never on screen at the same time as the stream. There
// are three kinds and they exist because in each case the screen genuinely *is* the
// answer: a **decision**, which blocks and says so; an **inspection**, which you
// summoned and behind which work continues; and the **terminus**, which is the result
// and is the one screen in the product worth owning.
//
// A hold is always momentary, and `esc` always returns to the exact row you left.

import { type Caps } from "../render/caps";
import { RUNG_GLYPH, type Row, type Span, pair, repeat, wrapText } from "../render/row";
import { type MissionState, type Decision, diffTotals, elapsedMs, metCriteria } from "../reduce";
import { count, dur } from "../format";

const dim = (t: string): Span => ({ t, c: "dim" });
const bar = (caps: Caps, ch = "─"): Row => ({ spans: [dim(repeat(caps.measure, ch))] });

/** Width is spent in exactly one place: here, where comparison is the task. */
const sideBySide = (caps: Caps) => caps.measure >= 100;

// ─── the decision ───
// The only screen that blocks. It counts what is idle while you think, recommends in
// the first person with a reason about time horizon, offers a way to look that is
// neither yes nor no, and promises that stopping to think costs nothing.

export function decisionHold(d: Decision, caps: Caps): Array<Row | null> {
  const rows: Array<Row | null> = [
    bar(caps, "═"),
    // What sits idle while you think is counted, never hidden — and at a width where
    // it will not fit beside the title it gets its own row rather than being cut.
    ...pair(
      [{ t: "  " }, { t: "◇  DECISION", c: "strong" }, dim(`   ${d.id}`)],
      [
        { t: `mission held ${dur(d.heldMs ?? 0)}`, c: "warn" },
        dim(` · ${count(d.idleAgents, "agent")} idle · ${dur(d.queuedMs)} queued behind you  `),
      ],
      caps,
      "  ",
    ),
    bar(caps, "═"),
    null,
    ...wrapText(d.question, caps.measure - 4).map((l): Row => ({ spans: [{ t: "  " + l }] })),
    null,
  ];

  if (sideBySide(caps) && d.options.length === 2) {
    const col = Math.floor((caps.measure - 4) / 2);
    const [a, b] = d.options as [(typeof d.options)[0], (typeof d.options)[0]];
    const pair = (l: string, r: string): Row => ({
      spans: [{ t: "  " + l.padEnd(col - 2) + " " + r }],
    });
    rows.push({
      spans: [
        dim("  ── "),
        { t: a.key, c: "strong" },
        dim(` ── ${a.title} ${repeat(col - 10 - a.title.length)}`),
        dim("  ── "),
        { t: b.key, c: "strong" },
        dim(` ── ${b.title} ${repeat(col - 12 - b.title.length)}`),
      ],
    });
    rows.push({ spans: [dim("  " + a.cost.padEnd(col - 2) + " " + b.cost)] });
    rows.push(null);
    const depth = Math.max(a.body.length, b.body.length);
    for (let i = 0; i < depth; i++) rows.push(pair(a.body[i] ?? "", b.body[i] ?? ""));
    rows.push({ spans: [dim(`  ${repeat(col - 2)} ${repeat(col - 2)}`)] });
    rows.push({
      spans: [
        dim(
          "  " +
            (a.reversible ? "reversible · one commit" : "not reversible").padEnd(col - 2) +
            " " +
            (b.reversible ? "reversible · one commit" : "not reversible"),
        ),
      ],
    });
  } else {
    // At 58 columns the comparison stacks. What is cut is chrome, never argument.
    for (const o of d.options) {
      rows.push({
        spans: [
          dim("  ── "),
          { t: o.key, c: "strong" },
          dim(` ── ${o.title} ${repeat(Math.max(0, caps.measure - 12 - o.title.length))}`),
        ],
      });
      rows.push({ spans: [dim("     " + o.cost)] });
      // Re-wrap rather than reuse the two-column line breaks: at this width they are
      // the wrong breaks, and an argument broken in the wrong place reads as noise.
      for (const para of o.body.join("\n").split("\n\n"))
        for (const line of wrapText(para, caps.measure - 7))
          rows.push({ spans: [{ t: "     " + line }] });
      rows.push(null);
    }
  }

  rows.push(null, bar(caps));
  rows.push({ spans: [{ t: "  " + d.recommendation, c: "strong" }] });
  rows.push(null);
  // The reason survives intact at every width. It is the last thing that would ever
  // be cut, because it is the only thing on this screen that is an argument.
  for (const line of wrapText(d.reasoning.join(" "), caps.measure - 4))
    rows.push({ spans: [dim("  " + line)] });
  rows.push(null);

  const keys: Span[] = [];
  for (const o of d.options) {
    keys.push({ t: "  " + o.key.toLowerCase(), c: "strong" }, dim(`  take ${o.key}`), {
      t: "     ",
    });
  }
  const wide = caps.measure >= 76;
  keys.push({ t: "w", c: "strong" }, dim(wide ? "  neither — I'll describe it" : "  neither"));
  rows.push({ spans: keys });
  rows.push({
    spans: [
      { t: "  ?", c: "strong" },
      dim("  ask"),
      { t: "        " },
      { t: "esc", c: "strong" },
      dim(wide ? "  hold here and think · nothing is lost" : "  think · nothing lost"),
    ],
  });
  rows.push(bar(caps, "═"));
  return rows;
}

// ─── the terminus ───
// Not a summary — the evidence. The criteria you agreed to at minute zero, checked or
// not checked, the diff, the findings, and a section no coding agent has and every one
// needs: what it chose not to do, and why.
//
// A mission *concludes* whether it succeeded or not, and this renders the same shape
// either way. Success is not a state here; it is a count of criteria.

export interface TerminusExtras {
  /** what it chose not to do, in its own words, and the command that would do it */
  notDone: string[];
  /** the numbers behind the claims above, so every one of them can be checked */
  evidence: string[];
  branch?: string;
  commits?: number;
}

export function terminus(
  state: MissionState,
  extras: TerminusExtras,
  caps: Caps,
): Array<Row | null> {
  const totals = diffTotals(state);
  const rows: Array<Row | null> = [
    bar(caps, "═"),
    ...pair(
      [{ t: "  " }, { t: state.objective ?? "", c: "strong" }],
      [dim(`${state.phase} · ${dur(elapsedMs(state))} · ${state.id ?? ""}`), { t: "  " }],
      caps,
      "  ",
    ),
    bar(caps, "═"),
    null,
    { spans: [{ t: "  done when", c: "strong" }] },
  ];

  for (const c of state.criteria) {
    rows.push(
      ...pair(
        [{ t: "   " }, { t: c.met ? "✓" : "○", c: c.met ? "ok" : "warn" }, { t: " " + c.text }],
        [
          dim(c.detail ?? (c.met ? "" : "unmet")),
          { t: "   " },
          { t: c.met ? "✓" : "·", c: c.met ? "ok" : "dim" },
        ],
        caps,
      ),
    );
  }

  rows.push(null, { spans: [{ t: "  what changed", c: "strong" }] });
  state.changes.forEach((c, i) => {
    rows.push({
      spans: [
        { t: "   " },
        { t: String(i + 1), c: "strong" },
        { t: " " + c.path },
        { pad: true },
        dim(`+${String(c.added).padEnd(3)}−${c.removed}`),
        { t: "   " },
      ],
    });
  });
  rows.push({ spans: [dim("  " + " ".repeat(caps.measure - 9) + repeat(7))] });
  rows.push({
    spans: [
      dim(`   ${count(state.changes.length, "file")}`),
      ...(extras.branch ? [dim(" · on branch "), { t: extras.branch, c: "strong" } as Span] : []),
      ...(extras.commits ? [dim(` · ${count(extras.commits, "commit")}`)] : []),
      { pad: true },
      { t: `+${totals.added} −${totals.removed}`, c: "strong" },
      { t: "   " },
    ],
  });

  rows.push(null, { spans: [{ t: "  what was found", c: "strong" }] });
  for (const f of state.findings) {
    const fixed = state.changes.some((c) => c.cause === f.id);
    rows.push(
      ...pair(
        [{ t: "   ◆ " }, dim(f.id), { t: "  " + f.claim }],
        [
          f.outOfScope
            ? ({ t: "real · out of scope · filed", c: "warn" } as Span)
            : dim(fixed ? "fixed · verified" : "filed"),
          { t: "   " },
          { t: RUNG_GLYPH[f.rung], c: f.rung === "verified" ? "ok" : "dim" },
        ],
        caps,
      ),
    );
  }

  // The section that never gets cut, at any width.
  rows.push(null, { spans: [{ t: "  what I did not do", c: "strong" }] });
  // The section that never gets cut, at any width — so it wraps rather than clips.
  // An indented line is a command you are meant to run: it opts out of clipping
  // entirely and soft-wraps instead, because a … in a shell command is a broken
  // command.
  for (const line of extras.notDone) {
    if (line.startsWith("   ")) {
      rows.push({ spans: [{ t: "   " + line.trimStart() }], region: "code", clip: "never" });
      continue;
    }
    for (const l of wrapText(line, caps.measure - 5)) rows.push({ spans: [dim("   " + l)] });
  }

  rows.push(null, { spans: [{ t: "  evidence", c: "strong" }] });
  for (const line of extras.evidence)
    for (const l of wrapText(line, caps.measure - 5)) rows.push({ spans: [dim("   " + l)] });

  rows.push(null, bar(caps));
  // The keys shorten before anything else does: they are the one thing on this screen
  // you already know the meaning of.
  const wide = caps.measure >= 76;
  rows.push({
    spans: [
      { t: "   c", c: "strong" },
      dim(" commit"),
      { t: wide ? "         " : "    " },
      { t: "p", c: "strong" },
      dim(wide ? " open a PR" : " PR"),
      { t: wide ? "      " : "      " },
      { t: "d", c: "strong" },
      dim(wide ? " read the diff" : " diff"),
      { t: wide ? "      " : "    " },
      { t: "?", c: "strong" },
      dim(" ask"),
    ],
  });
  rows.push(bar(caps, "═"));
  return rows;
}

// ─── the inspections ───
// Summoned, not pushed. Work continues behind them — the header says so, and the phase
// indicator keeps moving. None of them pauses anything.

export function changesHold(
  state: MissionState,
  selected: number,
  behind: string,
  caps: Caps,
): Array<Row | null> {
  const totals = diffTotals(state);
  return [
    bar(caps, "═"),
    {
      spans: [
        { t: "  " },
        { t: "CHANGES", c: "strong" },
        dim(`   ${count(state.changes.length, "file")} · +${totals.added} −${totals.removed}`),
        { pad: true },
        dim("work continues behind this  "),
        { pulse: 4 },
        dim(`  ${behind}  `),
      ],
    },
    bar(caps, "═"),
    ...state.changes.map(
      (c, i): Row => ({
        spans: [
          i === selected ? ({ t: ` ${i + 1} `, c: "reverse" } as Span) : dim(` ${i + 1} `),
          { t: " " + c.path },
          { pad: true },
          dim(
            `+${String(c.added).padEnd(3)}−${String(c.removed).padEnd(4)}${count(c.hunks, "hunk").padEnd(8)}${c.cause ?? "—"}   ${c.tests.length ? count(c.tests.length, "test") : "—"}`,
          ),
          { t: "   " },
        ],
      }),
    ),
    bar(caps),
  ];
}

/** The traceability chain, printed under the diff: cause, proof, author. */
export const provenance = (
  cause: string,
  causeText: string,
  test: string,
  testDetail: string,
  who: string,
  caps: Caps,
): Array<Row | null> => [
  bar(caps),
  { spans: [{ t: "  why   ", c: "strong" }, dim(cause), dim("  " + causeText)] },
  { spans: [{ t: "  test  ", c: "strong" }, dim(test), dim("  " + testDetail)] },
  { spans: [{ t: "  who   ", c: "strong" }, dim(who)] },
  bar(caps),
  {
    spans: [
      dim(
        "  ↑↓ file    n hunk    r revert this file    y open the finding    esc back to the stream",
      ),
    ],
  },
  bar(caps, "═"),
];

export function teamHold(state: MissionState, caps: Caps): Array<Row | null> {
  const running = state.agents.filter((a) => a.state === "running").length;
  const returned = state.agents.filter((a) => a.state === "returned").length;
  const failed = state.agents.filter((a) => a.state === "killed" || a.state === "starved").length;
  const tokens = state.agents.reduce((n, a) => n + a.tokens, 0);
  return [
    bar(caps, "═"),
    {
      spans: [
        { t: "  " },
        { t: "TEAM", c: "strong" },
        dim(`   ${running} running · ${returned} returned · ${failed} failed`),
        { pad: true },
        dim(`${Math.round(tokens / 1000)}k tokens this mission  `),
      ],
    },
    bar(caps, "═"),
    {
      spans: [
        { t: "  " },
        { t: "●", c: "accent" },
        { t: " " },
        { t: "you".padEnd(12), c: "strong" },
        dim("the objective, the decisions, the constraints, and the last word"),
      ],
    },
    null,
    ...state.agents.flatMap(
      (a): Array<Row | null> => [
        {
          spans: [
            { t: "    " },
            a.state === "running"
              ? ({ pulse: 4 } as Span)
              : ({
                  t: a.state === "returned" ? "✓" : "✗",
                  c: a.state === "returned" ? "ok" : "danger",
                } as Span),
            { t: " " },
            { t: a.role.padEnd(8), c: "strong" },
            { t: a.objective },
            { pad: true },
            dim(a.tools),
            dim(`   ${a.elapsedMs ? dur(a.elapsedMs) : "—"}`),
            { t: "   " },
          ],
        },
        a.summary ? { spans: [{ t: "      " }, dim(a.summary)] } : null,
      ],
    ),
    bar(caps),
    {
      spans: [
        dim("  only "),
        { t: "gear", c: "strong" },
        dim(" can write to the tree. everyone else is read-only or sandboxed."),
      ],
    },
    { spans: [dim("  ↑↓ select    ⏎ what it actually did    k stop this one    esc back")] },
    bar(caps, "═"),
  ];
}

// ─── the gate ───
// Edits to tracked files need no gate — git is the undo buffer, and prompting for each
// one trains you to press y without reading, which burns the attention needed for the
// one gate that matters. What sits *outside* the undo buffer gets a gate: the command
// verbatim, the blast radius counted, recoverability in plain words, and a third
// option that is neither yes nor no.

export interface Gate {
  headline: string;
  command: string;
  radius: string;
  recoverable: boolean;
  options: string[];
}

export function gateHold(g: Gate): Array<Row | null> {
  return [
    { spans: [{ t: "  ▸  " + g.headline, c: "strong" }] },
    null,
    { spans: [dim("     │ "), { t: g.command }] },
    null,
    { spans: [dim("     " + g.radius)] },
    {
      spans: [
        {
          t: g.recoverable ? "     This can be undone." : "     This cannot be undone.",
          c: "strong",
        },
      ],
    },
    null,
    ...g.options.map(
      (o, i): Row => ({
        spans: [{ t: `     ${i + 1}`, c: "strong" }, dim("   " + o)],
      }),
    ),
    { spans: [dim("     esc  cancel"), dim("  (default)")] },
  ];
}

// ─── recovery, and coming back ───

export interface Restore {
  missionId: string;
  downFor: string;
  objective: string;
  phases: number;
  goodAsOf: string;
  goodDetail: string;
  treeState: string;
  branch: string;
  branchDetail: string;
  lost: string;
  kept: string;
}

/**
 * The log is the mission; everything else is derived. A restart replays to the last
 * checkpoint, compares the tree hash, and answers the only two questions anyone has
 * after a crash — what was lost, and what was not.
 */
export function restored(r: Restore, caps: Caps): Array<Row | null> {
  const title = ` ── restored `;
  return [
    {
      spans: [
        dim(" ── "),
        { t: "restored", c: "strong" },
        dim(
          ` ${repeat(caps.measure - title.length - r.missionId.length - r.downFor.length - 8)} ${r.missionId}  ·  ${r.downFor} `,
        ),
      ],
    },
    {
      spans: [
        dim("    mission      "),
        { t: r.objective },
        { pad: true },
        dim(`${r.phases} phases`),
      ],
    },
    {
      spans: [
        dim("    good as of   "),
        dim(r.goodAsOf),
        { t: "  " },
        { t: "✓", c: "ok" },
        dim(" " + r.goodDetail),
      ],
    },
    { spans: [dim("    your tree    "), { t: r.treeState }] },
    {
      spans: [dim("    branch       "), { t: r.branch, c: "strong" }, dim(" · " + r.branchDetail)],
    },
    { spans: [{ t: "    lost        ", c: "strong" }, dim(" " + r.lost)] },
    { spans: [{ t: "    not lost    ", c: "strong" }, dim(" " + r.kept)] },
    null,
    { spans: [dim("    ⏎ resume    r re-run first    d read the diff    x abandon")] },
  ];
}

/**
 * The first thing on screen when you come back is what *happened*, not where it got
 * to. Two shapes of answer: nothing needed you, or something did — and if something
 * did, how long it has been waiting and what got done anyway.
 */
export function whileAway(state: MissionState, awayFor: string, caps: Caps): Array<Row | null> {
  const open = state.decisions.filter((d) => d.state === "open");
  const closed = state.phases.filter((p) => p.state === "closed");
  const title = " ── while you were away ";
  const rows: Array<Row | null> = [
    {
      spans: [
        dim(" ── "),
        { t: "while you were away", c: "strong" },
        dim(` ${repeat(caps.measure - title.length - awayFor.length - 2)} ${awayFor} `),
      ],
    },
    ...closed.map(
      (p): Row => ({
        spans: [
          { t: "   " },
          {
            t: p.outcome === "met" ? "✓" : p.outcome === "missed" ? "!" : "○",
            c: p.outcome === "met" ? ("ok" as const) : ("warn" as const),
          },
          { t: " " },
          dim(p.index),
          { t: "  " + (p.summary ?? p.title) },
          { pad: true },
          dim(p.rung ? RUNG_GLYPH[p.rung] : ""),
          { t: "   " },
        ],
      }),
    ),
    null,
  ];

  if (!open.length) {
    rows.push({
      spans: [
        { t: "   nothing needed you.", c: "strong" },
        { pad: true },
        dim("⏎ read it all    s skip to now   "),
      ],
    });
    return rows;
  }

  const d = open[0]!;
  rows.push({
    spans: [
      dim(" ── "),
      { t: "waiting for you", c: "strong" },
      dim(` ${repeat(Math.max(0, caps.measure - 30))} held ${dur(d.heldMs ?? d.queuedMs)} `),
    ],
  });
  rows.push({ spans: [{ t: "   ◇ ", c: "strong" }, dim(d.id), { t: "  " + d.question }] });
  rows.push(null);
  rows.push({
    spans: [
      dim(
        `      ${count(d.idleAgents, "agent")} idle · ${dur(d.queuedMs)} of queued work behind it · `,
      ),
      { t: "nothing is lost", c: "strong" },
    ],
  });
  rows.push(null);
  rows.push({ spans: [{ pad: true }, { t: "⏎ decide", c: "strong" }, dim("   ")] });
  return rows;
}
