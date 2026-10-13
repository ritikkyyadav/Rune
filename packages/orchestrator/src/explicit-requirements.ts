/**
 * Surface explicit obligations from the runtime request without deciding what
 * they mean or whether work satisfied them. This intentionally misses implied
 * requirements. Fences, indented code, blockquotes and quoted examples are
 * skipped because their words may be data rather than instructions.
 */
export function explicitRequirements(request: string): string[] {
  const found: string[] = [];
  let fence: "`" | "~" | null = null;
  for (const line of request.split(/\r?\n/)) {
    const edge = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (edge) {
      if (fence === null) fence = edge[0] as "`" | "~";
      else if (edge[0] === fence) fence = null;
      continue;
    }
    if (fence || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line)) continue;
    const raw = line.trim();
    const body = raw.replace(/^(?:[-*+] |\d+[.)] )/, "");
    if (!body || /^['"“‘`]/.test(body)) continue;
    for (const part of raw.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const sentence = part.trim();
      // Search outside quoted examples; keep the original sentence untouched.
      const instruction = sentence
        .replace(/^(?:[-*+] |\d+[.)] )/, "")
        .replace(/`[^`]*`|"[^"]*"|“[^”]*”|'[^']*'|‘[^’]*’/g, "");
      if (
        /\bmust(?:\s+not)?\b|\bdo\s+not\b/i.test(instruction) ||
        /^(?:please\s+)?(?:never|keep)\b/i.test(instruction) ||
        /[,;:]\s*(?:never|keep)\b/i.test(instruction)
      )
        found.push(sentence);
    }
  }
  return [...new Set(found)];
}
