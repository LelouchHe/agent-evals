/**
 * Compile-time contract fixtures. This file is included by `tsc --noEmit` but
 * is not a runtime test file. Each @ts-expect-error must fail for the intended
 * typing mechanism; weakening the contracts makes TypeScript report the
 * directive as unused.
 */
import { z } from "zod";
import type {
  CheckerContext,
  CheckerDefinition,
  ImplementationContext,
  RunnerContext,
  RunnerDefinition,
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
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};

const checkerContext: CheckerContext = {
  workspace: {} as CheckerContext["workspace"],
  baseline: {} as CheckerContext["baseline"],
  runRootDir: "/run",
  input: "task",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
  checkSandbox: { run: async () => ({ kind: "exited", exitCode: 0, output: "" }) },
};

const implementationContext: ImplementationContext = {
  authoringDir: "/authoring",
  values: { env: { require: async (name) => name }, run: { HOME: "/run/home", TMPDIR: "/run/tmp" } },
};

const exampleRunner: RunnerDefinition<ExampleParams> = {
  type: "example",
  params: exampleParamsSchema,
  create: (params) => ({
    run: async () => ({ finalText: params.value, diagnostics: [] }),
    stop: async () => {},
  }),
};

const exampleChecker: CheckerDefinition<ExampleParams> = {
  type: "example",
  params: exampleParamsSchema,
  create: (params) => ({
    check: async () => [{ checker: "example", subject: params.value, status: "pass", reason: String(params.compiled) }],
  }),
};

const runner = await exampleRunner.create({ value: "typed", compiled: 1 }, implementationContext);
const checker = await exampleChecker.create({ value: "typed", compiled: 1 }, implementationContext);

void runner.run(runnerContext);
void checker.check(checkerContext);

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

const mismatchedSchema: RunnerDefinition<ExampleParams> = {
  type: "mismatched-schema",
  // @ts-expect-error schema output must match the instance parameter type
  params: z.strictObject({ value: z.string() }),
  create: () => runner,
};

// @ts-expect-error factory parameters are inferred from the schema output
void exampleRunner.create({ value: "typed" }, implementationContext);

void mismatchedSchema;
