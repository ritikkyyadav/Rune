import type { Plan, StepStatus } from "../lib/types";

interface PlanPaneProps {
  plan: Plan;
  onClose: () => void;
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
  closeButton: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 16,
    padding: "2px 6px",
    borderRadius: "var(--radius-sm)",
    lineHeight: 1,
  },
  statusBadge: {
    fontSize: 11,
    fontWeight: 500,
    padding: "2px 8px",
    borderRadius: 10,
    textTransform: "capitalize" as const,
  },
  list: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "12px 0",
  },
  stepItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "8px 16px",
    fontSize: 13,
    lineHeight: 1.5,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: "var(--radius-sm)",
    border: "2px solid",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 1,
    fontSize: 11,
  },
  stepText: {
    flex: 1,
  },
  stepDescription: {
    color: "var(--text-primary)",
  },
  stepCriteria: {
    fontSize: 11,
    color: "var(--text-muted)",
    marginTop: 2,
  },
  stepResult: {
    fontSize: 12,
    marginTop: 4,
    padding: "4px 8px",
    borderRadius: "var(--radius-sm)",
    background: "var(--bg-primary)",
  },
};

const statusColors: Record<StepStatus, string> = {
  pending: "var(--text-muted)",
  running: "var(--warning)",
  completed: "var(--success)",
  failed: "var(--error)",
  skipped: "var(--text-muted)",
};

const planStatusColors: Record<string, { bg: string; text: string }> = {
  active: { bg: "rgba(251, 191, 36, 0.15)", text: "var(--warning)" },
  completed: { bg: "rgba(74, 222, 128, 0.15)", text: "var(--success)" },
  failed: { bg: "rgba(248, 113, 113, 0.15)", text: "var(--error)" },
  cancelled: {
    bg: "rgba(160, 160, 160, 0.15)",
    text: "var(--text-muted)",
  },
};

function CheckboxIcon({ status }: { status: StepStatus }) {
  const color = statusColors[status];

  if (status === "completed") {
    return (
      <div style={{ ...styles.checkbox, borderColor: color, background: color }}>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="var(--bg-primary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="2,5 4,7 8,3" />
        </svg>
      </div>
    );
  }

  if (status === "running") {
    return (
      <div style={{ ...styles.checkbox, borderColor: color }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            background: color,
            animation: "pulse 1.4s ease-in-out infinite",
          }}
        />
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
          }
        `}</style>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div style={{ ...styles.checkbox, borderColor: color }}>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="2" y1="2" x2="8" y2="8" />
          <line x1="8" y1="2" x2="2" y2="8" />
        </svg>
      </div>
    );
  }

  // pending or skipped
  return <div style={{ ...styles.checkbox, borderColor: color }} />;
}

export function PlanPane({ plan, onClose }: PlanPaneProps) {
  const statusStyle = planStatusColors[plan.status] ?? planStatusColors.active;
  const completedCount = plan.steps.filter(
    (s) => s.status === "completed",
  ).length;

  return (
    <div style={styles.container} className="no-select">
      <div style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={styles.title}>Plan</span>
          <span
            style={{
              ...styles.statusBadge,
              background: statusStyle.bg,
              color: statusStyle.text,
            }}
          >
            {plan.status}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
            }}
          >
            {completedCount}/{plan.steps.length}
          </span>
        </div>
        <button style={styles.closeButton} onClick={onClose} title="Close plan">
          &#215;
        </button>
      </div>

      <div style={styles.list}>
        {plan.steps.map((step) => (
          <div key={step.index} style={styles.stepItem}>
            <CheckboxIcon status={step.status} />
            <div style={styles.stepText}>
              <div
                style={{
                  ...styles.stepDescription,
                  opacity: step.status === "skipped" ? 0.5 : 1,
                  textDecoration:
                    step.status === "skipped" ? "line-through" : "none",
                }}
              >
                {step.description}
              </div>
              {step.successCriteria && (
                <div style={styles.stepCriteria}>
                  {step.successCriteria}
                </div>
              )}
              {step.result && (
                <div
                  style={{
                    ...styles.stepResult,
                    color: step.result.success
                      ? "var(--success)"
                      : "var(--error)",
                  }}
                >
                  {step.result.summary}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
