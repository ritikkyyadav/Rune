/**
 * Regression evals promoted from real incidents (see from-incidents.ts).
 *
 * The contract: every incident class that fires ≥3 times in the black box gets
 * a deterministic eval here reproducing the failure shape. Scaffolds live in
 * from-incidents/<fp>.task.ts until they're finished; finished tasks are
 * imported and listed below, and their fingerprint recorded in
 * from-incidents/covered.json so the miner stops flagging them.
 */
import type { EvalTask } from "./harness";

export const FROM_INCIDENTS_TASKS: EvalTask[] = [
  // Promoted incident evals go here. Empty is the goal state: it means no
  // recurring failure class is uncovered.
];
