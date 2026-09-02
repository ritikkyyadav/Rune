import type { ReactNode } from "react";

// ─── Markdown → React (the response voice) ───
// Deliberately small: paragraphs, headings, bullet/numbered lists, fenced code,
// and the inline styles models actually emit (`code`, **bold**, *em*, links).
// Everything else renders as text — never as raw markup, never as HTML.

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\((?:https?:\/\/|#)[^)]+\))/g;

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return <em key={key}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    }
    return part;
  });
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "hr" };

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (!t) {
      i++;
      continue;
    }
    const fence = t.match(/^(```+|~~~+)\s*(\S+)?/);
    if (fence) {
      const mark = fence[1]!;
      const lang = fence[2] ?? "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(mark[0]!.repeat(3)))
        code.push(lines[i++]!);
      i++;
      blocks.push({ kind: "code", lang, code: code.join("\n") });
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ kind: "h", level: h[1]!.length, text: h[2]!.replace(/#+\s*$/, "") });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    if (/^[-*+]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!))
        items.push(lines[i++]!.replace(/^\s*[-*+]\s+/, ""));
      blocks.push({ kind: "ul", items });
      continue;
    }
    if (/^\d{1,3}[.)]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d{1,3}[.)]\s+/.test(lines[i]!))
        items.push(lines[i++]!.replace(/^\s*\d{1,3}[.)]\s+/, ""));
      blocks.push({ kind: "ol", items });
      continue;
    }
    const para: string[] = [t];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|[-*+]\s|\d{1,3}[.)]\s|```|~~~)/.test(lines[i]!.trim())
    )
      para.push(lines[i++]!.trim());
    blocks.push({ kind: "p", text: para.join(" ") });
  }
  return blocks;
}

export function Markdown({ source, streaming = false }: { source: string; streaming?: boolean }) {
  const blocks = parseBlocks(source);
  return (
    <>
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1;
        const cursor =
          streaming && last ? <span className="resp-cursor" aria-hidden="true" /> : null;
        switch (block.kind) {
          case "h": {
            const Tag = (block.level <= 1 ? "h1" : block.level === 2 ? "h2" : "h3") as
              "h1" | "h2" | "h3";
            return <Tag key={index}>{renderInline(block.text, `h${index}`)}</Tag>;
          }
          case "ul":
            return (
              <ul key={index}>
                {block.items.map((item, k) => (
                  <li key={k}>{renderInline(item, `u${index}-${k}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={index}>
                {block.items.map((item, k) => (
                  <li key={k}>{renderInline(item, `o${index}-${k}`)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre key={index} data-lang={block.lang || undefined}>
                <code>{block.code}</code>
              </pre>
            );
          case "hr":
            return <hr key={index} />;
          default:
            return (
              <p key={index}>
                {renderInline(block.text, `p${index}`)}
                {cursor}
              </p>
            );
        }
      })}
      {streaming && blocks.length === 0 ? (
        <span className="resp-cursor" aria-hidden="true" />
      ) : null}
    </>
  );
}
