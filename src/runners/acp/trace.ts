import type { SessionUpdate } from "@agentclientprotocol/sdk";

type TextEntry = { type: "message" | "thought"; text: string };
type ToolEntry = { type: "tool"; toolCallId: string; [field: string]: unknown };

/**
 * Assembles ACP session updates into trace entries. Consecutive text chunks of one kind are
 * joined. ACP updates replace the fields they carry, so every update for a `toolCallId` is
 * merged into one entry that keeps only the call's final state.
 */
export class AcpTrace {
  readonly entries: (TextEntry | ToolEntry)[] = [];
  readonly #tools = new Map<string, ToolEntry>();

  add(update: SessionUpdate): void {
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type !== "text") return;
      const type = update.sessionUpdate === "agent_message_chunk" ? "message" : "thought";
      const last = this.entries.at(-1);
      if (last?.type === type) last.text += update.content.text;
      else this.entries.push({ type, text: update.content.text });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const { sessionUpdate: _, toolCallId, ...fields } = update;
      let entry = this.#tools.get(toolCallId);
      if (entry === undefined) {
        entry = { type: "tool", toolCallId };
        this.#tools.set(toolCallId, entry);
        this.entries.push(entry);
      }
      // Absent and null fields leave the previous value unchanged.
      for (const [field, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null) entry[field] = value;
      }
    }
  }

  /** The agent's text after its last tool call. */
  finalText(): string | null {
    const last = this.entries.findLastIndex((entry) => entry.type === "tool");
    const text = this.entries
      .slice(last + 1)
      .flatMap((entry) => (entry.type === "message" ? [entry.text] : []))
      .join("");
    return text === "" ? null : text;
  }
}
