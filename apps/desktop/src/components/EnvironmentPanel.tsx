import { useMemo, useState } from "react";
import type { ConnectionState, EngineStatus, Plan, ToolCallInfo } from "../lib/types";
import {
  BranchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  MonitorIcon,
  ShieldIcon,
  SlidersIcon,
} from "./Icons";

interface EnvironmentPanelProps {
  status: EngineStatus;
  connectionState: ConnectionState;
  workspace: string;
  toolCalls: ToolCallInfo[];
  plan: Plan | null;
  planOpen: boolean;
  onReview: () => void;
  onTogglePlan: () => void;
}

const WRITE_TOOL_PATTERN = /(apply.?patch|edit|write|replace|create|delete|move|rename)/i;
const FILE_PATH_PATTERN = /(?:^|[\s"'`])((?:[\w.-]+\/)+[\w.@+-]+\.[a-zA-Z0-9]{1,8})/g;

function stringifyArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

export interface ChangeSummary {
  calls: ToolCallInfo[];
  files: string[];
  additions: number;
  deletions: number;
}

export function summarizeChanges(toolCalls: ToolCallInfo[]): ChangeSummary {
  const calls = toolCalls.filter((call) => {
    const searchable = `${call.toolName} ${stringifyArgs(call.args)} ${call.result ?? ""}`;
    return WRITE_TOOL_PATTERN.test(searchable);
  });
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const call of calls) {
    const searchable = `${stringifyArgs(call.args)}\n${call.result ?? ""}`;
    for (const match of searchable.matchAll(FILE_PATH_PATTERN)) files.add(match[1]);
    for (const line of (call.result ?? "").split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }

  return {
    calls,
    files: [...files],
    additions,
    deletions,
  };
}

function compactWorkspace(workspace: string): string {
  if (!workspace || workspace === "~") return "Home workspace";
  return basename(workspace);
}

export function EnvironmentPanel({
  status,
  connectionState,
  workspace,
  toolCalls,
  plan,
  planOpen,
  onReview,
  onTogglePlan,
}: EnvironmentPanelProps) {
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const changes = useMemo(() => summarizeChanges(toolCalls), [toolCalls]);
  const contextPercent =
    status.contextMax > 0
      ? Math.min(Math.round((status.contextUsed / status.contextMax) * 100), 100)
      : 0;
  const completedSteps = plan?.steps.filter((step) => step.status === "completed").length ?? 0;

  return (
    <aside className="environment-dock" aria-label="Environment details">
      <div className="environment-card">
        <header className="environment-card-header">
          <div>
            <span>Environment</span>
            <small className={`environment-live environment-live--${connectionState}`}>
              <i />
              {connectionState === "connected" ? "Ready" : connectionState}
            </small>
          </div>
          <SlidersIcon />
        </header>

        <div className="environment-section">
          <button className="environment-row" type="button" onClick={onReview}>
            <FileDiffIcon />
            <span>Changes</span>
            <b className="change-count">
              {changes.calls.length > 0 ? (
                <>
                  <em>+{changes.additions}</em> <i>-{changes.deletions}</i>
                </>
              ) : (
                "None"
              )}
            </b>
            <ChevronRightIcon />
          </button>

          <div className="environment-row environment-row--static">
            <MonitorIcon />
            <span>Local</span>
            <strong>{compactWorkspace(workspace)}</strong>
          </div>

          <div className="environment-row environment-row--static">
            <BranchIcon />
            <span>Workspace</span>
            <strong title={workspace}>{workspace === "~" ? "Home" : basename(workspace)}</strong>
          </div>

          <div className="environment-row environment-row--static">
            <ShieldIcon />
            <span>Access</span>
            <strong className="safe-label">
              {status.permissionMode === "auto"
                ? "Auto-reviewed"
                : status.permissionMode === "autonomy-iii"
                  ? "Autonomy III"
                  : status.permissionMode === "autonomy-ii"
                    ? "Autonomy II"
                    : status.permissionMode === "autonomy-i"
                      ? "Autonomy I"
                      : "Manual review"}
            </strong>
          </div>
        </div>

        <div className="environment-section environment-section--context">
          <div className="environment-section-title">
            <span>Context</span>
            <b>{contextPercent}%</b>
          </div>
          <div className="environment-meter" aria-label={`${contextPercent}% context used`}>
            <i style={{ width: `${contextPercent}%` }} />
          </div>
          <p>{status.model || "Model not selected"}</p>
        </div>

        {plan ? (
          <div className="environment-section">
            <button className="environment-subheading" type="button" onClick={onTogglePlan}>
              <span>Plan</span>
              <b>
                {completedSteps}/{plan.steps.length}
              </b>
              {planOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
            </button>
            <div className="environment-plan-preview">
              {plan.steps.slice(0, 3).map((step) => (
                <div key={step.index} className={`mini-plan-step mini-plan-step--${step.status}`}>
                  <i>{step.status === "completed" ? "✓" : step.index + 1}</i>
                  <span>{step.description}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="environment-section">
          <button
            className="environment-subheading"
            type="button"
            onClick={() => setSourcesOpen((open) => !open)}
          >
            <span>Changed files</span>
            <b>{changes.files.length}</b>
            {sourcesOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </button>
          {sourcesOpen ? (
            <div className="environment-sources">
              {changes.files.length > 0 ? (
                changes.files.slice(0, 5).map((path) => (
                  <button type="button" key={path} onClick={onReview} title={path}>
                    <FileDiffIcon />
                    <span>{basename(path)}</span>
                  </button>
                ))
              ) : (
                <p>No file edits in this conversation yet.</p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
