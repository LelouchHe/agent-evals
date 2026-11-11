import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError, errorMessage, type ImplementationParams } from "./config.ts";

export interface RunnerContext {
  readonly workspaceDir: string;
  readonly homeDir: string;
  readonly configDir: string;
  readonly scratchDir: string;
  readonly runRootDir: string;
  /** The case's initial user message. An engine-owned value, not a runner parameter. */
  readonly input: string;
  /** Directory of the candidate configuration that declared the runner. */
  readonly authoringDir: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface RunnerOutcome {
  readonly finalText: string | null;
  /** Small, bounded diagnostics such as a stderr tail or protocol warnings. */
  readonly diagnostics: readonly string[];
}

export interface Runner {
  run(params: ImplementationParams, context: RunnerContext): Promise<RunnerOutcome>;
  /** Stop the harness and its owned processes. Must be idempotent. */
  stop(): Promise<void>;
}

export interface RunnerDefinition {
  readonly type: string;
  validate(params: ImplementationParams, authoringDir: string): void | Promise<void>;
  create(): Runner;
}

export interface CheckerContext {
  readonly workspaceDir: string;
  /** Initial workspace snapshot, outside the evaluated agent's writable area. */
  readonly baselineDir: string;
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

export interface Checker {
  check(params: ImplementationParams, context: CheckerContext): Promise<readonly CheckResult[]>;
}

export interface CheckerDefinition {
  readonly type: string;
  validate(params: ImplementationParams, authoringDir: string): void | Promise<void>;
  create(): Checker;
}

export interface Registry {
  readonly runners: Map<string, RunnerDefinition>;
  readonly checkers: Map<string, CheckerDefinition>;
}

export function createRegistry(): Registry {
  return { runners: new Map(), checkers: new Map() };
}

export function addRunner(registry: Registry, definition: RunnerDefinition, source: string): void {
  assertDefinition(definition, "runner");
  if (registry.runners.has(definition.type)) {
    throw new ConfigError(`duplicate runner implementation type "${definition.type}" from ${source}`);
  }
  registry.runners.set(definition.type, definition);
}

export function addChecker(registry: Registry, definition: CheckerDefinition, source: string): void {
  assertDefinition(definition, "checker");
  if (registry.checkers.has(definition.type)) {
    throw new ConfigError(`duplicate checker implementation type "${definition.type}" from ${source}`);
  }
  registry.checkers.set(definition.type, definition);
}

export function requireRunner(registry: Registry, type: string): RunnerDefinition {
  const definition = registry.runners.get(type);
  if (definition === undefined) {
    throw new ConfigError(`unknown runner implementation "${type}" (available: ${list(registry.runners.keys())})`);
  }
  return definition;
}

export function requireChecker(registry: Registry, type: string): CheckerDefinition {
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
    if (kind === "runner") {
      addRunner(registry, exported as RunnerDefinition, file);
    } else {
      addChecker(registry, exported as CheckerDefinition, file);
    }
  }
}

function assertDefinition(definition: unknown, kind: "runner" | "checker"): void {
  if (typeof definition !== "object" || definition === null) {
    throw new ConfigError(`${kind} implementation must be an object`);
  }
  const candidate = definition as Record<string, unknown>;
  if (typeof candidate.type !== "string" || candidate.type.length === 0) {
    throw new ConfigError(`${kind} implementation must declare a non-empty string type`);
  }
  if (typeof candidate.validate !== "function" || typeof candidate.create !== "function") {
    throw new ConfigError(`${kind} implementation "${candidate.type}" must provide validate() and create()`);
  }
}

function list(keys: Iterable<string>): string {
  const values = [...keys].sort();
  return values.length === 0 ? "none" : values.join(", ");
}
