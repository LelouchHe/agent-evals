import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ZodType } from "zod";
import { ConfigError, errorMessage } from "./config.ts";
import type { ValueSource } from "./values.ts";
import type { RunRoot } from "./workspace.ts";

export interface RunnerContext {
  readonly workspaceDir: string;
  readonly homeDir: string;
  readonly configDir: string;
  readonly scratchDir: string;
  readonly runRootDir: string;
  /** The case's initial user message. An engine-owned value, not a runner parameter. */
  readonly input: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Present when the case declares mocks and the runner wires them into its environment. */
  readonly mocks?: MockWiring;
}

/** What a runner needs to place the engine's mocked commands. */
export interface MockWiring {
  /** Directory of one forwarder per mocked `PATH` command; the runner puts it first on `PATH`. */
  readonly forwarderDir: string;
  /** Unix socket the forwarders use to reach the engine's host service. */
  readonly socketPath: string;
  /** `PATH` targets no rule can pass to the real command; their binaries stay denied. */
  readonly denyTargets: readonly string[];
}

export interface RunnerOutcome {
  readonly finalText: string | null;
  /** Small, bounded diagnostics such as a stderr tail or protocol warnings. */
  readonly diagnostics: readonly string[];
}

/**
 * One step of a run in order of first appearance: joined message or reasoning text, or one tool
 * call in its final state with the harness's own fields.
 */
export type TraceEntry =
  | { readonly type: "message" | "thought"; readonly text: string }
  | { readonly type: "tool"; readonly toolCallId: string; readonly [field: string]: unknown };

/** One call that reached a mocked collaborator: what was asked for and with which arguments. */
export interface MockRecord {
  readonly target: string;
  readonly arguments: readonly string[];
}

/** A prepared runner instance; its factory already captured validated parameters. */
export interface Runner {
  readonly run: (context: RunnerContext) => Promise<RunnerOutcome>;
  /** Stop the harness and its owned processes. Must be idempotent. */
  readonly stop: () => Promise<void>;
  /** What the run recorded so far, also after a failed run; absent when the runner records no trace. */
  readonly trace?: () => readonly TraceEntry[];
}

export interface ImplementationContext {
  readonly authoringDir: string;
  /** The run's placeholder sources, for parameters an implementation loads itself. */
  readonly values: ValueSource;
}

export interface RunnerDefinition<P> {
  readonly type: string;
  /** Declarative Zod parameter schema; the engine validates raw data once. */
  readonly params: ZodType<P>;
  /** True when the runner wires the mocks it receives into `PATH` and its sandbox. */
  readonly mocks?: true;
  /** Validate operational readiness for parsed params, then create the instance. */
  readonly create: (params: P, context: ImplementationContext) => Runner | Promise<Runner>;
}

/** Type-erased definition as stored by the registry. */
export interface RegisteredRunnerDefinition {
  readonly type: string;
  readonly params: ZodType<unknown>;
  readonly create: (params: unknown, context: ImplementationContext) => Runner | Promise<Runner>;
  /** Declared by the definition when the runner wires mocks. */
  readonly mocks?: boolean;
}

export interface CheckerContext {
  /** Prepared workspace root; its identity is verified for every operation. */
  readonly workspace: RunRoot;
  /** Initial workspace snapshot, outside the evaluated agent's writable area. */
  readonly baseline: RunRoot;
  readonly runRootDir: string;
  readonly input: string;
  /** The runner's trace, when it records one. */
  readonly trace?: readonly TraceEntry[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export type CheckStatus = "pass" | "fail" | "error";

export interface CheckResult {
  readonly checker: string;
  readonly subject: string;
  readonly status: CheckStatus;
  readonly reason: string;
}

/** A prepared checker instance; its factory already captured validated parameters. */
export interface Checker {
  readonly check: (context: CheckerContext) => Promise<readonly CheckResult[]>;
}

export interface CheckerDefinition<P> {
  readonly type: string;
  /** Declarative Zod parameter schema; the engine validates raw data once. */
  readonly params: ZodType<P>;
  /** Validate operational readiness for parsed params, then create the instance. */
  readonly create: (params: P, context: ImplementationContext) => Checker | Promise<Checker>;
}

/** Type-erased definition as stored by the registry. */
export interface RegisteredCheckerDefinition {
  readonly type: string;
  readonly params: ZodType<unknown>;
  readonly create: (params: unknown, context: ImplementationContext) => Checker | Promise<Checker>;
}

export interface Registry {
  readonly runners: Map<string, RegisteredRunnerDefinition>;
  readonly checkers: Map<string, RegisteredCheckerDefinition>;
}

export function createRegistry(): Registry {
  return { runners: new Map(), checkers: new Map() };
}

export function addRunner<P>(registry: Registry, definition: RunnerDefinition<P>, source: string): void {
  assertDefinition(definition, "runner");
  registerRunner(registry, definition as unknown as RegisteredRunnerDefinition, source);
}

export function addChecker<P>(registry: Registry, definition: CheckerDefinition<P>, source: string): void {
  assertDefinition(definition, "checker");
  registerChecker(registry, definition as unknown as RegisteredCheckerDefinition, source);
}

export function requireRunner(registry: Registry, type: string): RegisteredRunnerDefinition {
  const definition = registry.runners.get(type);
  if (definition === undefined) {
    throw new ConfigError(`unknown runner implementation "${type}" (available: ${list(registry.runners.keys())})`);
  }
  return definition;
}

export function requireChecker(registry: Registry, type: string): RegisteredCheckerDefinition {
  const definition = registry.checkers.get(type);
  if (definition === undefined) {
    throw new ConfigError(`unknown checker implementation "${type}" (available: ${list(registry.checkers.keys())})`);
  }
  return definition;
}

/** Load implementation modules from explicitly trusted directories. */
export async function loadTrustedImplementations(
  registry: Registry,
  options: { runnerDirs?: readonly string[]; checkerDirs?: readonly string[] },
): Promise<void> {
  for (const directory of options.runnerDirs ?? []) {
    await loadDirectory(registry, directory, "runner");
  }
  for (const directory of options.checkerDirs ?? []) {
    await loadDirectory(registry, directory, "checker");
  }
}

async function loadDirectory(registry: Registry, directory: string, kind: "runner" | "checker"): Promise<void> {
  const root = resolve(directory);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new ConfigError(`trusted ${kind} directory ${root} is not readable: ${errorMessage(error)}`);
  }

  const names = entries
    .filter((entry) => entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    const file = join(root, name);
    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (error) {
      throw new ConfigError(`failed to load ${kind} implementation ${file}: ${errorMessage(error)}`);
    }
    const exported = module[kind];
    if (exported === undefined) {
      throw new ConfigError(`${file} must export a named "${kind}" implementation`);
    }
    const definition = assertDefinition(exported, kind);
    if (kind === "runner") {
      registerRunner(registry, definition as unknown as RegisteredRunnerDefinition, file);
    } else {
      registerChecker(registry, definition as unknown as RegisteredCheckerDefinition, file);
    }
  }
}

function registerRunner(registry: Registry, definition: RegisteredRunnerDefinition, source: string): void {
  if (registry.runners.has(definition.type)) {
    throw new ConfigError(`duplicate runner implementation type "${definition.type}" from ${source}`);
  }
  registry.runners.set(definition.type, definition);
}

function registerChecker(registry: Registry, definition: RegisteredCheckerDefinition, source: string): void {
  if (registry.checkers.has(definition.type)) {
    throw new ConfigError(`duplicate checker implementation type "${definition.type}" from ${source}`);
  }
  registry.checkers.set(definition.type, definition);
}

function assertDefinition(definition: unknown, kind: "runner" | "checker"): Record<string, unknown> {
  if (typeof definition !== "object" || definition === null) {
    throw new ConfigError(`${kind} implementation must be an object`);
  }
  const candidate = definition as Record<string, unknown>;
  if (typeof candidate.type !== "string" || candidate.type.length === 0) {
    throw new ConfigError(`${kind} implementation must declare a non-empty string type`);
  }
  const schema = candidate.params;
  if (
    (typeof schema !== "object" && typeof schema !== "function") ||
    schema === null ||
    typeof (schema as { readonly safeParseAsync?: unknown }).safeParseAsync !== "function" ||
    typeof candidate.create !== "function"
  ) {
    throw new ConfigError(`${kind} implementation "${candidate.type}" must provide a Zod params schema and create()`);
  }
  return candidate;
}

function list(keys: Iterable<string>): string {
  const values = [...keys].sort();
  return values.length === 0 ? "none" : values.join(", ");
}
