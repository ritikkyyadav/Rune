// ─── ⌘K: one place to reach everything ───
//
// Sessions, files and commands in one list, ranked together. Three separate
// searches would be three things to remember; one is a habit.
//
// Files are searched over what the tree has ALREADY fetched, plus a lazy root
// listing on open. Not a recursive crawl: a palette that indexes a monorepo on
// every keystroke is a palette that stutters, and the fix — a background index
// with its own staleness — is a subsystem, not a search box. What is loaded is
// what is findable, and a person who has opened a folder can find what is in it.
//
// Ranking is prefix-first, then substring, then recency for sessions. Simple
// and predictable beats clever: a person types three letters and expects the
// thing they touched last.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChatIcon, CommandIcon, FileIcon } from "./Icons";
import type { SessionInfo } from "../lib/types";

export type PaletteKind = "session" | "file" | "command";

export interface PaletteItem {
  kind: PaletteKind;
  id: string;
  label: string;
  sub?: string;
  tag?: string;
}

function score(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  const at = h.indexOf(n);
  if (at === -1) return -1;
  // Later in the string is a weaker match, but a match all the same.
  return Math.max(10, 60 - at);
}

export function rankItems(items: PaletteItem[], query: string, limit = 40): PaletteItem[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit);
  return items
    .map((item) => ({
      item,
      s: Math.max(score(item.label, q), score(item.sub ?? "", q) - 10),
    }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.item);
}

const ICON: Record<PaletteKind, typeof ChatIcon> = {
  session: ChatIcon,
  file: FileIcon,
  command: CommandIcon,
};

export function Palette(props: {
  sessions: SessionInfo[];
  files: string[];
  commands: Array<{ id: string; name: string; desc: string; tag?: string }>;
  onPick: (item: PaletteItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<PaletteItem[]>(
    () => [
      ...props.commands.map((c) => ({
        kind: "command" as const,
        id: c.id,
        label: c.name,
        sub: c.desc,
        tag: c.tag,
      })),
      ...props.sessions.map((s) => ({
        kind: "session" as const,
        id: s.id,
        label: s.title || "untitled",
        sub: `${s.id.slice(0, 8)} · ${s.model}`,
      })),
      ...props.files.map((f) => ({ kind: "file" as const, id: f, label: f })),
    ],
    [props.commands, props.files, props.sessions],
  );

  const matches = useMemo(() => rankItems(items, query), [items, query]);
  useEffect(() => setSel(0), [query]);

  return (
    <>
      <div className="overlay-scrim" onClick={props.onClose} />
      <div className="overlay palette" role="dialog" aria-label="Search">
        <div className="palette-input">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions, files and commands…"
            aria-label="Search sessions, files and commands"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((i) => Math.min(i + 1, matches.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const item = matches[sel];
                if (item) props.onPick(item);
              } else if (e.key === "Escape") {
                e.preventDefault();
                props.onClose();
              }
            }}
          />
        </div>
        <div className="overlay-list">
          {matches.length === 0 ? (
            <div className="palette-empty">Nothing matches “{query}”.</div>
          ) : null}
          {matches.map((item, i) => {
            const Icon = ICON[item.kind];
            return (
              <button
                key={`${item.kind}:${item.id}`}
                className={`overlay-item ${i === sel ? "selected" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => props.onPick(item)}
              >
                <Icon className="oi-icon" />
                <span className="oi-name">{item.label}</span>
                {item.sub ? <span className="oi-desc">{item.sub}</span> : null}
                <span className="oi-tag">{item.tag ?? item.kind}</span>
              </button>
            );
          })}
        </div>
        <div className="overlay-footer">
          <span>↑↓ move</span>
          <span>⏎ open</span>
          <span>esc close</span>
        </div>
      </div>
    </>
  );
}
