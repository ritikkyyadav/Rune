// ─── The review workspace ───
//
// What actually changed on disk, and what you can do about it. The transcript
// shows the diff of each edit as it happens, which answers "what did it just
// do"; this answers the different question you have at the end — "what is
// different now, and do I want all of it".
//
// The tree's own answer, not the run's: everything that differs from HEAD,
// including anything the person changed themselves. Attributing a change to a
// turn is the transcript's job.
//
// Every git operation goes through `git-undo.ts` (P3.5), which is where the
// path checks live. This component names paths and nothing else — a UI that
// composes its own pathspec is how "revert this file" becomes `checkout .`.

import { useCallback, useEffect, useState } from "react";
import { parseDiff, type DiffCard } from "../lib/stream";

/** The transcript's diff card, unchanged: one grammar for a diff, everywhere. */
function Hunks({ diff }: { diff: DiffCard }) {
  return (
    <div className="diff-card">
      <div className="diff-header">
        <span>{diff.path}</span>
        <span className="counts">
          <span className="stat-add">+{diff.added}</span>{" "}
          <span className="stat-rem">−{diff.removed}</span> · {diff.range}
        </span>
      </div>
      <div className="diff-body">
        {diff.lines.map((line, i) => (
          <div key={i} className={`diff-line ${line.kind}`}>
            <span className="diff-no">{line.no ?? ""}</span>
            <span className="diff-marker">
              {line.kind === "add" ? "+" : line.kind === "rem" ? "-" : " "}
            </span>
            <span className="diff-code">{line.text || " "}</span>
          </div>
        ))}
        {diff.hiddenLines > 0 ? (
          <div className="diff-more">… {diff.hiddenLines} more diff lines</div>
        ) : null}
      </div>
    </div>
  );
}

export interface ChangedFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  untracked: boolean;
}

export interface ReviewDiff {
  repo: boolean;
  branch?: string;
  files: ChangedFile[];
  patch: string;
  reason?: string;
}

export interface CheckResult {
  ran: boolean;
  passed: boolean;
  report: string;
}

/** One file's hunks, cut out of the whole-tree patch. */
export function patchForFile(patch: string, path: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  let inFile = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inFile = line.includes(` b/${path}`) || line.endsWith(`/${path}`);
      continue;
    }
    if (!inFile) continue;
    if (
      /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename|old mode|new mode)/.test(line)
    )
      continue;
    out.push(line);
  }
  return out.join("\n");
}

export function ReviewPanel(props: {
  diff: ReviewDiff | null;
  checks: CheckResult | null;
  busy: boolean;
  onRefresh: () => void;
  onRevert: (paths: string[]) => void;
  onOpen: (path: string) => void;
  onRunChecks: () => void;
  onClose: () => void;
}) {
  const { diff } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    if (!diff?.files.length) setSelected(null);
    else if (!selected || !diff.files.some((f) => f.path === selected)) {
      setSelected(diff.files[0]!.path);
    }
  }, [diff, selected]);

  const file = diff?.files.find((f) => f.path === selected) ?? null;
  const hunks = file && diff ? patchForFile(diff.patch, file.path) : "";

  const revert = useCallback(
    (path: string) => {
      setConfirming(null);
      props.onRevert([path]);
    },
    [props],
  );

  return (
    <section className="review" aria-label="Review changes">
      <div className="review-head">
        <span className="meta">Review</span>
        <span className="review-sub">
          {!diff
            ? "reading the working tree…"
            : !diff.repo
              ? (diff.reason ?? "not a git repository — nothing to compare against")
              : diff.files.length === 0
                ? "the working tree matches HEAD"
                : `${diff.files.length} file${diff.files.length === 1 ? "" : "s"} differ from HEAD${diff.branch ? ` on ${diff.branch}` : ""}`}
        </span>
        <button className="tb-btn" onClick={props.onRefresh} disabled={props.busy}>
          Refresh
        </button>
        <button className="tb-btn" onClick={props.onRunChecks} disabled={props.busy}>
          Run checks
        </button>
        <button className="tb-btn" onClick={props.onClose}>
          Close <kbd>esc</kbd>
        </button>
      </div>

      {props.checks ? (
        <div className={`review-checks ${props.checks.passed ? "ok" : "bad"}`}>
          <span className="meta">
            {!props.checks.ran ? "no checks" : props.checks.passed ? "passed" : "failed"}
          </span>
          {/* Verbatim. A check's own words are the evidence; a summary of them
              is the agent's claim about the evidence. */}
          <pre>{props.checks.report}</pre>
        </div>
      ) : null}

      {diff?.repo && diff.files.length > 0 ? (
        <div className="review-body">
          <div className="review-tree" role="list">
            {diff.files.map((f) => (
              <div
                key={f.path}
                role="listitem"
                className={`review-file ${f.path === selected ? "sel" : ""}`}
                onClick={() => setSelected(f.path)}
              >
                <span className={`rf-status ${f.untracked ? "new" : ""}`}>
                  {f.untracked ? "new" : f.status}
                </span>
                <span className="rf-path">{f.path}</span>
                <span className="rf-count">
                  {f.added > 0 ? <span className="add">+{f.added}</span> : null}
                  {f.removed > 0 ? <span className="rem">−{f.removed}</span> : null}
                </span>
              </div>
            ))}
          </div>

          <div className="review-detail">
            {file ? (
              <>
                <div className="review-actions">
                  <span className="rf-path">{file.path}</span>
                  <button className="perm-btn" onClick={() => props.onOpen(file.path)}>
                    Open in editor
                  </button>
                  {confirming === file.path ? (
                    <>
                      <span className="review-warn">
                        {file.untracked
                          ? "this file is not in git — reverting DELETES it"
                          : "restore this file from HEAD?"}
                      </span>
                      <button className="perm-btn deny" onClick={() => revert(file.path)}>
                        {file.untracked ? "Delete it" : "Revert it"}
                      </button>
                      <button className="perm-btn" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button className="perm-btn" onClick={() => setConfirming(file.path)}>
                      Revert this file
                    </button>
                  )}
                </div>
                {file.untracked ? (
                  <div className="review-note">
                    A new file. git has no version to compare it with, so there is no diff to show —
                    open it to read it.
                  </div>
                ) : hunks.trim() ? (
                  <Hunks diff={parseDiff(file.path, hunks)} />
                ) : (
                  <div className="review-note">
                    No text hunks for this path — it may be binary, or a mode or rename change.
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
