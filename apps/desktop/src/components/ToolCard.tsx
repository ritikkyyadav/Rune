import { useState } from "react";
import type { ToolCallInfo } from "../lib/types";

interface ToolCardProps {
  toolCall: ToolCallInfo;
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "var(--bg-secondary)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    fontSize: 13,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    cursor: "pointer",
    userSelect: "none",
  },
  statusIcon: {
    width: 16,
    height: 16,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  toolName: {
    fontFamily: "var(--font-mono)",
    fontWeight: 500,
    color: "var(--text-primary)",
    flex: 1,
  },
  duration: {
    fontSize: 11,
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
  },
  chevron: {
    color: "var(--text-muted)",
    fontSize: 12,
    transition: "transform 0.15s",
  },
  body: {
    borderTop: "1px solid var(--border)",
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  codeBlock: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    background: "var(--bg-primary)",
    padding: "8px 10px",
    borderRadius: "var(--radius-sm)",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-all" as const,
    color: "var(--text-secondary)",
    maxHeight: 200,
    overflowY: "auto" as const,
  },
};

function StatusIcon({ status }: { status: ToolCallInfo["status"] }) {
  if (status === "running") {
    return (
      <div style={styles.statusIcon}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          style={{ animation: "spin 1s linear infinite" }}
        >
          <circle
            cx="7"
            cy="7"
            r="5.5"
            stroke="var(--warning)"
            strokeWidth="2"
            strokeDasharray="24"
            strokeDashoffset="8"
            strokeLinecap="round"
          />
          <style>{`
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>
        </svg>
      </div>
    );
  }
  if (status === "success") {
    return (
      <div style={{ ...styles.statusIcon, color: "var(--success)" }}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="3,7 6,10 11,4" />
        </svg>
      </div>
    );
  }
  // error
  return (
    <div style={{ ...styles.statusIcon, color: "var(--error)" }}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <line x1="3" y1="3" x2="11" y2="11" />
        <line x1="11" y1="3" x2="3" y2="11" />
      </svg>
    </div>
  );
}

export function ToolCard({ toolCall }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);

  const formatDuration = (ms?: number) => {
    if (ms == null) return null;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatArgs = (args: Record<string, unknown>) => {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  };

  return (
    <div style={styles.card}>
      <div
        style={styles.header}
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon status={toolCall.status} />
        <span style={styles.toolName}>{toolCall.toolName}</span>
        {toolCall.durationMs != null && (
          <span style={styles.duration}>
            {formatDuration(toolCall.durationMs)}
          </span>
        )}
        <span
          style={{
            ...styles.chevron,
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          &#9656;
        </span>
      </div>

      {expanded && (
        <div style={styles.body}>
          {Object.keys(toolCall.args).length > 0 && (
            <div>
              <div style={styles.sectionLabel}>Arguments</div>
              <div style={styles.codeBlock}>
                {formatArgs(toolCall.args)}
              </div>
            </div>
          )}

          {toolCall.result && (
            <div>
              <div style={styles.sectionLabel}>Result</div>
              <div style={styles.codeBlock}>{toolCall.result}</div>
            </div>
          )}

          {toolCall.error && (
            <div>
              <div style={{ ...styles.sectionLabel, color: "var(--error)" }}>
                Error
              </div>
              <div style={{ ...styles.codeBlock, color: "var(--error)" }}>
                {toolCall.error}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
