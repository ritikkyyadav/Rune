/**
 * Model-level capability facts, for gates that were previously keyed on the
 * PROVIDER name.
 *
 * The vision gate is the example this file was written for. It read
 * `this.name === "openai"`, which meant a session on
 * `openrouter/anthropic/claude-sonnet-4-6` — a model that sees images perfectly
 * well — had its screenshots stripped and replaced with "the transport does not
 * send images to this host". The transport sends them fine; the gate was asking
 * the wrong question.
 *
 * The safe direction is preserved: an id nobody recognizes gets NO pixels and
 * an honest note, because a silently dropped screenshot is worse than none —
 * the agent believes it looked.
 */

/**
 * Model families known to accept image parts on an OpenAI-compatible wire.
 * Matched against the model id with the host's route prefix stripped, so
 * `anthropic/claude-sonnet-4-6` and a bare `claude-sonnet-4-6` both hit.
 */
const VISION_FAMILIES: RegExp[] = [
  // Anthropic: every Claude 3 and later sees images.
  /^claude-/,
  // OpenAI: 4o, 4.1, 5.x and the o-series reasoning models.
  /^gpt-4o/,
  /^gpt-4\.1/,
  /^gpt-5/,
  /^o[134](-|$)/,
  // Google Gemini is multimodal across the line.
  /^gemini-/,
  // Meta's vision checkpoints.
  /^llama-3\.2-.*vision/,
  /^llama-4/,
  // Mistral's multimodal line.
  /^pixtral/,
  // Qwen vision-language.
  /-vl(-|:|$)/,
  // Common open-weight naming: llava, and anything that says "vision".
  /^llava/,
  /vision/,
];

/**
 * Strip a host's route prefix from a model id: OpenRouter serves
 * `anthropic/claude-sonnet-4-6`, Groq serves `openai/gpt-oss-120b`. The family
 * test wants the model, not the route.
 */
function bareModelId(model: string): string {
  const lower = model.toLowerCase();
  const slash = lower.lastIndexOf("/");
  return slash === -1 ? lower : lower.slice(slash + 1);
}

/**
 * Whether this model is known to accept image parts.
 *
 * Deliberately an allowlist. An OpenAI-compatible host serving an arbitrary
 * checkpoint may hard-400 on an image part, and "unknown" has to mean "do not
 * send pixels" — but it should no longer mean "every model on this host is
 * blind", which is what the provider-name gate said.
 */
export function modelSeesImages(model: string): boolean {
  const id = bareModelId(model);
  return VISION_FAMILIES.some((re) => re.test(id));
}
