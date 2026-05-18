import type { SessionInfo } from "../lib/types";

interface SessionListProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNewSession: () => void;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 16px 12px",
    borderBottom: "1px solid var(--border)",
  },
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-secondary)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  newButton: {
    background: "var(--accent)",
    color: "white",
    border: "none",
    borderRadius: "var(--radius-sm)",
    width: 28,
    height: 28,
    fontSize: 18,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  },
  list: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "8px 0",
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    padding: "12px 16px 4px",
  },
  sessionItem: {
    padding: "10px 16px",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    margin: "0 8px",
    transition: "background 0.15s",
  },
  sessionTitle: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-primary)",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },
  sessionMeta: {
    fontSize: 11,
    color: "var(--text-muted)",
    marginTop: 2,
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    padding: 24,
    color: "var(--text-muted)",
    fontSize: 13,
    textAlign: "center" as const,
    gap: 8,
  },
};

function groupByDay(sessions: SessionInfo[]) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups: { label: string; sessions: SessionInfo[] }[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Older", sessions: [] },
  ];

  for (const s of sessions) {
    const date = new Date(s.updatedAt);
    if (date.toDateString() === today.toDateString()) {
      groups[0].sessions.push(s);
    } else if (date.toDateString() === yesterday.toDateString()) {
      groups[1].sessions.push(s);
    } else {
      groups[2].sessions.push(s);
    }
  }

  return groups.filter((g) => g.sessions.length > 0);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onNewSession,
}: SessionListProps) {
  const groups = groupByDay(sessions);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Sessions</span>
        <button
          style={styles.newButton}
          onClick={onNewSession}
          title="New session"
        >
          +
        </button>
      </div>

      {sessions.length === 0 ? (
        <div style={styles.emptyState}>
          <span style={{ fontSize: 24 }}>{'{ }'}</span>
          <span>No sessions yet</span>
          <span>Start a new session to begin</span>
        </div>
      ) : (
        <div style={styles.list}>
          {groups.map((group) => (
            <div key={group.label}>
              <div style={styles.groupLabel}>{group.label}</div>
              {group.sessions.map((s) => (
                <div
                  key={s.id}
                  style={{
                    ...styles.sessionItem,
                    background:
                      s.id === activeSessionId
                        ? "var(--bg-tertiary)"
                        : "transparent",
                  }}
                  onClick={() => onSelect(s.id)}
                  onMouseEnter={(e) => {
                    if (s.id !== activeSessionId) {
                      e.currentTarget.style.background = "var(--bg-hover)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (s.id !== activeSessionId) {
                      e.currentTarget.style.background = "transparent";
                    }
                  }}
                >
                  <div style={styles.sessionTitle}>
                    {s.title || "Untitled Session"}
                  </div>
                  <div style={styles.sessionMeta}>
                    {s.eventCount} events &middot; {formatTime(s.updatedAt)}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
