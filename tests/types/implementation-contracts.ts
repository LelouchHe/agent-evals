/**
 * Compile-time contract fixtures. This file is included by `tsc --noEmit` but
 * is not a runtime test file. Each @ts-expect-error must fail for the intended
 * typing mechanism; weakening the contracts makes TypeScript report the
 * directive as unused.
 */
import { z } from "zod";
import type { ImplementationParams } from "../../src/engine/config.ts";
import type {
  CheckerContext,
  CheckerDefinition,
  PreparedChecker,
  PreparedRunner,
  Runner,
  RunnerContext,
  RunnerDefinition,
  Checker,
} from "../../src/engine/registry.ts";

const exampleParamsSchema = z.strictObject({
  value: z.string(),
  compiled: z.number(),
});
type ExampleParams = z.output<typeof exampleParamsSchema>;

const runnerContext: RunnerContext = {
  workspaceDir: "/run/workspace",
  homeDir: "/run/home",
  configDir: "/run/config",
  scratchDir: "/run/scratch",
  runRootDir: "/run",
  input: "task",
  authoringDir: "/authoring",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};

const checkerContext: CheckerContext = {
  workspace: {} as CheckerContext["workspace"],
  baseline: {} as CheckerContext["baseline"],
  runRootDir: "/run",
  authoringDir: "/authoring",
  input: "task",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};

const exampleRunner: RunnerDefinition<ExampleParams> = {
  type: "example",
  params: exampleParamsSchema,
  create: () => ({
    run: async (params) => ({ finalText: params.value, diagnostics: [] }),
    stop: async () => {},
  }),
};

const exampleChecker: CheckerDefinition<ExampleParams> = {
  type: "example",
  params: exampleParamsSchema,
  create: () => ({
    check: async (params) => [
      { checker: "example", subject: params.value, status: "pass", reason: String(params.compiled) },
    ],
  }),
};

const runner = await exampleRunner.create({ value: "typed", compiled: 1 }, "/authoring");
const checker = await exampleChecker.create({ value: "typed", compiled: 1 }, "/authoring");

void runner.run({ value: "typed", compiled: 1 }, runnerContext);
void checker.check({ value: "typed", compiled: 1 }, checkerContext);

// @ts-expect-error raw implementation params are not the parsed P
void runner.run({ value: "raw", compiled: 1 } as ImplementationParams, runnerContext);
// @ts-expect-error missing parsed field
void runner.run({ value: "typed" }, runnerContext);
// @ts-expect-error wrong parsed field type
void runner.run({ value: 1, compiled: 1 }, runnerContext);
// @ts-expect-error raw implementation params are not the parsed P
void checker.check({ value: "raw", compiled: 1 } as ImplementationParams, checkerContext);
// @ts-expect-error missing parsed field
void checker.check({ value: "typed" }, checkerContext);

const _defaultedSchema = z.strictObject({
  value: z.string(),
  count: z.number().default(1),
  flags: z.array(z.string()).default([]),
});
type Defaulted = z.output<typeof _defaultedSchema>;
const defaulted: Defaulted = { value: "typed", count: 1, flags: [] };
// @ts-expect-error defaulted fields are present in the schema output
const missingDefaults: Defaulted = { value: "typed" };
void defaulted;
void missingDefaults;

const mismatchedRunner: RunnerDefinition<ExampleParams> = {
  type: "mismatched",
  params: exampleParamsSchema,
  create: () => ({
    // @ts-expect-error schema output and created runner must share P
    run: async (params: number) => ({ finalText: String(params), diagnostics: [] }),
    stop: async () => {},
  }),
};

const mismatchedChecker: CheckerDefinition<ExampleParams> = {
  type: "mismatched",
  params: exampleParamsSchema,
  create: () => ({
    // @ts-expect-error schema output and created checker must share P
    check: async (_params: number) => [],
  }),
};

const mismatchedSchema: RunnerDefinition<ExampleParams> = {
  type: "mismatched-schema",
  // @ts-expect-error schema output must match the instance parameter type
  params: z.strictObject({ value: z.string() }),
  create: () => runner,
};

// @ts-expect-error typed definitions cannot be widened to an unknown-parameter definition
const widenedRunner: RunnerDefinition<unknown> = exampleRunner;
// @ts-expect-error typed definitions cannot be widened to an unknown-parameter definition
const widenedChecker: CheckerDefinition<unknown> = exampleChecker;
// @ts-expect-error runner instances stay parameter-contravariant
const widenedRunnerInstance: Runner<unknown> = runner;
// @ts-expect-error checker instances stay parameter-contravariant
const widenedCheckerInstance: Checker<unknown> = checker;

const preparedRunner = null as unknown as PreparedRunner;
const preparedChecker = null as unknown as PreparedChecker;
void preparedRunner.run(runnerContext);
void preparedChecker.check(checkerContext);
// @ts-expect-error prepared execution already has parsed params bound
void preparedRunner.run({ value: "typed", compiled: 1 }, runnerContext);
// @ts-expect-error prepared execution already has parsed params bound
void preparedChecker.check({ value: "typed", compiled: 1 }, checkerContext);

void mismatchedRunner;
void mismatchedChecker;
void mismatchedSchema;
void widenedRunner;
void widenedChecker;
void widenedRunnerInstance;
void widenedCheckerInstance;
