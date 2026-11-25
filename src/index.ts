/**
 * The package's public surface: the contracts a runner or checker implements, the evidence types
 * they exchange with the engine, the trace derivations a checker can reuse, and the evidence
 * access a built-in checker uses. Everything not exported here is internal; a built-in that
 * needs something absent from this file is a missing capability, not a private exception.
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
export { ConfigError, type PatternSyntax } from "./engine/config.ts";
export { patternListSchema, patternSyntaxSchema, runRelativePathSchema } from "./engine/params.ts";
export { compilePattern, searches } from "./engine/regex.ts";
export {
  MAX_CHECK_BYTES,
  WorkspacePathError,
  isMissing,
  readRunFile,
  readRunTree,
  runPathExists,
  type RunEntryKind,
  type RunRoot,
  type RunTree,
  type RunTreeEntry,
} from "./engine/workspace.ts";
export { messageText } from "./engine/messages.ts";
export { skillConsultations, type SkillConsultation, type SkillSources } from "./engine/skills.ts";
