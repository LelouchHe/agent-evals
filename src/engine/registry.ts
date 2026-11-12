import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ZodType } from "zod";
import { ConfigError, errorMessage, type ImplementationParams } from "./config.ts";
import { parseImplementationParams } from "./params.ts";
import type { RunRoot } from "./workspace.ts";

export interface RunnerContext {
  readonly workspaceDir: string;
  readonly homeDir: string;
  readonly configDir: string;
  readonly scratchDir: string;
  readonly runRootDir: string;
  /** The case's initial user message. An engine-owned value, not a runner parameter. */
  readonly input: string;
  /** Directory of the case configuration that declared the runner. */
  readonly authoringDir: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface RunnerOutcome {
  readonly finalText: string | null;
  /** Small, bounded diagnostics such as a stderr tail or protocol warnings. */
  readonly diagnostics: readonly string[];
}

/**
 * Implementation instance bound to its parsed parameter type.
 * Function properties keep P contravariant, so parse/create pairs cannot be
 * mismatched to satisfy a wider parameter type.
 */
export interface Runner<P> {
  readonly run: (params: P, context: RunnerContext) => Promise<RunnerOutcome>;
  /** Stop the harness and its owned processes. Must be idempotent. */
  readonly stop: () => Promise<void>;
}

export interface RunnerDefinition<P> {
  readonly type: string;
  /** Declarative Zod parameter schema; the engine validates raw data once. */
  readonly params: ZodType<P>;
  /** Validate operational readiness for parsed params, then create the instance. */
  readonly create: (params: P, authoringDir: string) => Runner<P> | Promise<Runner<P>>;
}

/** A runner with its parsed parameters already bound to its instance. */
export interface PreparedRunner {
  readonly type: string;
  readonly run: (context: RunnerContext) => Promise<RunnerOutcome>;
  readonly stop: () => Promise<void>;
}

/** Erased definition stored by the registry; prepare() preserves the P association. */
export interface RegisteredRunnerDefinition {
  readonly type: string;
  readonly prepare: (params: ImplementationParams, authoringDir: string) => Promise<PreparedRunner>;
}

export interface CheckerContext {
  /** Prepared workspace root; its identity is verified for every operation. */
  readonly workspace: RunRoot;
  /** Initial workspace snapshot, outside the evaluated agent's writable area. */
  readonly baseline: RunRoot;
  readonly runRootDir: string;
  /** Directory of the case configuration that declared the checker. */
  readonly authoringDir: string;
  readonly input: string;
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

/** Implementation instance bound to its parsed parameter type. */
export interface Checker<P> {
  readonly check: (params: P, context: CheckerContext) => Promise<readonly CheckResult[]>;
}

export interface CheckerDefinition<P> {
  readonly type: string;
  /** Declarative Zod parameter schema; the engine validates raw data once. */
  readonly params: ZodType<P>;
  /** Validate operational readiness for parsed params, then create the instance. */
  readonly create: (params: P, authoringDir: string) => Checker<P> | Promise<Checker<P>>;
}

/** A checker with its parsed parameters already bound to its instance. */
export interface PreparedChecker {
  readonly type: string;
  readonly check: (context: CheckerContext) => Promise<readonly CheckResult[]>;
}

export interface RegisteredCheckerDefinition {
  readonly type: string;
  readonly prepare: (params: ImplementationParams, authoringDir: string) => Promise<PreparedChecker>;
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
  registerRunner(registry, registerRunnerDefinition(definition), source);
}

export function addChecker<P>(registry: Registry, definition: CheckerDefinition<P>, source: string): void {
  assertDefinition(definition, "checker");
  registerChecker(registry, registerCheckerDefinition(definition), source);
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
      registerRunner(registry, adaptExternalRunner(definition), file);
    } else {
      registerChecker(registry, adaptExternalChecker(definition), file);
    }
  }
}

function registerRunnerDefinition<P>(definition: RunnerDefinition<P>): RegisteredRunnerDefinition {
  return {
    type: definition.type,
    async prepare(params, authoringDir) {
      const parsed = await parseImplementationParams(definition.params, params, `runner "${definition.type}"`);
      const instance = await definition.create(parsed, authoringDir);
      return {
        type: definition.type,
        run: (context) => instance.run(parsed, context),
        stop: () => instance.stop(),
      };
    },
  };
}

function registerCheckerDefinition<P>(definition: CheckerDefinition<P>): RegisteredCheckerDefinition {
  return {
    type: definition.type,
    async prepare(params, authoringDir) {
      const parsed = await parseImplementationParams(definition.params, params, `checker "${definition.type}"`);
      const instance = await definition.create(parsed, authoringDir);
      return {
        type: definition.type,
        check: (context) => instance.check(parsed, context),
      };
    },
  };
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

/**
 * Dynamic modules are untyped at import time. Runtime shape validation above
 * establishes the fields; this is the single localized erasure boundary for
 * each external implementation kind.
 */
interface ExternalDefinition {
  readonly type: string;
  readonly params: ZodType<unknown>;
  readonly create: (params: unknown, authoringDir: string) => unknown | Promise<unknown>;
}

function adaptExternalRunner(definition: Record<string, unknown>): RegisteredRunnerDefinition {
  const external = definition as unknown as ExternalDefinition;
  return {
    type: external.type,
    async prepare(params, authoringDir) {
      // Method calls intentionally preserve the exported definition as receiver.
      const parsed = await parseImplementationParams(external.params, params, `runner "${external.type}"`);
      const instance = (await external.create(parsed, authoringDir)) as {
        readonly run: (params: unknown, context: RunnerContext) => Promise<RunnerOutcome>;
        readonly stop: () => Promise<void>;
      };
      return {
        type: external.type,
        run: (context) => instance.run(parsed, context),
        stop: () => instance.stop(),
      };
    },
  };
}

function adaptExternalChecker(definition: Record<string, unknown>): RegisteredCheckerDefinition {
  const external = definition as unknown as ExternalDefinition;
  return {
    type: external.type,
    async prepare(params, authoringDir) {
      // Method calls intentionally preserve the exported definition as receiver.
      const parsed = await parseImplementationParams(external.params, params, `checker "${external.type}"`);
      const instance = (await external.create(parsed, authoringDir)) as {
        readonly check: (params: unknown, context: CheckerContext) => Promise<readonly CheckResult[]>;
      };
      return {
        type: external.type,
        check: (context) => instance.check(parsed, context),
      };
    },
  };
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
