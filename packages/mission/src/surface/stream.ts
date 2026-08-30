// ─── Gear · the stream ───
// Where the session lives. Ordinary scrollback: written once, never redrawn,
// selectable, greppable, tee-able. It grows downward and it never surprises you with
// a screenful — only the bottom rows redraw, and only because something is running.
//
// Every function here is a projection of reduced state onto rows. Nothing in this file
// reads model prose, and nothing in it can print a `✓` that an event did not carry.

import { RUNG_GLYPH, type Row, type Span, pair, wrapText } from "../render/row";
import { type Caps } from "../render/caps";
import { type DiffLine, foreign, window } from "../render/code";
import { type MissionEvent, type Rung } from "../events";
import {
  type Agent,
  type Change,
  type Check,
  type Constraint,
  type Decision,
  type Finding,
  type MissionState,
  type Phase,
  type Tool,
} from "../reduce";
import { count, dur } from "../format";

/**
 * Three cells of gutter. It costs three columns and it buys navigable scrollback:
 * scroll up a thousand rows and every event still says which phase it belonged to.
 */
export const rail = (index: string, kind: "open" | "mid" | "close"): Span => ({
  t: kind === "open" ? ` ${index}│` : kind === "close" ? `  └` : `  │`,
  c: "dim",
});

/**
 * The right-hand end of a row: detail, then the claim column in the terminal's last
 * cell, always. One character, and it changes what the transcript is — an agent
 * saying "likely unrelated" is worth nothing; an agent whose every assertion carries
 * whether it is suspected, observed, reproduced or verified is worth reading.
 */
function claim(detail: Span[], rung?: Rung): Span[] {
  const out: Span[] = [...detail];
  if (rung) out.push({ t: "   " }, { t: RUNG_GLYPH[rung], c: rung === "verified" ? "ok" : "dim" });
  return out;
}

/** The indent a dropped right-hand column sits at, under the phase rail. */
const under = (index: string) => "  " + " ".repeat(index ? 3 : 3) + "    ";

const dim = (t: string): Span => ({ t, c: "dim" });

// ─── the header ───
// Four rows at minute zero, and then it gets out of the way. There is no logo and no
// mascot; it prints a repo, a branch, a model and a permission posture, because those
// are the facts, and because the gate later is then never a surprise.

export interface HeaderContext {
  version: string;
  repo: string;
  branch: string;
  /** null when this is not a repository at all — then the word is simply not printed */
  treeClean: boolean | null;
  note?: string;
  model: string;
  effort: string;
  sandboxed: boolean;
  /** the permission posture, in words, verbatim on the header row */
  posture: string;
}

export function header(ctx: HeaderContext, caps: Caps): Row[] {
  const measure = caps.measure;
  const title = `─── gear ${ctx.version} `;
  return [
    {
      spans: [
        { t: "─── ", c: "dim" },
        { t: `gear ${ctx.version}`, c: "accent" },
        { t: " " + "─".repeat(Math.max(0, measure - title.length)), c: "dim" },
      ],
    },
    {
      spans: [
        { t: "  " + ctx.repo },
        dim(" · "),
        { t: ctx.branch, c: "accent" },
        // Outside a repo there is nothing to be clean or dirty about. Say nothing
        // rather than defaulting to the reassuring word.
        ...(ctx.treeClean === null ? [] : [dim(` · ${ctx.treeClean ? "clean" : "dirty"}`)]),
        ...(ctx.note ? [dim(` · ${ctx.note}`)] : []),
      ],
    },
    // The permission posture is declared here, at minute zero, so a gate later is
    // never a surprise. At a narrow measure it drops to its own row rather than off
    // the edge — it is the one line on this screen that must not be lost.
    ...pair(
      [dim(`  ${ctx.model} · ${ctx.effort} · ${ctx.sandboxed ? "sandboxed" : "unsandboxed"}`)],
      [{ t: ctx.posture, c: "warn" }],
      caps,
      "  ",
    ),
    { spans: [dim("─".repeat(measure))] },
  ];
}

// ─── the mission ───
// The contract you sign at minute zero and get back, checked off, with its evidence
// attached. These criteria are not prose: they are the objects the terminus checks,
// and only an event carrying evidence can flip one.

export function missionBrief(state: MissionState, caps: Caps): Array<Row | null> {
  const bar = dim("─".repeat(Math.max(0, caps.measure - 4)));
  const label = 14;
  // The label column is fixed; the value reflows under it rather than running off the
  // edge, so the brief is readable at 58 columns without losing a word of the contract.
  const field = (name: string, value: string, role: "body" | "dim"): Row[] =>
    wrapText(value, caps.measure - label - 2).map((line, i) => ({
      spans: [
        dim((i === 0 ? "  " + name : "  ").padEnd(label)),
        role === "dim" ? dim(line) : { t: line },
      ],
    }));

  return [
    ...pair(
      [{ t: "  " }, { t: "MISSION", c: "strong" }, { t: "  " + (state.objective ?? "") }],
      [dim(state.id ?? ""), { t: "  " }],
      caps,
    ),
    { spans: [{ t: "  " }, bar] },
    ...field("in scope", state.scope.join("   "), "body"),
    ...field("untouched", state.exclusions.join("   "), "dim"),
    ...(state.budget ? field("budget", state.budget, "dim") : []),
    null,
    ...state.criteria.flatMap((c, i) =>
      wrapText(c.text, caps.measure - label - 6).map(
        (line, j): Row => ({
          spans: [
            dim((i === 0 && j === 0 ? "  done when" : "  ").padEnd(label)),
            { t: (j === 0 ? " ○  " : "    ") + line },
          ],
        }),
      ),
    ),
    { spans: [{ t: "  " }, bar] },
  ];
}

/**
 * A plan is a living structure, not a monologue. When it changes, the change is
 * printed as a diff with its cause — never as a reprinted plan, which would hide what
 * moved.
 */
export function planRows(state: MissionState, previous?: MissionState): Array<Row | null> {
  const first = !previous || previous.planRevision === 0;
  if (first)
    return [
      {
        spans: [
          { t: "  " },
          { t: "PLAN", c: "strong" },
          dim(`  ${state.phases.length} phases`),
          { pad: true },
          dim(`revision ${state.planRevision}`),
          { t: "  " },
        ],
      },
      ...state.phases.map(phaseRow),
    ];

  const before = new Map(previous.phases.map((p) => [p.index, p]));
  const added = state.phases.filter((p) => !before.has(p.index));
  const changed = state.phases.filter((p) => {
    const b = before.get(p.index);
    return b && (b.title !== p.title || b.dependsOn.join() !== p.dependsOn.join());
  });

  return [
    {
      spans: [
        { t: "  " },
        { t: "PLAN REVISED", c: "strong" },
        ...(state.planCause ? [dim(`  ·  ${state.planCause}`)] : []),
        { pad: true },
        dim(`revision ${state.planRevision}`),
        { t: "  " },
      ],
    },
    ...added.map(
      (p): Row => ({
        spans: [
          { t: "  " },
          { t: "+", c: "ok" },
          dim(` ${p.index}`),
          { t: "  " + p.title },
          { pad: true },
          dim(p.from ? `new · from ${p.from}` : "new"),
          { t: "  " },
        ],
      }),
    ),
    ...changed.map(
      (p): Row => ({
        spans: [dim(`    ${p.index}`), { t: "  " + p.title }],
      }),
    ),
  ];
}

const phaseRow = (p: Phase): Row => ({
  spans: [
    { t: "  ○ " },
    dim(p.index),
    { t: "  " + p.title },
    ...(p.dependsOn.length
      ? [{ pad: true } as Span, dim(`needs ${p.dependsOn.join(", ")}`), { t: "  " }]
      : []),
  ],
});

// ─── events in the stream ───

export const phaseOpened = (p: Phase): Row => ({
  spans: [rail(p.index, "open"), { t: "  " }, { t: p.title, c: "strong" }],
});

export const phaseClosed = (p: Phase, caps: Caps): Row[] =>
  pair(
    [rail(p.index, "close"), { t: "  " + (p.summary ?? "") }],
    claim([dim(dur(p.elapsedMs ?? 0))], p.rung),
    caps,
    under(p.index),
  );

/** A tool that finished. The verb, what it was pointed at, and how it went. */
export function toolEnded(t: Tool, caps: Caps, detail?: Span[]): Row[] {
  const ok = t.exit === 0;
  return pair(
    [
      rail(t.phase ?? "", "mid"),
      { t: "  " },
      dim("⎿"),
      { t: " " },
      { t: ok ? "✓" : "✗", c: ok ? "ok" : "danger" },
      { t: ` ${t.verb.padEnd(5)} ` },
      { t: t.args },
    ],
    claim(detail ?? [dim(t.detail ?? ""), dim("   " + dur(t.elapsedMs ?? 0))], t.rung),
    caps,
    under(t.phase ?? ""),
  );
}

/**
 * A tool that is still running. The only row on the screen that redraws, and the only
 * moving thing on it that is not decoration.
 */
export function toolRunning(t: Tool, level: number, quietMs: number, retry?: string): Row {
  const quiet = quietMs >= 3000;
  return {
    spans: [
      rail(t.phase ?? "", "mid"),
      { t: "  " },
      dim("⎿"),
      { t: " " },
      quiet ? { quiet: true } : { pulse: level },
      { t: ` ${t.verb.padEnd(5)} ` },
      { t: t.args },
      { pad: true },
      // When the process stops the row stops counting and starts saying so in words.
      quiet ? { t: `quiet ${Math.round(quietMs / 1000)}s`, c: "warn" } : dim(t.detail ?? ""),
      ...(retry ? [dim(" · "), dim(retry)] : []),
      { t: "  " },
    ],
    live: true,
  };
}

/**
 * A subagent is not a new shape: it is the agent glyph, recursed. It is a process with
 * a scope, a budget and a result — not a personality. Giving it a face would invite
 * you to trust it for the wrong reason.
 */
export function agentRow(a: Agent, caps: Caps, level?: number): Row[] {
  const running = a.state === "running" || a.state === "spawned";
  const left: Span[] = [
    rail(a.phase ?? "", "mid"),
    { t: "  " },
    dim("⎿"),
    { t: " " },
    running
      ? ({ pulse: level ?? 4 } as Span)
      : ({
          t: a.state === "returned" ? "✓" : "✗",
          c: a.state === "returned" ? "ok" : "danger",
        } as Span),
    { t: " " },
    { t: "●", c: "accent" },
    { t: " " },
    { t: a.role.padEnd(7), c: "strong" },
    { t: running ? a.objective : (a.summary ?? a.objective) },
  ];
  if (running) return [{ spans: left, live: true }];
  return pair(left, claim([dim(dur(a.elapsedMs ?? 0))], a.rung), caps, under(a.phase ?? ""));
}

/** What a subagent was given, printed once when it is spawned. Scope is not implied. */
export const agentScope = (a: Agent, caps: Caps): Row[] =>
  pair(
    [
      rail(a.phase ?? "", "mid"),
      { t: "     " },
      dim(`${a.tools} · ${a.scope.join(" ")} · ${Math.round(a.budgetTokens / 1000)}k budget`),
    ],
    [],
    caps,
  );

/**
 * A finding is a first-class object: an id, evidence at file-and-line, a reproduction,
 * a claim rung, and a pointer at the plan item it creates. It is what a change cites
 * as its cause, and it is reviewable at the end.
 */
export function findingRows(f: Finding, phase: string, caps: Caps): Array<Row | null> {
  const r = (spans: Span[]): Row => ({ spans: [rail(phase, "mid"), ...spans] });
  const rows: Array<Row | null> = [
    ...pair(
      [rail(phase, "mid"), { t: "  " }, { t: "◆  FINDING", c: "strong" }, { t: "   " + f.claim }],
      [dim(f.id), { t: "  " }],
      caps,
      "     ",
    ),
    null,
    ...f.body.flatMap((line) =>
      wrapText(line, caps.measure - 8).map((l) => r([{ t: "     " + l }])),
    ),
  ];

  const files = f.evidence.filter((e) => e.kind === "file");
  if (files.length) {
    rows.push(null);
    for (const e of files)
      if (e.kind === "file")
        rows.push(
          ...pair(
            [
              rail(phase, "mid"),
              { t: "     " },
              { t: `${e.path}${e.line ? ":" + e.line : ""}`, c: "strong" },
            ],
            [dim(e.note ?? "")],
            caps,
            "        ",
          ),
        );
  }

  rows.push(null);
  for (const e of f.evidence) {
    if (e.kind === "reproduction")
      rows.push(
        ...pair(
          [
            rail(phase, "mid"),
            { t: "     " },
            dim(`reproduced ${e.hits} of ${e.runs} · ${e.command}`),
          ],
          claim([], f.rung),
          caps,
          "        ",
        ),
      );
  }
  if (f.outOfScope) {
    rows.push(r([{ t: "     " }, dim("Real. Reproduced.")]));
    for (const line of wrapText(
      "Outside the scope you set, so I have not touched it.",
      caps.measure - 8,
    ))
      rows.push(r([{ t: "     " }, { t: line, c: "strong" }]));
  }
  if (f.creates) rows.push(r([{ t: "     " }, dim(`→ ${f.creates}`)]));
  return rows;
}

/** A change cites the finding that caused it. A change with no cause is worth noticing. */
export function changeRow(c: Change, caps: Caps, phase: string, index: number): Row[] {
  return pair(
    [
      rail(phase, "mid"),
      { t: "  " },
      dim("⎿"),
      { t: " " },
      { t: "✓", c: "ok" },
      { t: c.newFile ? " write  " : " edit   " },
      { t: c.path },
    ],
    [
      dim(
        `+${String(c.added).padEnd(3)}−${String(c.removed).padEnd(3)}· ${c.newFile ? "new file" : count(c.hunks, "hunk")}`,
      ),
      { t: "     " },
      { t: String(index), c: "strong" },
      { t: "   " },
    ],
    caps,
    under(phase),
  );
}

/**
 * A check row. `passed / total` is a count, and the baseline fields are what let the
 * next row say *proven, not assumed* when something fails.
 */
export function checkRow(c: Check, caps: Caps, phase: string): Row[] {
  const green = c.passed === c.total;
  return pair(
    [
      rail(phase, "mid"),
      { t: "  " },
      { t: green ? "✓" : "✗", c: green ? "ok" : "danger" },
      { t: " " + c.kind },
    ],
    [
      { t: `${c.passed} / ${c.total}`, c: green ? "ok" : "danger" },
      dim(`   ${c.runner}   ${dur(c.elapsedMs)}`),
      { t: "   " },
      { t: RUNG_GLYPH[c.rung], c: c.rung === "verified" ? "ok" : "dim" },
    ],
    caps,
    under(phase),
  );
}

/** Checks that have not run yet. Queued is a state, not an absence. */
export const queuedCheck = (kind: string, runner: string, phase: string): Row => ({
  spans: [
    rail(phase, "mid"),
    { t: "  ○ " },
    dim(kind),
    { pad: true },
    dim(runner),
    dim("               queued"),
    { t: "  " },
  ],
});

/**
 * A failure the agent proved was not its own. It either stashed the change and ran the
 * test on the parent commit, or it does not know — the claim column has no rung for
 * "probably".
 */
export const preExisting = (c: Check, phase: string, filedAs: string): Row => ({
  spans: [
    rail(phase, "mid"),
    { t: "  " },
    { t: "!", c: "warn" },
    { t: " not mine — proven, not assumed. filed as " },
    { t: filedAs, c: "strong" },
    dim(", left alone."),
    { pad: true },
    dim(filedAs),
    { t: "   " },
  ],
});

/**
 * Typing prose during execution is not an interrupt. It is a constraint on the
 * mission, and the agent answers it as one: what changed, what it applies to, what it
 * costs, and how to undo it. Execution never pauses.
 */
export function constraintRows(c: Constraint): Array<Row | null> {
  return [
    {
      spans: [
        { t: "  " },
        { t: "●", c: "accent" },
        { t: "  " },
        { t: "CONSTRAINT", c: "strong" },
        dim(`  ${c.id} · yours · holds for the rest of the mission`),
      ],
    },
    null,
    { spans: [dim("     " + c.text)] },
    null,
    ...c.affects.map((a) => ({ spans: [dim("     affects  "), { t: a }] })),
    { spans: [dim("     revert   "), dim(c.reverts)] },
    ...c.cost.map(
      (line, i): Row => ({
        spans: [dim(i === 0 ? "     cost     " : "              "), dim(line)],
      }),
    ),
  ];
}

/** A decision, once taken, becomes one row in the stream. The hold is over. */
export const decisionTaken = (d: Decision, phase: string, caps: Caps): Row[] => [
  {
    spans: [
      rail(phase, "mid"),
      { t: "  " },
      { t: `◇  ${d.id}`, c: "strong" },
      { t: "  you took " },
      { t: d.chosen ?? "", c: "strong" },
      dim(` — ${d.options.find((o) => o.key === d.chosen)?.title ?? ""}`),
      { pad: true },
      dim(`held ${dur(d.heldMs ?? 0)}`),
      { t: "  " },
    ],
  },
  ...(d.note
    ? wrapText(d.note, caps.measure - 8).map(
        (l): Row => ({
          spans: [rail(phase, "mid"), { t: "     " }, dim(l)],
        }),
      )
    : []),
];

/** A diff, opened in the stream. Twelve rows, counted elision, and the keys that act on it. */
export function diffWindow(
  path: string,
  hunk: string,
  lines: DiffLine[],
  phase: string,
  index: number,
): Array<Row | null> {
  const head: Row = {
    spans: [
      rail(phase, "mid"),
      { t: "    " },
      { t: String(index), c: "strong" },
      dim(`  ${path}   ·   ${hunk}`),
    ],
  };
  const keys: Row = {
    spans: [
      rail(phase, "mid"),
      dim("      ⏎ full screen    n next hunk    w why this change    r revert"),
    ],
  };
  return [head, ...window(lines, "  │"), keys];
}

export { foreign };

// ─── the projection ───
// One event in, the rows it puts into scrollback out. This is the only place that
// decides what the stream says, and it reads nothing but reduced state — which is what
// makes the whole surface deterministic and replayable.

export function project(
  ev: MissionEvent,
  state: MissionState,
  previous: MissionState,
  caps: Caps,
): Array<Row | null> {
  switch (ev.type) {
    case "MISSION_OPENED":
      return missionBrief(state, caps);

    case "PLAN_SET":
      return [...planRows(state, previous.planRevision ? previous : undefined), null];

    case "PHASE_OPENED": {
      const p = state.phases.find((x) => x.index === ev.index);
      return p ? [phaseOpened(p)] : [];
    }

    case "PHASE_CLOSED": {
      const p = state.phases.find((x) => x.index === ev.index);
      return p ? [...phaseClosed(p, caps), null] : [];
    }

    case "TOOL_ENDED": {
      const t = state.tools.find((x) => x.id === ev.id);
      return t ? toolEnded(t, caps) : [];
    }

    case "AGENT_SPAWNED": {
      const a = state.agents.find((x) => x.id === ev.id);
      return a ? agentScope(a, caps) : [];
    }

    case "AGENT_RETURNED": {
      const a = state.agents.find((x) => x.id === ev.id);
      return a ? agentRow(a, caps) : [];
    }

    case "FINDING_OPENED": {
      const f = state.findings.find((x) => x.id === ev.id);
      const phase = state.phases.find((p) => p.state === "running")?.index ?? "";
      return f ? [null, ...findingRows(f, phase, caps), null] : [];
    }

    case "CHANGE_APPLIED": {
      const i = state.changes.length - 1;
      const phase = state.phases.find((p) => p.state === "running")?.index ?? "";
      return changeRow(state.changes[i]!, caps, phase, i + 1);
    }

    case "CHECK_RESULT": {
      const c = state.checks[state.checks.length - 1]!;
      const phase = state.phases.find((p) => p.state === "running")?.index ?? "";
      return checkRow(c, caps, phase);
    }

    case "DECISION_TAKEN": {
      const d = state.decisions.find((x) => x.id === ev.id);
      const phase = state.phases.find((p) => p.state === "running")?.index ?? "";
      return d ? [...decisionTaken(d, phase, caps), null] : [];
    }

    case "CONSTRAINT_ADDED": {
      const c = state.constraints[state.constraints.length - 1]!;
      return [null, ...constraintRows(c), null];
    }

    // Everything else changes state without putting a row in the stream: progress
    // drives the pulse, checkpoints are silent, and a decision *opening* takes the
    // screen rather than appending to it.
    default:
      return [];
  }
}
