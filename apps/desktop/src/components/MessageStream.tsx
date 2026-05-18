import { useEffect, useRef } from "react";
import type { ChatMessage } from "../lib/types";
import { ToolCard } from "./ToolCard";

interface MessageStreamProps {
  messages: ChatMessage[];
  isLoading: boolean;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflowY: "auto",
    padding: "24px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  emptyState: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    color: "var(--text-muted)",
  },
  logo: {
    fontSize: 32,
    fontWeight: 700,
    color: "var(--accent)",
    fontFamily: "var(--font-mono)",
    letterSpacing: "-0.02em",
  },
  subtitle: {
    fontSize: 14,
    color: "var(--text-secondary)",
  },
  messageRow: {
    display: "flex",
    gap: 12,
    maxWidth: "100%",
  },
  userRow: {
    justifyContent: "flex-end",
  },
  assistantRow: {
    justifyContent: "flex-start",
  },
  bubble: {
    maxWidth: "75%",
    padding: "10px 14px",
    borderRadius: "var(--radius-lg)",
    fontSize: 14,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  },
  userBubble: {
    background: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    borderBottomRightRadius: "var(--radius-sm)",
  },
  assistantBubble: {
    background: "var(--bg-surface)",
    color: "var(--text-primary)",
    borderBottomLeftRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
  },
  toolCallsContainer: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    maxWidth: "75%",
  },
  loadingDots: {
    display: "flex",
    gap: 4,
    padding: "12px 16px",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--accent)",
  },
};

// Simple loading indicator
function LoadingIndicator() {
  return (
    <div style={{ ...styles.messageRow, ...styles.assistantRow }}>
      <div style={styles.loadingDots}>
        <div
          style={{
            ...styles.dot,
            animation: "pulse 1.4s ease-in-out infinite",
          }}
        />
        <div
          style={{
            ...styles.dot,
            animation: "pulse 1.4s ease-in-out 0.2s infinite",
          }}
        />
        <div
          style={{
            ...styles.dot,
            animation: "pulse 1.4s ease-in-out 0.4s infinite",
          }}
        />
        <style>{`
          @keyframes pulse {
            0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
            40% { opacity: 1; transform: scale(1); }
          }
        `}</style>
      </div>
    </div>
  );
}

export function MessageStream({ messages, isLoading }: MessageStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  if (messages.length === 0 && !isLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <div style={styles.logo}>alan</div>
          <div style={styles.subtitle}>
            Sovereign agentic coding assistant
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              marginTop: 8,
            }}
          >
            Type a message below to start a conversation
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {messages.map((msg) => (
        <div key={msg.id}>
          {/* Message bubble */}
          {msg.content && (
            <div
              style={{
                ...styles.messageRow,
                ...(msg.role === "user"
                  ? styles.userRow
                  : styles.assistantRow),
              }}
            >
              <div
                style={{
                  ...styles.bubble,
                  ...(msg.role === "user"
                    ? styles.userBubble
                    : styles.assistantBubble),
                }}
              >
                {msg.content}
              </div>
            </div>
          )}

          {/* Tool calls */}
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <div
              style={{
                ...styles.messageRow,
                ...styles.assistantRow,
                marginTop: msg.content ? 8 : 0,
              }}
            >
              <div style={styles.toolCallsContainer}>
                {msg.toolCalls.map((tc) => (
                  <ToolCard key={tc.callId} toolCall={tc} />
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      {isLoading && <LoadingIndicator />}

      <div ref={bottomRef} />
    </div>
  );
}
