import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { RunnerTokens, RunnerUsage } from "../../engine/registry.ts";

/**
 * ACP's unstable prompt-response usage. The stable client passes the field through untyped, so
 * this schema is the only check of its shape; a mismatch drops it instead of failing the run.
 * `_meta` and any other extra field are ignored.
 */
const tokenCount = z.number().int().min(0);
const tokenUsageSchema = z.object({
  totalTokens: tokenCount,
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  thoughtTokens: tokenCount.nullable().optional(),
  cachedReadTokens: tokenCount.nullable().optional(),
  cachedWriteTokens: tokenCount.nullable().optional(),
});

/** Accumulates what an ACP harness reports: context and cost from updates, tokens from the turn. */
export class AcpUsage {
  #context: RunnerUsage["context"];
  #cost: RunnerUsage["cost"];
  #tokens: RunnerTokens | undefined;

  /** Apply one session update. A `usage_update` replaces the context and, when it carries one, the cost. */
  add(update: SessionUpdate): void {
    if (update.sessionUpdate !== "usage_update") return;
    this.#context = { used: update.used, size: update.size };
    // An omitted cost leaves the last one; null clears it; a value replaces it.
    if (update.cost === undefined) return;
    this.#cost = update.cost === null ? undefined : { amount: update.cost.amount, currency: update.cost.currency };
  }

  /** Read the unstable usage from a prompt response; a malformed field is dropped. */
  setPromptUsage(response: PromptResponse): void {
    const usage = tokenUsageSchema.safeParse((response as { readonly usage?: unknown }).usage);
    if (!usage.success) return;
    const { totalTokens, inputTokens, outputTokens, thoughtTokens, cachedReadTokens, cachedWriteTokens } = usage.data;
    this.#tokens = {
      totalTokens,
      inputTokens,
      outputTokens,
      ...(thoughtTokens === null || thoughtTokens === undefined ? {} : { thoughtTokens }),
      ...(cachedReadTokens === null || cachedReadTokens === undefined ? {} : { cachedReadTokens }),
      ...(cachedWriteTokens === null || cachedWriteTokens === undefined ? {} : { cachedWriteTokens }),
    };
  }

  /** What the harness reported so far; absent when it reported nothing. */
  get value(): RunnerUsage | undefined {
    if (this.#context === undefined && this.#cost === undefined && this.#tokens === undefined) return undefined;
    return {
      ...(this.#context === undefined ? {} : { context: this.#context }),
      ...(this.#cost === undefined ? {} : { cost: this.#cost }),
      ...(this.#tokens === undefined ? {} : { tokens: this.#tokens }),
    };
  }
}
