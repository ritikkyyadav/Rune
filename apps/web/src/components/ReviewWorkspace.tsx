import { useEffect, useMemo, useState } from "react";
import type { ToolCallInfo } from "../lib/types";
import { summarizeChanges } from "./EnvironmentPanel";
import { CopyIcon, FileDiffIcon, SearchIcon } from "./Icons";

interface ReviewWorkspaceProps {
  toolCalls: ToolCallInfo[];
  onBackToChat: () => void;
}

interface ReviewFile {
  path: string;
  call: ToolCallInfo;
  additions: number;
  deletions: number;
  lines: string[];
}

const PATH_PATTERN = /(?:^|[\s"'`])((?:[\w.-]+\/)+[\w.@+-]+\.[a-zA-Z0-9]{1,8})/g;

function stringifyArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

function collectReviewFiles(toolCalls: ToolCallInfo[]): ReviewFile[] {
  const changes = summarizeChanges(toolCalls);
  const files = new Map<string, ReviewFile>();

  for (const call of changes.calls) {
    const argsText = stringifyArgs(call.args);
    const resultText = call.result ?? call.error ?? "";
    const paths = new Set<string>();
    for (const match of `${argsText}\n${resultText}`.matchAll(PATH_PATTERN)) paths.add(match[1]);
    if (paths.size === 0) paths.add(`${call.toolName.replace(/[^a-z0-9_-]/gi, "-")}.change`);

    const resultLines = resultText.split("\n").filter(Boolean);
    const visibleLines = resultLines.some((line) => /^[+-]/.test(line))
      ? resultLines.filter((line) => !line.startsWith("+++") && !line.startsWith("---"))
      : [`Tool: ${call.toolName}`, ...argsText.split("\n"), ...resultLines];
    const additions = visibleLines.filter((line) => line.startsWith("+")).length;
    const deletions = visibleLines.filter((line) => line.startsWith("-")).length;

    for (const path of paths) {
      const previous = files.get(path);
      files.set(path, {
        path,
        call,
        additions: (previous?.additions ?? 0) + additions,
        deletions: (previous?.deletions ?? 0) + deletions,
        lines: [...(previous?.lines ?? []), ...visibleLines].slice(-180),
      });
    }
  }

  return [...files.values()];
}

function lineKind(line: string): "added" | "removed" | "context" {
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

export function ReviewWorkspace({ toolCalls, onBackToChat }: ReviewWorkspaceProps) {
  const files = useMemo(() => collectReviewFiles(toolCalls), [toolCalls]);
  const [selectedPath, setSelectedPath] = useState(files[0]?.path ?? "");
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (files.length === 0) setSelectedPath("");
    else if (!files.some((file) => file.path === selectedPath)) setSelectedPath(files[0].path);
  }, [files, selectedPath]);

  const filteredFiles = files.filter((file) =>
    file.path.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  const totals = files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  const copySummary = async () => {
    const summary = files
      .map((file) => `${file.path} (+${file.additions} -${file.deletions})`)
      .join("\n");
    await navigator.clipboard.writeText(summary || "No file changes in this conversation.");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  if (files.length === 0) {
    return (
      <div className="review-empty">
        <div className="review-empty-illustration" aria-hidden="true">
          <span />
          <i />
          <i />
          <b />
          <i />
        </div>
        <div className="review-empty-icon">
          <FileDiffIcon />
        </div>
        <h2>No changes to review</h2>
        <p>When Gear edits files, every changed file and patch will appear here for inspection.</p>
        <button type="button" className="quiet-primary-button" onClick={onBackToChat}>
          Return to conversation
        </button>
      </div>
    );
  }

  return (
    <div className="review-workspace">
      <header className="review-toolbar">
        <div>
          <span>Last turn</span>
          <b>{files.length} files</b>
          <em>+{totals.additions}</em>
          <i>-{totals.deletions}</i>
        </div>
        <button type="button" className="review-copy-button" onClick={copySummary}>
          <CopyIcon />
          {copied ? "Copied" : "Copy summary"}
        </button>
      </header>

      <div className="review-body">
        <aside className="review-files">
          <label className="review-filter">
            <SearchIcon />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter files…"
              aria-label="Filter changed files"
            />
          </label>
          <div className="review-file-list">
            {filteredFiles.map((file) => (
              <button
                type="button"
                key={file.path}
                className={file.path === selected?.path ? "review-file--active" : ""}
                onClick={() => setSelectedPath(file.path)}
                title={file.path}
              >
                <FileDiffIcon />
                <span>
                  <strong>{basename(file.path)}</strong>
                  <small>{file.path}</small>
                </span>
                <em>+{file.additions}</em>
                <i>-{file.deletions}</i>
              </button>
            ))}
          </div>
        </aside>

        {selected ? (
          <section className="review-diff" aria-label={`Changes in ${selected.path}`}>
            <header>
              <span>{selected.path}</span>
              <div>
                <em>+{selected.additions}</em>
                <i>-{selected.deletions}</i>
              </div>
            </header>
            <div className="review-code">
              {selected.lines.length > 0 ? (
                selected.lines.map((line, index) => {
                  const kind = lineKind(line);
                  return (
                    <div
                      className={`review-code-line review-code-line--${kind}`}
                      key={`${index}-${line}`}
                    >
                      <span>{index + 1}</span>
                      <code>{line || " "}</code>
                    </div>
                  );
                })
              ) : (
                <div className="review-code-placeholder">
                  The edit completed without a textual diff.
                </div>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
