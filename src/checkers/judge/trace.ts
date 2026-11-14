import type { TraceEntry } from "../../engine/registry.ts";

/**
 * Render a trace as plain text in run order: messages and reasoning, and each
 * tool call's title, kind, status, input and output. Nothing is cut.
 */
export function renderTrace(trace: readonly TraceEntry[]): string {
  if (trace.length === 0) return "(the runner recorded no steps)";
  return trace
    .map((entry, index) => {
      const step = `[${index + 1}]`;
      if (entry.type !== "tool") return `${step} ${entry.type}:\n${entry.text}`;
      const kind = typeof entry.kind === "string" ? entry.kind : "unknown";
      const status = typeof entry.status === "string" ? entry.status : "unknown";
      const lines = [`${step} tool call: ${String(entry.title ?? "(untitled)")} (kind ${kind}, status ${status})`];
      if (entry.rawInput !== undefined) lines.push(`input: ${JSON.stringify(entry.rawInput)}`);
      const output = toolOutput(entry);
      if (output !== undefined) lines.push(`output:\n${output}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/** The text a harness reported for the call: content blocks, else its raw output. */
function toolOutput(entry: Extract<TraceEntry, { type: "tool" }>): string | undefined {
  const texts = Array.isArray(entry.content)
    ? entry.content.flatMap((block: unknown) => {
        const item = block as { type?: unknown; content?: { type?: unknown; text?: unknown }; path?: unknown };
        if (item.type === "content" && item.content?.type === "text" && typeof item.content.text === "string") {
          return [item.content.text];
        }
        if (item.type === "diff" && typeof item.path === "string") return [`(edited ${item.path})`];
        return [];
      })
    : [];
  if (texts.length > 0) return texts.join("\n");
  return entry.rawOutput === undefined ? undefined : JSON.stringify(entry.rawOutput);
}
