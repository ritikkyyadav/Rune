// ─── Plan Types ───
// Mirrors Rust protocol.rs plan types for cross-language compatibility.

export interface Plan {
  id: string;
  steps: Step[];
  status: PlanStatus;
  createdAt: string;
}

export interface Step {
  index: number;
  description: string;
  toolsHint: string[];
  successCriteria: string;
  status: StepStatus;
  result?: StepResult;
  dependsOn: number[];
}

export type PlanStatus = "active" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface StepResult {
  success: boolean;
  summary: string;
  artifacts: string[];
  error?: string;
}

// ─── Model Routing ───

export interface ModelRouting {
  /** Model used for planning (slow, high-capability). */
  planner: string;
  /** Model used for step execution (fast, cheap). */
  executor: string;
  /** Provider for planner model. */
  plannerProvider: string;
  /** Provider for executor model. */
  executorProvider: string;
}
