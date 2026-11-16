import type { TraceEntry } from "./registry.ts";

/**
 * The text the agent produced: every `message` entry of a trace, in run order, concatenated with
 * no separator. `thought` and `tool` entries never contribute, so reasoning and tool output stay
 * out of the artifact. Nothing is truncated; the artifact is the whole recorded text, and a trace
 * with no message text yields the empty string rather than a match target.
 */
export function messageText(trace: readonly TraceEntry[]): string {
  return trace.flatMap((entry) => (entry.type === "message" ? [entry.text] : [])).join("");
}
