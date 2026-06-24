// ─── Tool-call rendering (compatibility shim) ───
// The Codex-style 6-line preview that used to live here was the source of the
// "cluttered" feel. Tool rendering now lives in ./activity as a single compact
// line per call (the thought-chain language shared by the live stream and the
// resume replay). This shim keeps the old `renderToolCall` / `ToolCallView`
// names working for existing call sites.

export { renderToolActivity as renderToolCall } from "./activity";
export type { ToolActivityView as ToolCallView } from "./activity";
