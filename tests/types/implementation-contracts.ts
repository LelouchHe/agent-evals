/**
 * Compile-time contract fixtures. This file is included by `tsc --noEmit` but
 * is not a runtime test file. Each @ts-expect-error must fail for the intended
 * typing mechanism; weakening the contracts makes TypeScript report the
 * directive as unused.
 */
import type { ImplementationParams } from "../../src/engine/config.ts";
import type {
  CheckerContext,
  CheckerDefinition,
  PreparedChecker,
  PreparedRunner,
  RunnerContext,
  RunnerDefinition,
} from "../../src/engine/registry.ts";

interface ExampleParams {
  readonly value: string;
  readonly compiled: number;
}

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
  parse: (params) => ({
    value: String(params.value),
    compiled: 1,
  }),
  create: () => ({
    run: async (params) => ({ finalText: params.value, diagnostics: [] }),
    stop: async () => {},
  }),
};

const exampleChecker: CheckerDefinition<ExampleParams> = {
  type: "example",
  parse: (params) => ({
    value: String(params.value),
    compiled: 1,
  }),
  create: () => ({
    check: async (params) => [
      { checker: "example", subject: params.value, status: "pass", reason: String(params.compiled) },
    ],
  }),
};

const runner = exampleRunner.create();
const checker = exampleChecker.create();

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

const mismatchedRunner: RunnerDefinition<ExampleParams> = {
  type: "mismatched",
  parse: () => ({ value: "typed", compiled: 1 }),
  create: () => ({
    // @ts-expect-error parse output and created runner must share P
    run: async (params: number) => ({ finalText: String(params), diagnostics: [] }),
    stop: async () => {},
  }),
};

const mismatchedChecker: CheckerDefinition<ExampleParams> = {
  type: "mismatched",
  parse: () => ({ value: "typed", compiled: 1 }),
  create: () => ({
    // @ts-expect-error parse output and created checker must share P
    check: async (_params: number) => [],
  }),
};

// @ts-expect-error typed definitions cannot be widened to an unknown-parameter definition
const widenedRunner: RunnerDefinition<unknown> = exampleRunner;
// @ts-expect-error typed definitions cannot be widened to an unknown-parameter definition
const widenedChecker: CheckerDefinition<unknown> = exampleChecker;

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
void widenedRunner;
void widenedChecker;
