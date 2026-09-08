import type { StepEvidence, TodoItem } from "@rune/protocol";

export interface StepShape {
  /** The step must change the implementation: a write is required. */
  change: boolean;
  /** The step must prove behaviour: a passing check after the latest write is required. */
  verify: boolean;
  /**
   * The wording (or an explicit kind) names an action the ledger can check.
   * False means the step will close on "something ran" — the case the
   * `kind` field exists for, and the case worth asking about once.
   */
  recognised: boolean;
}

/**
 * What a step's wording commits it to. The verb lists are English and
 * deliberately short; `kind` is the structural path and always wins.
 */
export function stepShape(item: Pick<TodoItem, "content" | "kind">): StepShape {
  const text = item.content.toLowerCase();
  const actions = text.split(/(?:^|\b(?:and|then)\b|[;,])\s*/).map((s) => s.trim());
  const change =
    item.kind === "change" ||
    actions.some((s) =>
      /^(?:implement|fix|refactor|integrate|wire|scaffold|add|create|write|edit|update|remove|rename|migrate|patch)\b/.test(
        s,
      ),
    ) ||
    /\bbuild\b.*\b(?:feature|page|screen|dashboard|interface|website|application|app)\b/.test(text);
  const verify =
    item.kind === "verify" ||
    actions.some((s) => /^(?:verify|validate|test|typecheck|lint|compile|prove)\b/.test(s)) ||
    /\b(?:run|execute)\b.*\b(?:checks?|build)\b/.test(text);
  const inspect =
    item.kind === "inspect" ||
    actions.some((s) =>
      /^(?:read|inspect|review|audit|survey|scan|explore|understand|investigate|look|check|examine|list|find|locate|map|study|research|search|grep|trace|compare|analy[sz]e|identify|confirm|decide|choose|plan|design|draft|document|summari[sz]e)\b/.test(
        s,
      ),
    );
  return { change, verify, recognised: change || verify || inspect };
}

/** Activity is useful provenance, but it is not interchangeable with a step's required effect. */
export function missingStepEvidence(
  item: Pick<TodoItem, "content" | "kind">,
  ev?: StepEvidence,
): string | null {
  if (!ev) return "nothing ran while it was open";
  const { change, verify } = stepShape(item);
  const missing: string[] = [];
  if (change && ev.writes === 0) missing.push("no implementation was written");
  if ((verify || (change && ev.lastCheck)) && (!ev.lastCheck?.passed || ev.writesSinceCheck > 0))
    missing.push("no passing check after the latest change");
  if (missing.length) return missing.join("; ");
  if (change || verify) return null;
  if (
    ev.reads + ev.writes + ev.runs + ev.checksPassed + ev.answers + ev.delegations + ev.looks ===
    0
  )
    return "nothing ran while it was open";
  return null;
}
