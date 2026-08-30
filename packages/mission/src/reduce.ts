// ─── Gear · the reducer ───
// Pure. Replayable. No prose in, no prose out. Every screen in the product is a
// projection of the state this file builds, and the only way into it is a typed
// event — so the surface can render "concluded, 4 of 4 criteria met" only when four
// events carrying evidence said so.
//
// Success is not a state. It is a count of criteria, each of which needs an event
// carrying evidence to flip, which is why `conclude()` cannot set one.

import {
  type AgentResult,
  type Criterion,
  type DecisionOption,
  type Evidence,
  type MissionEvent,
  type PhaseOutcome,
  type PlanStep,
  type Rung,
  evidenceSupportsVerified,
} from "./events";

export type MissionPhase =
  | "drafting"
  | "agreed"
  | "running"
  | "held"
  | "recovering"
  | "verifying"
  | "reviewing"
  | "concluded"
  | "abandoned";

export type PhaseState = "queued" | "blocked" | "running" | "retrying" | "closed";

export interface CriterionState extends Criterion {
  met: boolean;
  /** absent until a CRITERION_MET event carries one. never inferred. */
  evidence?: Evidence;
  detail?: string;
}

export interface Phase {
  index: string;
  title: string;
  state: PhaseState;
  dependsOn: string[];
  from?: string;
  outcome?: PhaseOutcome;
  summary?: string;
  rung?: Rung;
  elapsedMs?: number;
  openedAt?: number;
}

export interface Agent {
  id: string;
  role: string;
  objective: string;
  scope: string[];
  tools: string;
  budgetTokens: number;
  phase?: string;
  state: "spawned" | "running" | "returned" | "killed" | "starved";
  result?: AgentResult;
  summary?: string;
  rung?: Rung;
  elapsedMs?: number;
  tokens: number;
}

export interface Tool {
  id: string;
  verb: string;
  args: string;
  actor: string;
  phase?: string;
  running: boolean;
  exit?: number;
  detail?: string;
  bytes: number;
  elapsedMs?: number;
  rung?: Rung;
  startedAt: number;
  /** when output last arrived. the pulse reads this; nothing else may. */
  lastProgressAt?: number;
}

export interface Finding {
  id: string;
  claim: string;
  body: string[];
  evidence: Evidence[];
  rung: Rung;
  creates?: string;
  criteria: string[];
  outOfScope: boolean;
}

export interface Change {
  path: string;
  hunks: number;
  added: number;
  removed: number;
  cause?: string;
  tests: string[];
  newFile: boolean;
}

export interface Check {
  kind: string;
  runner: string;
  passed: number;
  total: number;
  baseline?: string;
  baselineFailed?: boolean;
  elapsedMs: number;
  rung: Rung;
  failures: string[];
}

export interface Decision {
  id: string;
  question: string;
  options: DecisionOption[];
  recommendation: string;
  reasoning: string[];
  idleAgents: number;
  queuedMs: number;
  state: "open" | "answered" | "withdrawn";
  chosen?: string;
  by?: "human" | "default";
  heldMs?: number;
  note?: string;
}

export interface Risk {
  id: string;
  statement: string;
  severity: "low" | "medium" | "high";
  mitigation: string;
  state: "open" | "closed";
  how?: string;
}

export interface Constraint {
  id: string;
  text: string;
  affects: string[];
  reverts: string;
  cost: string[];
}

export interface Checkpoint {
  seq: number;
  at: number;
  treeSha: string;
  planRevision: number;
  openAgents: string[];
}

export interface MissionState {
  id?: string;
  objective?: string;
  scope: string[];
  exclusions: string[];
  budget?: string;
  /** the commit every "red before the change" claim is judged against */
  baseline?: string;
  phase: MissionPhase;
  criteria: CriterionState[];
  planRevision: number;
  planCause?: string;
  phases: Phase[];
  agents: Agent[];
  tools: Tool[];
  findings: Finding[];
  changes: Change[];
  checks: Check[];
  decisions: Decision[];
  constraints: Constraint[];
  risks: Risk[];
  /** what was summarised away, so compaction is never silent */
  compactions: Array<{ summarised: string; fromSeq: number; toSeq: number; tokensFreed: number }>;
  checkpoints: Checkpoint[];
  openedAt?: number;
  concludedAt?: number;
  /** carried by MISSION_CONCLUDED: the mission's own measure of how long it took */
  concludedElapsedMs?: number;
  lastSeq: number;
  lastAt: number;
}

export function initialState(): MissionState {
  return {
    scope: [],
    exclusions: [],
    phase: "drafting",
    criteria: [],
    planRevision: 0,
    phases: [],
    agents: [],
    tools: [],
    findings: [],
    changes: [],
    checks: [],
    decisions: [],
    constraints: [],
    risks: [],
    compactions: [],
    checkpoints: [],
    lastSeq: 0,
    lastAt: 0,
  };
}

/** Thrown when an event would put the mission in a state the product cannot draw. */
export class InvariantError extends Error {}

const upsertPhase = (phases: Phase[], step: PlanStep): Phase => {
  const found = phases.find((p) => p.index === step.index);
  if (found) {
    found.title = step.title;
    found.dependsOn = step.dependsOn;
    found.from = step.from;
    return found;
  }
  const created: Phase = {
    index: step.index,
    title: step.title,
    state: "queued",
    dependsOn: step.dependsOn,
    from: step.from,
  };
  phases.push(created);
  return created;
};

/**
 * Fold one event into state. Mutates a *copy-on-write* clone so a caller can hold on
 * to the previous state (the surface diffs against it to decide which rows are new
 * and therefore what to append to the stream).
 */
export function reduce(prev: MissionState, ev: MissionEvent): MissionState {
  const s: MissionState = {
    ...prev,
    criteria: prev.criteria.map((c) => ({ ...c })),
    phases: prev.phases.map((p) => ({ ...p })),
    agents: prev.agents.map((a) => ({ ...a })),
    tools: prev.tools.map((t) => ({ ...t })),
    findings: [...prev.findings],
    changes: [...prev.changes],
    checks: [...prev.checks],
    decisions: prev.decisions.map((d) => ({ ...d })),
    constraints: [...prev.constraints],
    risks: prev.risks.map((r) => ({ ...r })),
    compactions: [...prev.compactions],
    checkpoints: [...prev.checkpoints],
    lastSeq: ev.seq,
    lastAt: ev.at,
  };

  switch (ev.type) {
    case "MISSION_OPENED":
      s.id = ev.id;
      s.objective = ev.objective;
      s.scope = ev.scope;
      s.exclusions = ev.exclusions;
      s.budget = ev.budget;
      s.criteria = ev.criteria.map((c) => ({ ...c, met: false }));
      s.baseline = ev.baseline;
      s.phase = "agreed";
      s.openedAt = ev.at;
      break;

    case "PLAN_SET": {
      s.planRevision = ev.revision;
      s.planCause = ev.cause;
      for (const step of ev.steps) upsertPhase(s.phases, step);
      // A plan that drops a step does not erase what already happened there: closed
      // phases stay, so scrollback keeps meaning something after a revision.
      s.phases = s.phases.filter(
        (p) => ev.steps.some((st) => st.index === p.index) || p.state === "closed",
      );
      break;
    }

    case "PHASE_OPENED": {
      const p =
        s.phases.find((x) => x.index === ev.index) ??
        upsertPhase(s.phases, { index: ev.index, title: ev.title, dependsOn: [] });
      p.title = ev.title;
      p.state = "running";
      p.openedAt = ev.at;
      if (s.phase === "agreed" || s.phase === "held" || s.phase === "recovering")
        s.phase = "running";
      break;
    }

    case "PHASE_CLOSED": {
      const p = s.phases.find((x) => x.index === ev.index);
      if (!p) throw new InvariantError(`PHASE_CLOSED for unknown phase ${ev.index}`);
      p.state = "closed";
      p.outcome = ev.outcome;
      p.summary = ev.summary;
      p.rung = ev.rung;
      p.elapsedMs = ev.elapsedMs;
      break;
    }

    case "TOOL_STARTED":
      s.tools.push({
        id: ev.id,
        verb: ev.verb,
        args: ev.args,
        actor: ev.actor,
        phase: ev.phase,
        running: true,
        bytes: 0,
        startedAt: ev.at,
      });
      break;

    case "TOOL_PROGRESS": {
      const t = s.tools.find((x) => x.id === ev.id);
      if (!t) throw new InvariantError(`TOOL_PROGRESS for unknown tool ${ev.id}`);
      t.bytes += ev.bytes;
      t.lastProgressAt = ev.at;
      if (ev.detail !== undefined) t.detail = ev.detail;
      break;
    }

    case "TOOL_ENDED": {
      const t = s.tools.find((x) => x.id === ev.id);
      if (!t) throw new InvariantError(`TOOL_ENDED for unknown tool ${ev.id}`);
      t.running = false;
      t.exit = ev.exit;
      t.detail = ev.detail;
      t.bytes = ev.bytes;
      t.elapsedMs = ev.elapsedMs;
      t.rung = ev.rung;
      break;
    }

    case "AGENT_SPAWNED":
      s.agents.push({
        id: ev.id,
        role: ev.role,
        objective: ev.objective,
        scope: ev.scope,
        tools: ev.tools,
        budgetTokens: ev.budgetTokens,
        phase: ev.phase,
        state: "running",
        tokens: 0,
      });
      break;

    case "AGENT_RETURNED": {
      const a = s.agents.find((x) => x.id === ev.id);
      if (!a) throw new InvariantError(`AGENT_RETURNED for unknown agent ${ev.id}`);
      a.state = ev.result;
      a.result = ev.result;
      a.summary = ev.summary;
      a.rung = ev.rung;
      a.elapsedMs = ev.elapsedMs;
      a.tokens = ev.tokens;
      break;
    }

    case "FINDING_OPENED":
      s.findings.push({
        id: ev.id,
        claim: ev.claim,
        body: ev.body,
        evidence: ev.evidence,
        rung: ev.rung,
        creates: ev.creates,
        criteria: ev.criteria,
        outOfScope: ev.outOfScope ?? false,
      });
      break;

    case "CHANGE_APPLIED":
      s.changes.push({
        path: ev.path,
        hunks: ev.hunks,
        added: ev.added,
        removed: ev.removed,
        cause: ev.cause,
        tests: ev.tests,
        newFile: ev.newFile ?? false,
      });
      break;

    case "CHECK_RESULT":
      // A check that was never run against the parent commit cannot be evidence that
      // the change is what made it green. No baseline, no `✓` — enforced here so no
      // render path has to be trusted to remember it.
      if (ev.rung === "verified" && !(ev.baseline && ev.baselineFailed))
        throw new InvariantError(
          `check "${ev.kind}" claims verified without a baseline that failed — that is not evidence`,
        );
      s.checks.push({
        kind: ev.kind,
        runner: ev.runner,
        passed: ev.passed,
        total: ev.total,
        baseline: ev.baseline,
        baselineFailed: ev.baselineFailed,
        elapsedMs: ev.elapsedMs,
        rung: ev.rung,
        failures: ev.failures ?? [],
      });
      if (s.phase === "running") s.phase = "verifying";
      break;

    case "DECISION_OPENED":
      s.decisions.push({
        id: ev.id,
        question: ev.question,
        options: ev.options,
        recommendation: ev.recommendation,
        reasoning: ev.reasoning,
        idleAgents: ev.idleAgents,
        queuedMs: ev.queuedMs,
        state: "open",
      });
      // The one screen that blocks, and the state that admits it.
      s.phase = "held";
      break;

    case "DECISION_TAKEN": {
      const d = s.decisions.find((x) => x.id === ev.id);
      if (!d) throw new InvariantError(`DECISION_TAKEN for unknown decision ${ev.id}`);
      if (d.state !== "open") throw new InvariantError(`decision ${ev.id} was already ${d.state}`);
      d.state = "answered";
      d.chosen = ev.chosen;
      d.by = ev.by;
      d.heldMs = ev.heldMs;
      d.note = ev.note;
      if (!s.decisions.some((x) => x.state === "open")) s.phase = "running";
      break;
    }

    case "DECISION_WITHDRAWN": {
      const d = s.decisions.find((x) => x.id === ev.id);
      if (!d) throw new InvariantError(`DECISION_WITHDRAWN for unknown decision ${ev.id}`);
      d.state = "withdrawn";
      d.note = ev.why;
      if (!s.decisions.some((x) => x.state === "open")) s.phase = "running";
      break;
    }

    case "CONSTRAINT_ADDED":
      // Typing prose during execution is not an interrupt. Nothing pauses here.
      s.constraints.push({
        id: ev.id,
        text: ev.text,
        affects: ev.affects,
        reverts: ev.reverts,
        cost: ev.cost,
      });
      break;

    case "CRITERION_MET": {
      const c = s.criteria.find((x) => x.id === ev.id);
      if (!c) throw new InvariantError(`CRITERION_MET for unknown criterion ${ev.id}`);
      if (!evidenceSupportsVerified(ev.evidence) && ev.evidence.kind === "test")
        throw new InvariantError(
          `criterion ${ev.id} cites a test that did not fail on its baseline — that is not evidence`,
        );
      c.met = true;
      c.evidence = ev.evidence;
      c.detail = ev.detail;
      break;
    }

    case "RISK_OPENED":
      s.risks.push({
        id: ev.id,
        statement: ev.statement,
        severity: ev.severity,
        mitigation: ev.mitigation,
        state: "open",
      });
      break;

    case "RISK_CLOSED": {
      const r = s.risks.find((x) => x.id === ev.id);
      if (!r) throw new InvariantError(`RISK_CLOSED for unknown risk ${ev.id}`);
      r.state = "closed";
      r.how = ev.how;
      break;
    }

    case "COMPACTED":
      s.compactions.push({
        summarised: ev.summarised,
        fromSeq: ev.fromSeq,
        toSeq: ev.toSeq,
        tokensFreed: ev.tokensFreed,
      });
      break;

    case "MISSION_CONCLUDED":
      // Concluded, not complete: a mission concludes whether it succeeded or not, and
      // this cannot flip a criterion. The terminus renders the same shape either way.
      s.phase = ev.outcome;
      s.concludedAt = ev.at;
      s.concludedElapsedMs = ev.elapsedMs;
      break;

    case "CHECKPOINT":
      s.checkpoints.push({
        seq: ev.seq,
        at: ev.at,
        treeSha: ev.treeSha,
        planRevision: ev.planRevision,
        openAgents: ev.openAgents,
      });
      break;
  }

  return s;
}

/** Fold a whole log. A restart does exactly this and nothing else. */
export function replay(events: MissionEvent[], from = initialState()): MissionState {
  return events.reduce(reduce, from);
}

// ─── derived facts the surfaces ask for ───
// All of them are counts of things that either happened or did not. There is no
// percentage anywhere in this file, and there is no estimate of remaining time.

export const closedPhases = (s: MissionState) =>
  s.phases.filter((p) => p.state === "closed").length;

export const runningAgents = (s: MissionState) =>
  s.agents.filter((a) => a.state === "running" || a.state === "spawned").length;

export const openDecisions = (s: MissionState) => s.decisions.filter((d) => d.state === "open");

export const blockers = (s: MissionState) => openDecisions(s).length;

export const metCriteria = (s: MissionState) => s.criteria.filter((c) => c.met).length;

export const diffTotals = (s: MissionState) =>
  s.changes.reduce((acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }), {
    added: 0,
    removed: 0,
  });

/** The mission's own clock. Elapsed is a fact; remaining would be a guess. */
export const elapsedMs = (s: MissionState) =>
  s.concludedElapsedMs ?? (s.openedAt ? (s.concludedAt ?? s.lastAt) - s.openedAt : 0);
