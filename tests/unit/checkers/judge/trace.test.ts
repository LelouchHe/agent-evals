import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTrace } from "../../../../src/checkers/judge/trace.ts";

test("renderTrace keeps every step in order with tool input and output from either field", () => {
  const long = "x".repeat(5_000);
  const text = renderTrace([
    { type: "thought", text: "Check the log first." },
    {
      type: "tool",
      toolCallId: "a",
      title: "cat deploy.log",
      kind: "execute",
      status: "completed",
      rawInput: { command: "cat deploy.log" },
      // Pi and Claude report output as content blocks.
      content: [
        { type: "content", content: { type: "text", text: `E4127 publish aborted ${long}` } },
        { type: "diff", path: "/w/diagnosis.md", oldText: null, newText: "..." },
      ],
      rawOutput: "ignored when content has text",
    },
    // Without text content, the raw output is the evidence.
    { type: "tool", toolCallId: "b", rawOutput: { exitCode: 1 } },
    { type: "message", text: "Done." },
  ]);
  assert.equal(
    text,
    [
      "[1] thought:\nCheck the log first.",
      `[2] tool call: cat deploy.log (kind execute, status completed)\ninput: {"command":"cat deploy.log"}\noutput:\nE4127 publish aborted ${long}\n(edited /w/diagnosis.md)`,
      '[3] tool call: (untitled) (kind unknown, status unknown)\noutput:\n{"exitCode":1}',
      "[4] message:\nDone.",
    ].join("\n\n"),
  );
  assert.equal(renderTrace([]), "(the runner recorded no steps)");
});
