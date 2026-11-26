import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ZodType } from "zod";
import { ConfigError, errorMessage } from "./config.ts";
import type { ImplementationRecord } from "./config.ts";
import type { ValueSource } from "./values.ts";
import type { RunRoot } from "./workspace.ts";

export interface RunnerContext {
  readonly workspaceDir: string;
  readonly homeDir: string;
  /** Temporary directory named by `TMPDIR`. */
  readonly tmpDir: string;
  /** Engine-private state; unreadable to the agent. */
  readonly engineDir: string;
  /** A runner-owned writable configuration directory; the native Pi runner's own layout. */
  readonly configDir: string;
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

/** One end-of-run measurement as the harness reported it. Every part is optional and unestimated. */
export interface RunnerUsage {
  /** The last reported context size: tokens in the context and the context window. */
  readonly context?: { readonly used: number; readonly size: number };
  /** The last reported cumulative session cost. */
  readonly cost?: { readonly amount: number; readonly currency: string };
  /** Totals the harness sent with the completed turn. */
  readonly tokens?: RunnerTokens;
}

/** Tokens a completed turn consumed, as the harness's unstable usage field reports them. */
export interface RunnerTokens {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thoughtTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
}

/** What a check-time program did in the engine's fixed check sandbox. */
export type CheckSandboxOutcome =
  | { readonly kind: "exited"; readonly exitCode: number; readonly output: string }
  | { readonly kind: "signalled"; readonly signal: string; readonly output: string }
  | { readonly kind: "failed"; readonly reason: string; readonly output: string };

/**
 * Run one program at check time. The engine supplies the fixed sandbox: open reads, writes only
 * beneath the workspace and a private HOME and temporary directory, and no network.
 */
export interface CheckSandbox {
  /**
   * Start `command` in the workspace root; program and arguments are never given to a shell.
   * `files` maps workspace destinations to authoring sources; the engine validates and stages
   * them inside the sandbox, copying them into the workspace immediately before the program.
   */
  readonly run: (
    command: readonly string[],
    options?: { readonly files?: Readonly<Record<string, string>> },
  ) => Promise<CheckSandboxOutcome>;
}

/** A prepared runner instance; its factory already captured validated parameters. */
export interface Runner {
  /**
   * Place runner-owned HOME content (agent files, login state) before the case's `~/` entries.
   * Returns the HOME-relative login files the case may not touch. Absent for a runner without
   * a HOME.
   */
  readonly prepareHome?: (context: RunnerContext) => Promise<readonly string[]>;
  /** HOME-relative login files a case may never place over; independent of `prepareHome`. */
  readonly homeFiles?: readonly string[];
  /** Shared mutable host resource key (e.g., persistent login dir); runs with the same key serialize. */
  readonly concurrencyKey?: string;
  readonly run: (context: RunnerContext) => Promise<RunnerOutcome>;
  /** Stop the harness and its owned processes. Must be idempotent. */
  readonly stop: () => Promise<void>;
  /** What the run recorded so far, also after a failed run; absent when the runner records no trace. */
  readonly trace?: () => readonly TraceEntry[];
  /** What the harness reported it consumed, also after a failed run; absent when it reports nothing. */
  readonly usage?: () => RunnerUsage | undefined;
}

/** A runner instance created from a declaration, named by the type that produced it. */
export interface PreparedRunner {
  readonly type: string;
  readonly runner: Runner;
}

export interface ImplementationContext {
  readonly authoringDir: string;
  /** The run's placeholder sources, for parameters an implementation loads itself. */
  readonly values: ValueSource;
  /** Validate and stage a checker's check-time `files` at load time, relative to `authoringDir`. */
  readonly validateFiles: (files: Readonly<Record<string, string>>) => Promise<void>;
  /** The case's declared `mocks.shell` targets, for a checker that must name one at load time. */
  readonly mockTargets?: readonly string[];
  /** True when the selected runner gives the run a HOME a case may place files in. */
  readonly runnerSupportsHome: boolean;
  /** Fail at load time when the engine's check sandbox cannot run on this host. */
  readonly validateCheckPlatform: () => Promise<void>;
  /**
   * Create a runner instance from a declaration, or from the case's own runner when none is
   * named. The declaration is validated by that runner's schema with this same context, so a
   * checker that must run a prompt (the `judge`) asks the engine instead of holding a private
   * invocation path.
   */
  readonly createRunner: (record?: ImplementationRecord) => Promise<PreparedRunner>;
}

export interface RunnerDefinition<P> {
  readonly type: string;
  /** Declarative Zod parameter schema; the engine validates raw data once. */
  readonly params: ZodType<P>;
  /** True when the runner wires the mocks it receives into `PATH` and its sandbox. */
  readonly mocks?: true;
  /** True when the runner gives the run a HOME that a case may place `~/` files in. */
  readonly home?: true;
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
  /** Declared by the definition when the runner gives the run a HOME. */
  readonly home?: boolean;
}

/** HOME-relative paths and file identities belonging to runner login state, never exposed to checks. */
export interface HomeProtection {
  readonly paths: readonly string[];
  readonly identities: readonly string[];
}

export interface CheckerContext {
  /** Prepared workspace root; its identity is verified for every operation. */
  readonly workspace: RunRoot;
  /** Initial workspace snapshot, outside the evaluated agent's writable area. */
  readonly baseline: RunRoot;
  /** The run HOME; only checks whose runner declares `home` receive meaningful content. */
  readonly home: RunRoot;
  /** What the case placed in HOME, outside the evaluated agent's writable area. */
  readonly homeBaseline: RunRoot;
  /** Runner login files in HOME that checks must not expose. */
  readonly protectedHome?: HomeProtection;
  readonly runRootDir: string;
  readonly input: string;
  /** The runner's trace, when it records one. */
  readonly trace?: readonly TraceEntry[];
  /** The run's recorded mock calls, when the case declares mocks. */
  readonly mockRecords?: readonly MockRecord[];
  /** The engine's fixed sandbox for running a program at check time. */
  readonly checkSandbox: CheckSandbox;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export type CheckStatus = "pass" | "fail" | "error";

/** A checker's judgment. An implementation never says which declaration produced it. */
export interface CheckResult {
  readonly checker: string;
  readonly subject: string;
  readonly status: CheckStatus;
  readonly reason: string;
}

/**
 * A result as the engine records it: the checker's judgment plus the declared check that produced
 * it. The engine owns this stamp; a record written before it existed lacks the field.
 */
export interface RecordedCheckResult extends CheckResult {
  readonly declaration?: number;
}

/** A prepared checker instance; its factory already captured validated parameters. */
export interface Checker {
  /** Results, or a promise for them: a checker that answers directly is awaited like any other. */
  readonly check: (context: CheckerContext) => Promise<readonly CheckResult[]> | readonly CheckResult[];
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

const ENTRY_FILES = ["index.ts", "index.js", "index.mjs"] as const;

/** Load one implementation per subdirectory of each explicitly trusted extension root. */
export async function loadTrustedImplementations(
  registry: Registry,
  options: { extensionDirs?: readonly string[] },
): Promise<void> {
  for (const directory of options.extensionDirs ?? []) {
    await loadDirectory(registry, directory);
  }
}

async function loadDirectory(registry: Registry, directory: string): Promise<void> {
  const root = resolve(directory);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new ConfigError(`trusted extension directory ${root} is not readable: ${errorMessage(error)}`);
  }

  const names = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    const file = join(root, name, await entryFile(join(root, name)));
    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (error) {
      throw new ConfigError(`failed to load extension ${file}: ${errorMessage(error)}`);
    }
    const runner = module.runner;
    const checker = module.checker;
    if (runner === undefined && checker === undefined) {
      throw new ConfigError(`${file} must export a named "runner" or "checker" implementation`);
    }
    if (runner !== undefined) {
      registerRunner(registry, assertDefinition(runner, "runner") as unknown as RegisteredRunnerDefinition, file);
    }
    if (checker !== undefined) {
      registerChecker(registry, assertDefinition(checker, "checker") as unknown as RegisteredCheckerDefinition, file);
    }
  }
}

async function entryFile(directory: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new ConfigError(`extension ${directory} is not readable: ${errorMessage(error)}`);
  }
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const name = ENTRY_FILES.find((entry) => files.has(entry));
  if (name === undefined) {
    throw new ConfigError(`extension ${directory} has no index.ts, index.js, or index.mjs entry point`);
  }
  return name;
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
