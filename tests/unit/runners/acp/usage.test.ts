import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { AcpUsage } from "../../../../src/runners/acp/usage.ts";

function update(
  update: Omit<Extract<SessionUpdate, { sessionUpdate: "usage_update" }>, "sessionUpdate">,
): SessionUpdate {
  return { sessionUpdate: "usage_update", ...update };
}

function response(usage: unknown): PromptResponse {
  return { stopReason: "end_turn", usage } as unknown as PromptResponse;
}

test("context and cost follow usage updates; omitted cost stays and null clears it", () => {
  const usage = new AcpUsage();
  assert.equal(usage.value, undefined);

  usage.add(
    update({
      used: 10,
      size: 100,
      cost: { amount: 0.5, currency: "USD", _meta: { private: true } },
      _meta: { claude: "rate-limits" },
    }),
  );
  assert.deepEqual(usage.value, { context: { used: 10, size: 100 }, cost: { amount: 0.5, currency: "USD" } });

  // An update without a cost leaves the last one, and the context is replaced.
  usage.add(update({ used: 20, size: 200 }));
  assert.deepEqual(usage.value, { context: { used: 20, size: 200 }, cost: { amount: 0.5, currency: "USD" } });

  usage.add(update({ used: 30, size: 300, cost: { amount: 0.75, currency: "EUR" } }));
  assert.deepEqual(usage.value, { context: { used: 30, size: 300 }, cost: { amount: 0.75, currency: "EUR" } });

  usage.add(update({ used: 40, size: 400, cost: null }));
  assert.deepEqual(usage.value, { context: { used: 40, size: 400 } });

  // Other session updates never change usage.
  usage.add({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
  assert.deepEqual(usage.value, { context: { used: 40, size: 400 } });
});

test("the unstable prompt usage is recorded when valid and dropped when malformed", () => {
  const usage = new AcpUsage();
  usage.setPromptUsage(
    response({
      totalTokens: 350,
      inputTokens: 300,
      outputTokens: 50,
      thoughtTokens: 5,
      cachedReadTokens: 200,
      cachedWriteTokens: 100,
      _meta: { ignored: true },
    }),
  );
  assert.deepEqual(usage.value, {
    tokens: {
      totalTokens: 350,
      inputTokens: 300,
      outputTokens: 50,
      thoughtTokens: 5,
      cachedReadTokens: 200,
      cachedWriteTokens: 100,
    },
  });

  // Null or omitted optional counts are left out, not recorded as zero.
  usage.setPromptUsage(response({ totalTokens: 3, inputTokens: 2, outputTokens: 1, thoughtTokens: null }));
  assert.deepEqual(usage.value, { tokens: { totalTokens: 3, inputTokens: 2, outputTokens: 1 } });

  for (const malformed of [
    undefined,
    null,
    {},
    { totalTokens: "350", inputTokens: 300, outputTokens: 50 },
    { totalTokens: 350, inputTokens: 300 },
  ]) {
    const dropped = new AcpUsage();
    dropped.setPromptUsage(response(malformed));
    assert.equal(dropped.value, undefined);
  }
});
