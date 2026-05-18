import type { DiffLine } from "../lib/types";

interface DiffViewerProps {
  lines: DiffLine[];
  fileName?: string;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.6,
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
  },
  header: {
    padding: "6px 12px",
    background: "var(--bg-tertiary)",
    borderBottom: "1px solid var(--border)",
    fontSize: 12,
    color: "var(--text-secondary)",
    fontWeight: 500,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
  },
  row: {
    display: "flex",
    width: "100%",
  },
  lineNumber: {
    width: 48,
    minWidth: 48,
    textAlign: "right" as const,
    padding: "0 8px",
    color: "var(--text-muted)",
    userSelect: "none",
    fontSize: 11,
    flexShrink: 0,
  },
  content: {
    flex: 1,
    padding: "0 12px",
    whiteSpace: "pre" as const,
    overflowX: "auto" as const,
  },
};

const lineColors: Record<DiffLine["type"], React.CSSProperties> = {
  added: {
    background: "rgba(74, 222, 128, 0.1)",
    color: "var(--success)",
  },
  removed: {
    background: "rgba(248, 113, 113, 0.1)",
    color: "var(--error)",
  },
  context: {
    background: "transparent",
    color: "var(--text-secondary)",
  },
};

const prefixMap: Record<DiffLine["type"], string> = {
  added: "+ ",
  removed: "- ",
  context: "  ",
};

export function DiffViewer({ lines, fileName }: DiffViewerProps) {
  if (lines.length === 0) {
    return (
      <div style={styles.container}>
        <div
          style={{
            padding: 16,
            color: "var(--text-muted)",
            textAlign: "center",
            fontSize: 13,
          }}
        >
          No changes
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {fileName && <div style={styles.header}>{fileName}</div>}
      <div style={{ overflowX: "auto" }}>
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              ...styles.row,
              ...lineColors[line.type],
            }}
          >
            <div style={styles.lineNumber}>
              {line.oldLineNumber ?? ""}
            </div>
            <div style={styles.lineNumber}>
              {line.newLineNumber ?? ""}
            </div>
            <div style={styles.content}>
              {prefixMap[line.type]}
              {line.content}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
