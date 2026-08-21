import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatMessage } from "../lib/types";
import { BrandMark } from "./BrandMark";
import { CodeIcon, CopyIcon, FolderIcon, SparkIcon, ThumbsDownIcon, ThumbsUpIcon } from "./Icons";
import { ToolCard } from "./ToolCard";

interface MessageStreamProps {
  messages: ChatMessage[];
  isLoading: boolean;
  onSuggestion?: (message: string) => void;
}

const SUGGESTIONS = [
  {
    label: "Understand",
    title: "Explore this codebase",
    description: "Map the architecture, runtime, and unfinished areas.",
    prompt:
      "Explore this codebase and explain the architecture, runtime flow, and unfinished areas.",
    icon: FolderIcon,
  },
  {
    label: "Build",
    title: "Ship a polished feature",
    description: "Implement an idea end to end and verify the real flow.",
    prompt:
      "Help me design and implement a polished feature in this project, then verify it end to end.",
    icon: SparkIcon,
  },
  {
    label: "Improve",
    title: "Review the current UI",
    description: "Find the highest-impact product and engineering improvements.",
    prompt:
      "Review the current UI and code quality, then prioritize and implement the highest-impact improvements.",
    icon: CodeIcon,
  },
] as const;

const INLINE_TOKEN_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;

function renderInline(text: string): ReactNode[] {
  return text.split(INLINE_TOKEN_PATTERN).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${index}-${part}`}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${index}-${part}`}>{part.slice(2, -2)}</strong>;
    }
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (link) {
      return (
        <a key={`${index}-${part}`} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    }
    return part;
  });
}

function renderTextLines(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let unordered: string[] = [];
  let ordered: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const copy = paragraph.join(" ");
    nodes.push(<p key={`${keyPrefix}-p-${nodes.length}`}>{renderInline(copy)}</p>);
    paragraph = [];
  };
  const flushUnordered = () => {
    if (unordered.length === 0) return;
    nodes.push(
      <ul key={`${keyPrefix}-ul-${nodes.length}`}>
        {unordered.map((item, index) => (
          <li key={`${index}-${item}`}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    unordered = [];
  };
  const flushOrdered = () => {
    if (ordered.length === 0) return;
    nodes.push(
      <ol key={`${keyPrefix}-ol-${nodes.length}`}>
        {ordered.map((item, index) => (
          <li key={`${index}-${item}`}>{renderInline(item)}</li>
        ))}
      </ol>,
    );
    ordered = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushUnordered();
    flushOrdered();
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushAll();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 2, 5);
      const Tag = `h${level}` as "h3" | "h4" | "h5";
      nodes.push(<Tag key={`${keyPrefix}-h-${nodes.length}`}>{renderInline(heading[2])}</Tag>);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      flushOrdered();
      unordered.push(bullet[1]);
      continue;
    }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      flushParagraph();
      flushUnordered();
      ordered.push(numbered[1]);
      continue;
    }
    flushUnordered();
    flushOrdered();
    paragraph.push(line);
  }
  flushAll();
  return nodes;
}

function RichText({ content }: { content: string }) {
  const sections = content.split(/(```[\s\S]*?```)/g).filter(Boolean);
  return (
    <div className="assistant-prose">
      {sections.map((section, index) => {
        if (section.startsWith("```") && section.endsWith("```")) {
          const raw = section.slice(3, -3).replace(/^\n/, "");
          const firstBreak = raw.indexOf("\n");
          const possibleLanguage = firstBreak >= 0 ? raw.slice(0, firstBreak).trim() : "";
          const hasLanguage = /^[\w+#.-]{1,18}$/.test(possibleLanguage);
          const code = hasLanguage ? raw.slice(firstBreak + 1) : raw;
          return (
            <div className="message-code" key={`code-${index}`}>
              <header>{hasLanguage ? possibleLanguage : "Code"}</header>
              <pre>
                <code>{code}</code>
              </pre>
            </div>
          );
        }
        return renderTextLines(section, `text-${index}`);
      })}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function MessageActions({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="message-actions" aria-label="Message actions">
      <button type="button" onClick={copy} title="Copy response">
        <CopyIcon />
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
      <button type="button" title="Helpful" aria-label="Mark response helpful">
        <ThumbsUpIcon />
      </button>
      <button type="button" title="Not helpful" aria-label="Mark response not helpful">
        <ThumbsDownIcon />
      </button>
    </div>
  );
}

function LoadingTurn() {
  return (
    <div className="assistant-turn assistant-turn--loading">
      <div className="assistant-avatar">
        <BrandMark size={18} />
      </div>
      <div className="thinking-state">
        <span />
        <span />
        <span />
        <b>Gear is working</b>
      </div>
    </div>
  );
}

export function MessageStream({ messages, isLoading, onSuggestion }: MessageStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading]);

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="message-stream message-stream--empty">
        <div className="welcome-view">
          <div className="welcome-mark">
            <BrandMark size={34} />
          </div>
          <span className="welcome-kicker">Gear desktop</span>
          <h2>What should we work on?</h2>
          <p>
            Plan, build, investigate, and review with a local agent that keeps every action visible.
          </p>
          <div className="suggestion-grid">
            {SUGGESTIONS.map((suggestion) => {
              const Icon = suggestion.icon;
              return (
                <button
                  className="suggestion-card"
                  type="button"
                  key={suggestion.title}
                  onClick={() => onSuggestion?.(suggestion.prompt)}
                >
                  <span className="suggestion-icon">
                    <Icon />
                  </span>
                  <span className="suggestion-copy">
                    <small>{suggestion.label}</small>
                    <strong>{suggestion.title}</strong>
                    <span>{suggestion.description}</span>
                  </span>
                  <i>↗</i>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  const lastMessage = messages.at(-1);
  const isStreaming = isLoading && lastMessage?.role === "assistant";

  return (
    <div className="message-stream">
      <div className="conversation-thread">
        {messages.map((message, index) => {
          const showCursor = isStreaming && index === messages.length - 1;
          if (message.role === "system") {
            return (
              <div className="system-message" key={message.id}>
                {message.content}
              </div>
            );
          }
          if (message.role === "user") {
            return (
              <article className="user-turn" key={message.id}>
                <div className="user-message">{message.content}</div>
                {message.attachments && message.attachments.length > 0 ? (
                  <div className="message-attachments">
                    {message.attachments.map((attachment) => (
                      <span key={`${message.id}-${attachment.name}`}>
                        <CodeIcon />
                        {attachment.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                <time>{formatTimestamp(message.timestamp)}</time>
              </article>
            );
          }

          return (
            <article className="assistant-turn" key={message.id}>
              <div className="assistant-avatar">
                <BrandMark size={18} />
              </div>
              <div className="assistant-content">
                <div className="assistant-meta">
                  <strong>Gear</strong>
                  <time>{formatTimestamp(message.timestamp)}</time>
                </div>
                {message.content ? (
                  <>
                    <RichText content={message.content} />
                    {showCursor ? <span className="streaming-cursor" /> : null}
                  </>
                ) : null}
                {message.toolCalls && message.toolCalls.length > 0 ? (
                  <div className="tool-stack">
                    {message.toolCalls.map((toolCall) => (
                      <ToolCard key={toolCall.callId} toolCall={toolCall} />
                    ))}
                  </div>
                ) : null}
                {!showCursor && message.content ? (
                  <MessageActions content={message.content} />
                ) : null}
              </div>
            </article>
          );
        })}
        {isLoading && !isStreaming ? <LoadingTurn /> : null}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
