import { z } from "zod";
import type { Runner, RunnerContext, RunnerDefinition, RunnerOutcome } from "../../engine/registry.ts";

const noopRunnerParamsSchema = z.strictObject({});

type NoopRunnerParams = z.output<typeof noopRunnerParamsSchema>;

/**
 * The baseline runner: start nothing, call nothing, and record an empty trace so a judge that
 * asks for one is evaluated. A case that still passes here does not depend on the agent.
 */
export const noopRunner: RunnerDefinition<NoopRunnerParams> = {
  type: "noop",
  params: noopRunnerParamsSchema,
  mocks: true,
  create() {
    return new NoopRunner();
  },
};

class NoopRunner implements Runner {
  readonly run = async (_context: RunnerContext): Promise<RunnerOutcome> => ({ finalText: null, diagnostics: [] });

  readonly stop = async (): Promise<void> => {};

  readonly trace = (): readonly [] => [];
}
