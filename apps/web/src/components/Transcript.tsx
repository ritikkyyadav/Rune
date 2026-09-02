import { useEffect, useRef } from "react";
import { GearMark } from "./GearMark";
import { Markdown } from "../lib/markdown";
import {
  checkBadge,
  plural,
  receipt,
  splitResponse,
  type StreamItem,
  type TurnState,
} from "../lib/stream";
import type { PermissionDecision } from "../lib/types";

// ─── Transcript: the v2 stream grammar, rendered ───

function CmdTree({ text, hint, bad }: { text: string; hint?: string; bad?: boolean }) {
  const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return (
    <div className="cmd-tree">
      <span className="tree-branch">└</span>
      <span className="cmd-prompt">$</span>
      <span className="cmd-body">
        {tokens.map((token, index) => {
          const cls = /^(['"]).*\1$/.test(token)
            ? "cmd-str"
            : /^-{1,2}[\w-]+/.test(token)
              ? "cmd-flag"
              : index === 0
                ? "cmd-kw"
                : "";
          return (
            <span key={index} className={cls}>
              {token}{" "}
            </span>
          );
        })}
        {hint ? <span className={bad ? "cmd-bad" : "cmd-str"}># {hint}</span> : null}
      </span>
    </div>
  );
}

function DiffCardView({
  diff,
}: {
  diff: NonNullable<Extract<StreamItem, { kind: "tool" }>["diff"]>;
}) {
  return (
    <div className="diff-card">
      <div className="diff-header">
        <span>{diff.path}</span>
        <span className="counts">
          <span className="stat-add">+{diff.added}</span>{" "}
          <span className="stat-rem">−{diff.removed}</span> · {diff.range}
        </span>
      </div>
      <div className="diff-body">
        {diff.lines.map((line, index) => (
          <div key={index} className={`diff-line ${line.kind}`}>
            <span className="diff-no">{line.no ?? ""}</span>
            <span className="diff-marker">
              {line.kind === "add" ? "+" : line.kind === "rem" ? "-" : " "}
            </span>
            <span className="diff-code">{line.text || " "}</span>
          </div>
        ))}
        {diff.hiddenLines > 0 ? (
          <div className="diff-more">… {diff.hiddenLines} more diff lines</div>
        ) : null}
      </div>
    </div>
  );
}

function riskRows(
  prompt: Extract<StreamItem, { kind: "permission" }>["prompt"],
  sandboxed: boolean,
) {
  const rows: Array<{ label: string; value: string; tone: "ok" | "warn" | "bad" | "" }> = [];
  const args = prompt.rawArgs ?? {};
  if (prompt.toolName === "bash") {
    const network = args.network === true;
    rows.push({
      label: "writes outside workspace",
      value: network ? "possible (host)" : sandboxed ? "blocked (sandbox)" : "possible (host)",
      tone: network || !sandboxed ? "warn" : "ok",
    });
    rows.push({
      label: "network egress",
      value: network ? "requested" : sandboxed ? "blocked" : "open (host)",
      tone: network || !sandboxed ? "warn" : "ok",
    });
    const timeout = Number(args.timeout_ms) > 0 ? Math.ceil(Number(args.timeout_ms) / 1000) : 120;
    rows.push({
      label: "est. runtime",
      value: `≤${timeout}s cap`,
      tone: timeout > 120 ? "warn" : "",
    });
  } else if (/^(edit_file|multi_edit|write_file)$/.test(prompt.toolName)) {
    rows.push({ label: "writes outside workspace", value: "no", tone: "ok" });
    rows.push({ label: "network egress", value: "none", tone: "ok" });
  } else if (/^web_/.test(prompt.toolName)) {
    rows.push({ label: "writes outside workspace", value: "no", tone: "ok" });
    rows.push({
      label: "network egress",
      value: String(args.url ?? args.uri ?? "web search"),
      tone: "warn",
    });
  }
  if (prompt.rateLimit && prompt.rateLimit.limit > 0) {
    const next = Math.min(prompt.rateLimit.limit, prompt.rateLimit.used + 1);
    rows.push({
      label: "rate limit",
      value: `${next}/${prompt.rateLimit.limit} per min`,
      tone: next >= prompt.rateLimit.limit ? "warn" : "",
    });
  }
  return rows;
}

function PermissionCard({
  item,
  sandboxed,
  gearLabel,
  onDecide,
}: {
  item: Extract<StreamItem, { kind: "permission" }>;
  sandboxed: boolean;
  gearLabel: string;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
}) {
  const p = item.prompt;
  const tag =
    p.toolName === "bash"
      ? p.rawArgs?.network === true
        ? "bash · host · network"
        : sandboxed
          ? "bash · sandboxed"
          : "bash · host"
      : `${p.toolName}${/^(edit_file|multi_edit|write_file)$/.test(p.toolName) ? " · workspace" : /^web_/.test(p.toolName) ? " · network" : ""}`;
  const body =
    p.toolName === "bash"
      ? String(p.rawArgs?.command ?? p.argsSummary.replace(/^bash:\s*/, ""))
      : p.argsSummary.replace(new RegExp(`^${p.toolName}[:\\s]\\s*`), "");
  const decided = item.decision;
  return (
    <div
      className={`perm-card ${decided ? "decided" : ""}`}
      role="group"
      aria-label="Permission request"
    >
      <div className="perm-head">
        <span className="perm-icon">⚠</span>
        <span>Permission required</span>
        <span className="perm-tag">{tag}</span>
        {p.safety ? <span className="perm-tag">classifier · risk {p.safety.risk}</span> : null}
      </div>
      {p.safety?.reason ? (
        <div className="perm-reason">
          <b>Why Gear paused:</b> {p.safety.reason}
        </div>
      ) : null}
      <div className="perm-cmd">{p.toolName === "bash" ? `$ ${body}` : body}</div>
      <div className="perm-risk">
        {riskRows(p, sandboxed).map((r) => (
          <span key={r.label}>
            {r.label}: <span className={r.tone}>{r.value}</span>
          </span>
        ))}
      </div>
      {decided ? (
        <div className={`perm-decision ${decided === "deny" ? "bad" : "ok"}`}>
          {decided === "deny"
            ? "✕ denied"
            : decided === "allow_session"
              ? "✓ allowed for this session"
              : "✓ allowed once"}{" "}
          · recorded in the audit trail
        </div>
      ) : (
        <div className="perm-actions">
          <button
            className="perm-btn primary"
            onClick={() => onDecide(item.requestId, "allow_once")}
          >
            Allow once <kbd>y</kbd>
          </button>
          <button className="perm-btn" onClick={() => onDecide(item.requestId, "allow_session")}>
            Allow for session <kbd>a</kbd>
          </button>
          <button className="perm-btn deny" onClick={() => onDecide(item.requestId, "deny")}>
            Deny <kbd>n</kbd>
          </button>
        </div>
      )}
      <div className="perm-note">
        {p.toolName === "bash" ? "Command has not run" : "Working tree unchanged"} · the decision is
        appended to the tamper-evident audit trail · {gearLabel} asks here
      </div>
    </div>
  );
}

function StatusRow({ turn, now }: { turn: TurnState; now: number }) {
  const s = turn.status;
  const live = !turn.endedAt;
  if (!live && s === "complete" && turn.items.length === 0 && !turn.prose) return null;
  const label =
    s === "thinking"
      ? "Thinking…"
      : s === "running"
        ? "Running tools…"
        : s === "verifying"
          ? "Verifying…"
          : s === "synthesizing"
            ? "Synthesizing…"
            : s === "waiting"
              ? "Waiting on approval…"
              : s === "complete"
                ? "Complete."
                : s === "notes"
                  ? "Done with notes"
                  : s === "failed"
                    ? "Needs attention"
                    : "Interrupted.";
  const cls = s === "waiting" ? "waiting" : live ? "working" : s;
  const meta = live
    ? receipt(turn, now)
    : s === "interrupted"
      ? `${receipt(turn, now)} · esc · partial work kept`
      : receipt(turn, now);
  return (
    <div className="status-row" aria-live="polite">
      {live ? (
        <span className={`working-dot ${s === "waiting" ? "waiting" : ""}`.trim()} aria-hidden />
      ) : (
        <span className={`status-check-done ${s}`}>
          {s === "complete" ? "✓" : s === "notes" ? "!" : s === "failed" ? "✕" : "■"}
        </span>
      )}
      <span className={`status-label ${cls}`}>{label}</span>
      <span className="status-meta">({meta})</span>
      {live && turn.statusDetail ? (
        <span className="status-detail">{turn.statusDetail}</span>
      ) : null}
    </div>
  );
}

function SummaryStrips({ turn }: { turn: TurnState }) {
  const passed = turn.checks.filter((c) => c.status === "passed");
  const failed = turn.checks.filter((c) => c.status === "failed");
  const added = turn.files.reduce((n, f) => n + f.added, 0);
  const removed = turn.files.reduce((n, f) => n + f.removed, 0);
  const metrics: React.ReactNode[] = [];
  if (turn.files.length > 0) {
    metrics.push(<span key="files">{plural(turn.files.length, "file")} changed</span>);
    if (added || removed)
      metrics.push(
        <span key="pm">
          <span className="stat-add">+{added}</span> <span className="stat-rem">−{removed}</span>
        </span>,
      );
  }
  if (turn.files.length > 0 && passed.length === 0)
    metrics.push(
      <span key="nv" className="stat-warn">
        verification not observed
      </span>,
    );
  if (turn.reroutes > 0)
    metrics.push(<span key="rr">{plural(turn.reroutes, "model switch", "model switches")}</span>);
  if (turn.checkpoint)
    metrics.push(
      <span key="ck">checkpoint v{turn.checkpoint.version} saved · /rewind to undo</span>,
    );
  if (passed.length === 0 && failed.length === 0 && metrics.length === 0) return null;
  return (
    <>
      {passed.length > 0 ? (
        <div className="summary-strip">
          {passed.slice(-3).map((c, i) => (
            <div className="stat-group" key={i}>
              <span className="stat-check">✓</span> {checkBadge(c)}
            </div>
          ))}
        </div>
      ) : failed.length > 0 ? (
        <div className="summary-strip">
          <div className="stat-group">
            <span className="stat-x">✕</span> {failed.at(-1)!.label}
          </div>
        </div>
      ) : null}
      {metrics.length > 0 ? (
        <div className="summary-strip">
          {metrics.map((m, i) => (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 ? <span className="stat-sep">·</span> : null}
              {m}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ItemView({
  item,
  sandboxed,
  gearLabel,
  highlightCallId,
  onDecide,
  onShowInTrace,
}: {
  item: StreamItem;
  sandboxed: boolean;
  gearLabel: string;
  highlightCallId?: string | null;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  onShowInTrace: (callId: string) => void;
}) {
  switch (item.kind) {
    case "summary":
      return <div className="summary-line">{item.text}</div>;
    case "plan":
      return (
        <div className="plan-bullet">
          <span className="bullet-dot">●</span>
          <div className="plan-content">
            {item.first ? <strong>Plan: </strong> : null}
            {item.text}
          </div>
        </div>
      );
    case "todo":
      return (
        <div className="plan-bullet">
          <span className="bullet-dot">●</span>
          <div
            className="plan-content"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span>
              <strong>Plan:</strong>{" "}
              {item.items.find((t) => t.status === "in_progress")?.content ??
                `${item.items.length} steps`}
            </span>
            <div className="todo" style={{ marginLeft: 0 }}>
              {item.items.map((t, i) => (
                <div key={i}>
                  <span
                    className={
                      t.status === "completed"
                        ? "done"
                        : t.status === "in_progress"
                          ? "now"
                          : "later"
                    }
                  >
                    {t.status === "completed" ? "✓" : t.status === "in_progress" ? "›" : "○"}
                  </span>
                  <span>{t.content}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    case "tool":
      return (
        <div className={`tool-bullet ${highlightCallId === item.callId ? "evidence-hi" : ""}`}>
          <div className={`tool-header ${item.status === "error" ? "failed" : ""}`}>
            <span className="bullet-dot">●</span>
            <span>
              {item.verb}
              {item.target ? (
                <>
                  {" "}
                  <span className="file-target">{item.target}</span>
                </>
              ) : null}
              {item.meta.length ? (
                <span className="tool-meta"> · {item.meta.join(" · ")}</span>
              ) : null}
              {item.error ? <span className="tool-error"> · {item.error}</span> : null}
            </span>
            <button className="trace-link" onClick={() => onShowInTrace(item.callId)}>
              show in trace ›
            </button>
          </div>
          {item.cmd ? (
            <CmdTree text={item.cmd.text} hint={item.cmd.hint} bad={item.cmd.bad} />
          ) : null}
          {item.diff ? <DiffCardView diff={item.diff} /> : null}
        </div>
      );
    case "permission":
      return (
        <PermissionCard
          item={item}
          sandboxed={sandboxed}
          gearLabel={gearLabel}
          onDecide={onDecide}
        />
      );
    case "fallback": {
      const status =
        item.status === 429 ? "429 (rate limited)" : item.status ? String(item.status) : "";
      const what = status
        ? `${item.from.provider}/${item.from.model} returned ${status}${item.reason && !status.includes(item.reason) ? ` — ${item.reason}` : ""}.`
        : item.reason
          ? `${item.from.provider}/${item.from.model} failed — ${item.reason}.`
          : `${item.from.provider}/${item.from.model} is unavailable.`;
      const rest = (item.chain ?? []).filter(
        (p) => p !== item.to.provider && p !== item.from.provider,
      );
      return (
        <div className="fallback-card" role="alert">
          <div className="fallback-head">
            <span>◆</span>
            <span>Provider degraded — gateway fallback engaged</span>
          </div>
          <div className="fallback-detail">{what} Falling back per provider chain.</div>
          <div className="fallback-meta">
            <span>chain: {[item.from.provider, item.to.provider, ...rest].join(" → ")}</span>
            <span className="ok">
              ✓ resumed on {item.to.provider}/{item.to.model}
            </span>
            <span>turn continues · nothing lost</span>
          </div>
        </div>
      );
    }
    case "compaction": {
      const pct = (n: number) =>
        item.limitTokens > 0 ? `${Math.round((n / item.limitTokens) * 100)}%` : `${n}`;
      const after = item.limitTokens > 0 ? (item.afterTokens / item.limitTokens) * 100 : 0;
      return (
        <div className="ctx-compact" role="status">
          <span className="ctx-label">✓ compacted{item.forced ? " (window exceeded)" : ""}</span>
          <span>
            {item.summarizedCount ? `${item.summarizedCount} older messages summarized · ` : ""}
            context {pct(item.beforeTokens)} → {pct(item.afterTokens)}
          </span>
          <div className="bar">
            <i style={{ width: `${Math.max(0, Math.min(100, after))}%` }} />
          </div>
          <span>
            −
            {Math.max(0, item.beforeTokens - item.afterTokens) >= 1000
              ? `${Math.round((item.beforeTokens - item.afterTokens) / 1000)}k`
              : item.beforeTokens - item.afterTokens}{" "}
            tokens
          </span>
        </div>
      );
    }
    case "verification":
      return (
        <div className="verify-row">
          <span className={item.report === "" ? "" : item.ran ? (item.passed ? "ok" : "bad") : ""}>
            {item.report === "" ? "○" : item.ran ? (item.passed ? "✓" : "✕") : "○"}
          </span>
          <span>
            {item.report === ""
              ? "Running the project checks…"
              : item.ran
                ? item.report.split("\n").filter(Boolean).slice(0, 2).join(" · ")
                : "No project checks were detected"}
          </span>
        </div>
      );
    case "error":
      return (
        <div className="error-row">
          <span className="x">✕</span>
          <span>{item.message}</span>
        </div>
      );
    case "notice":
      return (
        <div className="notice-row">
          <span className="dot">•</span>
          <span>{item.message}</span>
        </div>
      );
    default:
      return null;
  }
}

function TurnView({
  turn,
  now,
  sandboxed,
  gearLabel,
  highlightCallId,
  onDecide,
  onShowInTrace,
  workspace,
}: {
  turn: TurnState;
  now: number;
  sandboxed: boolean;
  gearLabel: string;
  highlightCallId?: string | null;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  onShowInTrace: (callId: string) => void;
  workspace?: string;
}) {
  const live = !turn.endedAt;
  const { headline, detail } = splitResponse(turn.prose);
  const showResponse = !live || turn.status === "synthesizing";
  const receiptLabel = [
    `turn ${turn.turn}`,
    turn.checkpoint ? `checkpoint v${turn.checkpoint.version}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="turn" aria-label={`Turn ${turn.turn}`}>
      <div className="task-bar open">
        <span className="task-chev">›</span>
        <span className="task-text">{turn.task}</span>
        <span className="task-turn">{receiptLabel}</span>
      </div>
      <div className="cli-stream">
        {turn.items.map((item) => (
          <ItemView
            key={item.id}
            item={item}
            sandboxed={sandboxed}
            gearLabel={gearLabel}
            highlightCallId={highlightCallId}
            onDecide={onDecide}
            onShowInTrace={onShowInTrace}
          />
        ))}
        <StatusRow turn={turn} now={now} />
        {showResponse && turn.prose.trim() ? (
          <div className="agent-response">
            {headline ? <div className="resp-headline">{headline}</div> : null}
            <div className="resp-detail">
              <Markdown source={headline ? detail : turn.prose} streaming={live} />
            </div>
            {!live ? <SummaryStrips turn={turn} /> : null}
          </div>
        ) : !live ? (
          <div className="agent-response">
            <SummaryStrips turn={turn} />
          </div>
        ) : null}
      </div>
      {workspace ? null : null}
    </section>
  );
}

const STARTERS = [
  {
    title: "Explore this codebase",
    prompt:
      "Explore this codebase and explain the architecture, runtime flow, and the unfinished areas — cite the files you read.",
    desc: "Map the architecture, runtime, and unfinished areas.",
  },
  {
    title: "Ship a small feature end to end",
    prompt:
      "Pick a small, valuable feature in this project, implement it, run the checks, and show me the diff.",
    desc: "Implement, verify with the real checks, leave a checkpoint.",
  },
  {
    title: "Review and tighten",
    prompt:
      "Review the current code for correctness and clarity, then fix the highest-impact issues and verify.",
    desc: "Find the highest-impact issues and fix them.",
  },
];

export function Transcript(props: {
  turns: TurnState[];
  now: number;
  sandboxed: boolean;
  gearLabel: string;
  highlightCallId?: string | null;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  onShowInTrace: (callId: string) => void;
  onStarter: (prompt: string) => void;
  demo?: { available: boolean; onRun: () => void };
  workspace?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  return (
    <div className="stream-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="stream-inner">
        {props.turns.length === 0 ? (
          <div className="empty-state">
            <GearMark size={40} />
            <h2>Give Gear a coding task.</h2>
            <p>
              It narrates what it will do before it does it, shows every tool it runs with the
              evidence, asks before anything risky in your current gear, and leaves a checkpoint you
              can rewind. The trace rail on the right records every model call, tool, permission and
              checkpoint of each turn.
            </p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s.title} className="starter" onClick={() => props.onStarter(s.prompt)}>
                  <b>{s.title}</b>
                  {s.desc}
                </button>
              ))}
              {props.demo?.available ? (
                <button className="starter" onClick={props.demo.onRun}>
                  <b>Run the demo turn</b>
                  Browser preview only: replays a recorded turn through the real renderers — no
                  engine attached.
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          props.turns.map((turn) => (
            <TurnView
              key={turn.turn}
              turn={turn}
              now={props.now}
              sandboxed={props.sandboxed}
              gearLabel={props.gearLabel}
              highlightCallId={props.highlightCallId}
              onDecide={props.onDecide}
              onShowInTrace={props.onShowInTrace}
              workspace={props.workspace}
            />
          ))
        )}
      </div>
    </div>
  );
}
