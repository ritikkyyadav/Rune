import { useState, useRef, useCallback } from "react";

interface ComposerProps {
  onSend: (message: string) => void;
  disabled: boolean;
  isProcessing?: boolean;
  onAbort?: () => void;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    borderTop: "1px solid var(--border)",
    padding: "12px 32px 16px",
    background: "var(--bg-primary)",
  },
  inputRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: 8,
    background: "var(--bg-surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: "8px 12px",
    transition: "border-color 0.15s",
  },
  inputRowFocused: {
    borderColor: "var(--accent)",
  },
  textarea: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--text-primary)",
    fontFamily: "var(--font-sans)",
    fontSize: 14,
    lineHeight: 1.5,
    resize: "none" as const,
    maxHeight: 150,
    minHeight: 24,
  },
  attachButton: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 18,
    padding: "4px 6px",
    borderRadius: "var(--radius-sm)",
    lineHeight: 1,
    flexShrink: 0,
  },
  sendButton: {
    background: "var(--accent)",
    border: "none",
    color: "white",
    cursor: "pointer",
    width: 32,
    height: 32,
    borderRadius: "var(--radius-md)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "background 0.15s, opacity 0.15s",
  },
  sendButtonDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  abortButton: {
    background: "var(--error)",
    border: "none",
    color: "white",
    cursor: "pointer",
    width: 32,
    height: 32,
    borderRadius: "var(--radius-md)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "background 0.15s",
  },
  hint: {
    fontSize: 11,
    color: "var(--text-muted)",
    marginTop: 6,
    textAlign: "center" as const,
  },
  processingHint: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    fontSize: 11,
    color: "var(--warning)",
    marginTop: 6,
  },
};

// Simple SVG arrow-up icon for the send button
function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="8" y1="14" x2="8" y2="2" />
      <polyline points="2,7 8,2 14,7" />
    </svg>
  );
}

// Stop/square icon for abort
function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="2" y="2" width="10" height="10" rx="2" />
    </svg>
  );
}

export function Composer({ onSend, disabled, isProcessing = false, onAbort }: ComposerProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    // Auto-resize textarea
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, []);

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div style={styles.container}>
      <div
        style={{
          ...styles.inputRow,
          ...(focused ? styles.inputRowFocused : {}),
        }}
      >
        <button style={styles.attachButton} title="Attach file (coming soon)" tabIndex={-1}>
          +
        </button>
        <textarea
          ref={textareaRef}
          style={styles.textarea}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={isProcessing ? "Waiting for response..." : "Ask Berne anything..."}
          rows={1}
          disabled={disabled}
        />
        {isProcessing && onAbort ? (
          <button style={styles.abortButton} onClick={onAbort} title="Stop generation">
            <StopIcon />
          </button>
        ) : (
          <button
            style={{
              ...styles.sendButton,
              ...(canSend ? {} : styles.sendButtonDisabled),
            }}
            onClick={handleSubmit}
            disabled={!canSend}
            title="Send message"
          >
            <SendIcon />
          </button>
        )}
      </div>
      {isProcessing ? (
        <div style={styles.processingHint}>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--warning)",
              animation: "pulse 1.4s ease-in-out infinite",
            }}
          />
          Processing... click stop to cancel
          <style>{`
            @keyframes pulse {
              0%, 80%, 100% { opacity: 0.3; }
              40% { opacity: 1; }
            }
          `}</style>
        </div>
      ) : (
        <div style={styles.hint}>Enter to send &middot; Shift+Enter for newline</div>
      )}
    </div>
  );
}
