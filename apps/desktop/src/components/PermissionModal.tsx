import { useState, useCallback, useEffect } from "react";
import type { PermissionPrompt, PermissionDecision } from "../lib/types";

interface PermissionModalProps {
  prompt: PermissionPrompt;
  onDecision: (decision: PermissionDecision) => void;
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "var(--overlay)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    backdropFilter: "blur(2px)",
  },
  modal: {
    background: "var(--bg-secondary)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    width: 480,
    maxWidth: "90vw",
    boxShadow: "var(--shadow-md)",
  },
  header: {
    padding: "20px 24px 16px",
    borderBottom: "1px solid var(--border)",
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--warning)",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  headerIcon: {
    fontSize: 18,
  },
  body: {
    padding: "16px 24px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
  },
  fieldRow: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  fieldValue: {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    color: "var(--text-primary)",
    background: "var(--bg-primary)",
    padding: "8px 12px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
  },
  argsValue: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-secondary)",
    background: "var(--bg-primary)",
    padding: "8px 12px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    maxHeight: 150,
    overflowY: "auto" as const,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-all" as const,
  },
  footer: {
    padding: "16px 24px 20px",
    borderTop: "1px solid var(--border)",
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
  },
  button: {
    padding: "8px 16px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    transition: "background 0.15s, opacity 0.15s",
  },
  allowOnceButton: {
    background: "var(--accent)",
    color: "white",
    border: "1px solid var(--accent)",
  },
  allowSessionButton: {
    background: "transparent",
    color: "var(--success)",
    border: "1px solid var(--success)",
  },
  denyButton: {
    background: "transparent",
    color: "var(--error)",
    border: "1px solid var(--error)",
  },
  disabledButton: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  shortcutHint: {
    fontSize: 11,
    color: "var(--text-muted)",
    textAlign: "center" as const,
    padding: "0 24px 12px",
  },
};

export function PermissionModal({ prompt, onDecision }: PermissionModalProps) {
  const [submitting, setSubmitting] = useState(false);

  const formatArgs = (args: Record<string, unknown>) => {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  };

  const handleDecision = useCallback(
    (decision: PermissionDecision) => {
      if (submitting) return;
      setSubmitting(true);
      onDecision(decision);
    },
    [submitting, onDecision],
  );

  // Keyboard shortcuts: y = allow once, a = allow session, n = deny
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (submitting) return;
      if (e.key === "y" || e.key === "Y") {
        handleDecision("allow_once");
      } else if (e.key === "a" || e.key === "A") {
        handleDecision("allow_session");
      } else if (e.key === "n" || e.key === "N" || e.key === "Escape") {
        handleDecision("deny");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [submitting, handleDecision]);

  const buttonStyle = (base: React.CSSProperties) => ({
    ...styles.button,
    ...base,
    ...(submitting ? styles.disabledButton : {}),
  });

  return (
    <div style={styles.overlay} onClick={() => handleDecision("deny")}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.headerTitle}>
            <span style={styles.headerIcon}>&#9888;</span>
            {prompt.safety ? "Auto mode paused" : "Permission Required"}
          </div>
        </div>

        <div style={styles.body}>
          <div style={styles.fieldRow}>
            <div style={styles.fieldLabel}>Tool</div>
            <div style={styles.fieldValue}>{prompt.toolName}</div>
          </div>

          <div style={styles.fieldRow}>
            <div style={styles.fieldLabel}>Summary</div>
            <div style={styles.fieldValue}>{prompt.argsSummary}</div>
          </div>

          {prompt.safety ? (
            <>
              <div style={styles.fieldRow}>
                <div style={styles.fieldLabel}>Safety review</div>
                <div style={styles.fieldValue}>
                  {prompt.safety.risk.toUpperCase()} · {prompt.safety.tier} · {prompt.safety.source}
                </div>
              </div>
              <div style={styles.fieldRow}>
                <div style={styles.fieldLabel}>Why it paused</div>
                <div style={styles.argsValue}>{prompt.safety.reason}</div>
              </div>
              {prompt.safety.reviewer ? (
                <div style={styles.fieldRow}>
                  <div style={styles.fieldLabel}>Independent reviewer</div>
                  <div style={styles.fieldValue}>
                    {prompt.safety.reviewer.provider}/{prompt.safety.reviewer.model}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {Object.keys(prompt.rawArgs).length > 0 && (
            <div style={styles.fieldRow}>
              <div style={styles.fieldLabel}>Arguments</div>
              <div style={styles.argsValue}>{formatArgs(prompt.rawArgs)}</div>
            </div>
          )}
        </div>

        <div style={styles.footer}>
          <button
            style={buttonStyle(styles.denyButton)}
            onClick={() => handleDecision("deny")}
            disabled={submitting}
          >
            Deny (N)
          </button>
          <button
            style={buttonStyle(styles.allowSessionButton)}
            onClick={() => handleDecision("allow_session")}
            disabled={submitting}
          >
            {prompt.exactSessionGrant ? "Allow Exact Action (A)" : "Allow Session (A)"}
          </button>
          <button
            style={buttonStyle(styles.allowOnceButton)}
            onClick={() => handleDecision("allow_once")}
            disabled={submitting}
          >
            Allow Once (Y)
          </button>
        </div>

        <div style={styles.shortcutHint}>
          Press Y to allow once, A to allow{" "}
          {prompt.exactSessionGrant ? "this exact action" : "for session"}, N or Esc to deny
        </div>
      </div>
    </div>
  );
}
