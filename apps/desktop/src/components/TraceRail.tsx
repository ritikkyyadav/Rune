import { useMemo, useState } from "react";
import {
  fmtMs,
  fmtTokens,
  spanDepth,
  type SpanKind,
  type TraceSpan,
  type TraceState,
  type TraceTurn,
} from "../lib/trace";

const GLYPH: Record<SpanKind, string> = {
  model: "◆",
  tool: "●",
  permission: "⚠",
  checkpoint: "▣",
  fallback: "◆",
  compaction: "✓",
  verification: "✓",
  error: "✕",
  response: "▸",
};

const FILTERS: Array<{ key: string; label: string; kinds: SpanKind[] }> = [
  { key: "model", label: "model", kinds: ["model"] },
  { key: "tool", label: "tools", kinds: ["tool"] },
  { key: "permission", label: "permissions", kinds: ["permission"] },
  { key: "checkpoint", label: "checkpoints", kinds: ["checkpoint", "verification", "compaction"] },
  { key: "provider", label: "provider", kinds: ["fallback", "error"] },
  { key: "response", label: "response", kinds: ["response"] },
];

function spanMeta(span: TraceSpan): string {
  switch (span.kind) {
    case "model": {
      const t = span.tokens ?? {};
      const parts = [];
      if (t.in != null || t.out != null)
        parts.push(`↑ ${fmtTokens(t.in ?? 0)} ↓ ${fmtTokens(t.out ?? 0)}`);
      if (t.thinkingMs) parts.push(`thought ${(t.thinkingMs / 1000).toFixed(1)}s`);
      if (span.model?.servedBy) parts.push(`served by ${span.model.servedBy}`);
      return parts.join(" · ") || (span.status === "running" ? "generating…" : "");
    }
    case "tool": {
      const t = span.tool;
      const parts = [];
      if (t?.exitCode != null) parts.push(`exit ${t.exitCode}`);
      if (t?.posture) parts.push(t.posture);
      if (t?.hashGuarded) parts.push("hash-guarded");
      if (t?.error) parts.push(t.error.slice(0, 60));
      return parts.join(" · ");
    }
    default:
      return span.detail ?? "";
  }
}

function Inspector({
  span,
  turn,
  onShowInTranscript,
}: {
  span: TraceSpan | null;
  turn: TraceTurn | null;
  onShowInTranscript?: (callId: string) => void;
}) {
  if (!span) {
    return (
      <div className="inspector">
        <div className="insp-empty">
          Select a span to inspect it — model calls show tokens, timing and which provider served
          them; tools show arguments, results and posture; permissions show the decision and the
          gear that asked.{turn ? "" : " Start a task to begin a trace."}
        </div>
      </div>
    );
  }
  const rows: Array<[string, React.ReactNode]> = [];
  const dur = span.endedAt
    ? fmtMs(span.endedAt - span.startedAt)
    : span.status === "running" || span.status === "pending"
      ? "running"
      : "";
  rows.push([
    "status",
    <span
      className={
        span.status === "error" || span.status === "denied"
          ? "bad"
          : span.status === "pending"
            ? "warn"
            : "ok"
      }
    >
      {span.status}
    </span>,
  ]);
  if (dur) rows.push(["duration", dur]);
  let block: { label: string; text: string } | null = null;
  switch (span.kind) {
    case "model":
      rows.push([
        "provider",
        <>
          <b>{span.model?.provider}</b> · {span.model?.model}
          {span.model?.servedBy ? (
            <>
              {" "}
              · served by <b>{span.model.servedBy}</b>
            </>
          ) : null}
        </>,
      ]);
      if (span.tokens)
        rows.push([
          "tokens",
          `↑ ${fmtTokens(span.tokens.in ?? 0)} in · ↓ ${fmtTokens(span.tokens.out ?? 0)} out${span.tokens.thinkingMs ? ` · thought for ${(span.tokens.thinkingMs / 1000).toFixed(1)}s` : ""}`,
        ]);
      rows.push([
        "decided",
        <>
          {(
            turn?.spans
              .filter((s) => s.parentId === span.id && s.kind === "tool")
              .map((s) => s.tool?.name) ?? []
          ).join(", ") || "no tool calls"}
        </>,
      ]);
      rows.push([
        "messages",
        "the engine sends: system prompt · repo map · the task · every tool result so far (prompt assembly inspector lands in M3)",
      ]);
      break;
    case "tool": {
      const t = span.tool!;
      rows.push(["tool", <b>{t.name}</b>]);
      rows.push([
        "args",
        <span>
          {Object.entries(t.args ?? {})
            .map(
              ([k, v]) =>
                `${k}: ${typeof v === "string" ? (v.length > 80 ? v.slice(0, 79) + "…" : v) : JSON.stringify(v)}`,
            )
            .join(" · ") || "—"}
        </span>,
      ]);
      if (t.posture)
        rows.push([
          "posture",
          <span className={t.posture === "sandboxed" ? "ok" : "warn"}>{t.posture}</span>,
        ]);
      if (t.hashGuarded)
        rows.push([
          "freshness",
          <span className="ok">hash-guarded edit (read-before-edit + content hash)</span>,
        ]);
      if (t.exitCode != null)
        rows.push([
          "exit code",
          <span className={t.exitCode === 0 ? "ok" : "bad"}>{t.exitCode}</span>,
        ]);
      if (t.error) rows.push(["error", <span className="bad">{t.error}</span>]);
      if (t.diff) block = { label: "diff", text: t.diff };
      else if (t.result)
        block = {
          label: "result",
          text: t.result.length > 4000 ? t.result.slice(0, 4000) + "\n…" : t.result,
        };
      break;
    }
    case "permission": {
      const p = span.permission;
      rows.push([
        "decision",
        p?.decision ? (
          <b>
            {p.decision === "deny"
              ? "denied"
              : p.decision === "allow_session"
                ? "allowed for session"
                : p.decision === "auto"
                  ? "auto-approved"
                  : "allowed once"}
          </b>
        ) : (
          <span className="warn">waiting on approval</span>
        ),
      ]);
      if (p?.waitedMs != null) rows.push(["waited", fmtMs(p.waitedMs)]);
      if (p?.prompt) rows.push(["asked for", `${p.prompt.toolName} · ${p.prompt.argsSummary}`]);
      if (p?.prompt?.safety)
        rows.push([
          "classifier",
          `${p.prompt.safety.reason} · risk ${p.prompt.safety.risk} · ${p.prompt.safety.tier}`,
        ]);
      rows.push(["audit", "decision appended to the hash-chained audit log"]);
      break;
    }
    case "checkpoint":
      rows.push(["version", <b>v{span.checkpoint?.version}</b>]);
      rows.push(["run", span.checkpoint?.runId ?? ""]);
      rows.push(["restore", "/rewind"]);
      break;
    case "fallback": {
      const f = span.fallback!;
      rows.push(["from", `${f.from.provider}/${f.from.model}`]);
      rows.push([
        "why",
        f.status === 429
          ? "429 rate limited"
          : (f.reason ?? String(f.status ?? "provider degraded")),
      ]);
      rows.push([
        "resumed on",
        <b>
          {f.to.provider}/{f.to.model}
        </b>,
      ]);
      if (f.chain?.length)
        rows.push([
          "chain",
          [
            f.from.provider,
            f.to.provider,
            ...f.chain.filter((p) => p !== f.to.provider && p !== f.from.provider),
          ].join(" → "),
        ]);
      break;
    }
    case "compaction": {
      const c = span.compaction!;
      const pct = (n: number) =>
        c.limitTokens > 0 ? `${Math.round((n / c.limitTokens) * 100)}%` : `${n}`;
      rows.push([
        "context",
        `${pct(c.beforeTokens)} → ${pct(c.afterTokens)} · −${fmtTokens(Math.max(0, c.beforeTokens - c.afterTokens))} tokens`,
      ]);
      if (c.summarizedCount) rows.push(["summarized", `${c.summarizedCount} older messages`]);
      break;
    }
    case "verification":
      rows.push(["ran", span.verification?.ran ? "yes" : "no checks detected"]);
      rows.push([
        "result",
        span.verification?.ran ? (
          <span className={span.verification.passed ? "ok" : "bad"}>
            {span.verification.passed ? "passed" : "failed"}
          </span>
        ) : (
          "—"
        ),
      ]);
      if (span.verification?.report) block = { label: "report", text: span.verification.report };
      break;
    case "response":
      rows.push(["length", `${span.response?.chars ?? 0} chars`]);
      break;
    case "error":
      rows.push(["message", <span className="bad">{span.detail}</span>]);
      break;
  }
  const json = () => {
    void navigator.clipboard?.writeText(JSON.stringify(span, null, 2));
  };
  return (
    <div className="inspector">
      <div className="insp-head">
        <span className={`kind ${span.kind}`}>{span.kind}</span>
        <span>{span.label}</span>
      </div>
      <dl className="kv">
        {rows.map(([k, v], i) => (
          <span key={i} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </span>
        ))}
      </dl>
      {block ? (
        <div className="insp-block">
          <span className="lbl">{block.label}</span>
          {block.text}
        </div>
      ) : null}
      <div className="insp-actions">
        {span.kind === "tool" && onShowInTranscript ? (
          <button onClick={() => onShowInTranscript(span.tool!.callId)}>show in transcript</button>
        ) : null}
        <button onClick={json}>copy as JSON</button>
      </div>
    </div>
  );
}

export function TraceRail(props: {
  trace: TraceState;
  selectedTurn: number | null;
  onSelectTurn: (turn: number) => void;
  selectedSpanId: string | null;
  onSelectSpan: (id: string | null) => void;
  onExport: () => void;
  onShowInTranscript?: (callId: string) => void;
  now: number;
}) {
  const [off, setOff] = useState<Set<string>>(new Set());
  const turn = useMemo(() => {
    const turns = props.trace.turns;
    if (props.selectedTurn != null)
      return turns.find((t) => t.turn === props.selectedTurn) ?? turns.at(-1) ?? null;
    return turns.at(-1) ?? null;
  }, [props.trace.turns, props.selectedTurn]);
  const hiddenKinds = useMemo(
    () => new Set(FILTERS.filter((f) => off.has(f.key)).flatMap((f) => f.kinds)),
    [off],
  );
  const selected = turn?.spans.find((s) => s.id === props.selectedSpanId) ?? null;
  const live = turn && !turn.endedAt;
  const wall = turn ? fmtMs((turn.endedAt ?? props.now) - turn.startedAt) : "";
  const totals = turn?.totals;
  const modelCalls = turn ? turn.spans.filter((s) => s.kind === "model").length : 0;
  const tools = turn ? turn.spans.filter((s) => s.kind === "tool").length : 0;
  return (
    <aside className="rail" aria-label="Trace">
      <div className="rail-head">
        <span className="rail-title">Trace</span>
        {turn ? (
          <span className="rail-turn">
            <b>turn {turn.turn}</b> · {wall} · {modelCalls} calls · {tools} tools
          </span>
        ) : (
          <span className="rail-turn">no turn yet</span>
        )}
        <button
          className="tb-btn"
          onClick={props.onExport}
          disabled={!turn}
          title="Export this turn's trace as JSON"
        >
          Export
        </button>
      </div>
      {props.trace.turns.length > 1 ? (
        <div className="rail-turns">
          {props.trace.turns.map((t) => (
            <button
              key={t.turn}
              className={turn?.turn === t.turn ? "on" : ""}
              onClick={() => props.onSelectTurn(t.turn)}
            >
              turn {t.turn}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rail-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`f-chip ${off.has(f.key) ? "off" : "on"}`}
            onClick={() =>
              setOff((s) => {
                const n = new Set(s);
                if (n.has(f.key)) n.delete(f.key);
                else n.add(f.key);
                return n;
              })
            }
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="trace">
        {!turn ? (
          <div className="trace-empty">
            Every turn is recorded here as a tree: model calls → the tools they decided on →
            permissions, checkpoints, fallbacks. Click any row to inspect it; hover a tool in the
            transcript to find it here.
          </div>
        ) : null}
        {turn?.spans
          .filter((s) => !hiddenKinds.has(s.kind))
          .map((s) => {
            const depth = Math.min(3, spanDepth(turn, s));
            const dur = s.endedAt
              ? fmtMs(s.endedAt - s.startedAt)
              : s.status === "running" || s.status === "pending"
                ? fmtMs(props.now - s.startedAt)
                : "";
            return (
              <button
                key={s.id}
                className={`span d${depth} ${s.id === props.selectedSpanId ? "sel" : ""} ${s.status === "pending" ? "wait-row" : ""}`}
                onClick={() => props.onSelectSpan(s.id === props.selectedSpanId ? null : s.id)}
              >
                <span className={`g ${s.kind}`}>{GLYPH[s.kind]}</span>
                <span className="lbl">
                  {s.kind === "model" ||
                  s.kind === "checkpoint" ||
                  s.kind === "fallback" ||
                  s.kind === "compaction" ? (
                    <b>{s.label}</b>
                  ) : (
                    s.label
                  )}
                  {s.kind === "model" && s.model?.model ? ` · ${s.model.model}` : ""}
                </span>
                <span className="dur">{dur}</span>
                <span className={`st ${s.status}`} />
                <span className="meta">{spanMeta(s)}</span>
              </button>
            );
          })}
      </div>
      <div className="rail-totals">
        {totals && turn ? (
          <>
            <span>
              <b>{modelCalls}</b> model calls
            </span>
            <span>
              <b>{tools}</b> tools
            </span>
            <span>
              ↑ <b>{fmtTokens(totals.tokensIn)}</b> ↓ <b>{fmtTokens(totals.tokensOut)}</b>
            </span>
            {totals.thinkingMs ? (
              <span>
                thought <b>{(totals.thinkingMs / 1000).toFixed(1)}s</b>
              </span>
            ) : null}
            <span>
              <b>{wall}</b> {live ? "so far" : "wall"}
            </span>
            {totals.permissions ? (
              <span>
                <b>{totals.permissions}</b> permissions
              </span>
            ) : null}
          </>
        ) : (
          <span>totals appear as the turn runs</span>
        )}
      </div>
      <Inspector span={selected} turn={turn} onShowInTranscript={props.onShowInTranscript} />
    </aside>
  );
}
