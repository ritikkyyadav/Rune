// ─── The Files tab: a tree and a preview ───
//
// One directory at a time rather than a recursive walk, because the engine
// answers one directory at a time and a tree that pre-fetches a repository is
// a tree that hangs on a monorepo. Expanding a folder fetches it; collapsing
// keeps what it fetched, so re-opening is instant and the engine is asked once.
//
// The preview is read-only on purpose. Editing here would be a second way to
// change files, next to the agent that does it with a diff, a permission and a
// checkpoint — and the second way would have none of those.

import { useCallback, useEffect, useState } from "react";
import { ChevronRightIcon, FileIcon, FolderIcon } from "./Icons";

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}

export interface FileListing {
  root: string;
  path: string;
  entries: FileEntry[];
  reason?: string;
}

export interface FilePreview {
  path: string;
  text: string;
  bytes: number;
  truncated: boolean;
  binary: boolean;
  reason?: string;
}

function humanSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function FilesTab(props: {
  list: (path?: string) => Promise<FileListing | null>;
  read: (path: string) => Promise<FilePreview | null>;
  onOpenInEditor: (path: string) => void;
  /** Pre-select a path — how ⌘K opens a file. */
  selected: string | null;
  onSelect: (path: string | null) => void;
}) {
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [root, setRoot] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { list, read, selected } = props;

  const load = useCallback(
    async (path: string) => {
      const listing = await list(path || undefined);
      if (!listing) {
        setError("no engine attached");
        return;
      }
      if (listing.reason) setError(listing.reason);
      setRoot(listing.root);
      setDirs((d) => ({ ...d, [path]: listing.entries }));
    },
    [list],
  );

  useEffect(() => {
    setBusy(true);
    void load("").finally(() => setBusy(false));
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void read(selected).then((p) => {
      if (!cancelled) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [read, selected]);

  const toggle = useCallback(
    (path: string) => {
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else {
          next.add(path);
          if (!dirs[path]) void load(path);
        }
        return next;
      });
    },
    [dirs, load],
  );

  const rows = (path: string, depth: number): React.ReactNode[] => {
    const entries = dirs[path];
    if (!entries) return [];
    return entries.flatMap((e) => {
      const expanded = open.has(e.path);
      const row = (
        <button
          key={e.path}
          className={`file-row ${props.selected === e.path ? "sel" : ""}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => (e.dir ? toggle(e.path) : props.onSelect(e.path))}
          onDoubleClick={() => (e.dir ? undefined : props.onOpenInEditor(e.path))}
          title={e.path}
        >
          {e.dir ? (
            <ChevronRightIcon className={`file-chev ${expanded ? "open" : ""}`} />
          ) : (
            <span className="file-chev" />
          )}
          {e.dir ? <FolderIcon /> : <FileIcon />}
          <span className="file-name">{e.name}</span>
          {e.dir ? null : <span className="file-size">{humanSize(e.size)}</span>}
        </button>
      );
      return expanded ? [row, ...rows(e.path, depth + 1)] : [row];
    });
  };

  return (
    <div className="files" aria-label="Files">
      <div className="files-tree">
        <div className="files-root" title={root}>
          {root.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~")}
        </div>
        {busy && !dirs[""] ? <div className="files-empty">Reading the workspace…</div> : null}
        {error ? <div className="files-empty">{error}</div> : null}
        {rows("", 0)}
      </div>
      <div className="files-preview">
        {!props.selected ? (
          <div className="files-empty">Select a file to read it.</div>
        ) : (
          <>
            <div className="files-head">
              <span className="file-name">{props.selected}</span>
              {preview ? <span className="file-size">{humanSize(preview.bytes)}</span> : null}
              <button
                className="perm-btn"
                onClick={() => props.onOpenInEditor(props.selected!)}
                title="Open in your editor"
              >
                Open
              </button>
            </div>
            {preview?.reason ? <div className="files-empty">{preview.reason}</div> : null}
            {preview?.binary ? (
              <div className="files-empty">
                Binary file — {humanSize(preview.bytes)}. Nothing useful to show as text.
              </div>
            ) : null}
            {preview && !preview.binary ? (
              <pre className="files-code">
                {preview.text}
                {preview.truncated ? "\n\n… truncated; open it in your editor for the rest." : ""}
              </pre>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
