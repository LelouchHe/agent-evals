/**
 * The package's public surface: the contracts a runner or checker implements and the evidence
 * types they exchange with the engine. Everything not exported here is internal.
 */
export type {
  Checker,
  CheckerContext,
  CheckerDefinition,
  CheckResult,
  CheckSandbox,
  CheckSandboxOutcome,
  CheckStatus,
  ImplementationContext,
  MockRecord,
  MockWiring,
  Runner,
  RunnerContext,
  RunnerDefinition,
  RunnerOutcome,
  RunnerTokens,
  RunnerUsage,
  TraceEntry,
} from "./engine/registry.ts";
export type { ValueSource } from "./engine/values.ts";
export type { RunRoot } from "./engine/workspace.ts";
