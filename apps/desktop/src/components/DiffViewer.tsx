import type { DiffLine } from "../lib/types";

interface DiffViewerProps {
  lines: DiffLine[];
  fileName?: string;
}

const lineClassMap: Record<DiffLine["type"], string> = {
  added: "diff-line diff-line--added",
  removed: "diff-line diff-line--removed",
  context: "diff-line diff-line--context",
};

const prefixMap: Record<DiffLine["type"], string> = {
  added: "+ ",
  removed: "- ",
  context: "  ",
};

export function DiffViewer({ lines, fileName }: DiffViewerProps) {
  if (lines.length === 0) {
    return (
      <div className="card">
        <div
          style={{
            padding: 20,
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontStyle: "italic",
              fontSize: "1.2rem",
              color: "var(--dim-text)",
            }}
          >
            &empty;
          </span>
          <span
            style={{
              fontSize: "12px",
              color: "var(--dim-text)",
            }}
          >
            No changes drafted.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      {fileName && (
        <div
          style={{
            padding: "6px 12px",
            background: "var(--bg-hover)",
            borderBottom: "1px solid var(--draft-line)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: "var(--cyanotype)", fontSize: "12px" }}>{fileName}</span>
          <span style={{ color: "var(--dim-text)", fontSize: "10px" }}>
            +{lines.filter((l) => l.type === "added").length} &minus;
            {lines.filter((l) => l.type === "removed").length}
          </span>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        {lines.map((line, i) => (
          <div key={i} className={lineClassMap[line.type]}>
            <div className="diff-line-number">{line.oldLineNumber ?? ""}</div>
            <div className="diff-line-number">{line.newLineNumber ?? ""}</div>
            <div className="diff-content">
              {prefixMap[line.type]}
              {line.content}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
