import { resolve } from "node:path";

/** A configuration problem detected before any runtime resource is created. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Implementation-owned parameters. Only `$type` has engine-defined meaning. */
export type ImplementationParams = Readonly<Record<string, unknown>>;

export interface ImplementationRecord extends ImplementationParams {
  readonly $type: string;
}

/** One complete, executable case after composition. */
export interface CaseConfig {
  readonly input: string;
  readonly fixture?: string;
  /** Authoring asset placed at a workspace-relative destination path. */
  readonly files?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly checks: readonly ImplementationRecord[];
  readonly runner: ImplementationRecord;
}

/** Where one final top-level case field was declared. Nested values share this origin. */
export type FieldOrigin =
  | { readonly file: string; readonly line: number; readonly kind: "common" }
  | { readonly file: string; readonly line: number; readonly kind: "case"; readonly caseName: string };

/** One unquoted plain `$env:NAME` in an implementation parameter value. */
export interface EnvReference {
  /** Path relative to the loaded configuration root. */
  readonly path: readonly (string | number)[];
  readonly name: string;
}

/** Basic environment-variable name grammar used by `$env:NAME` references. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One source file resolved to a single case, or to common fields plus a selected case. */
export interface ResolvedCase {
  readonly path: string;
  readonly dir: string;
  /** The selected named case, or absent for an ordinary single-case document. */
  readonly name?: string;
  readonly config: CaseConfig;
  /** Unquoted plain `$env:NAME` values in runner/checker parameters. */
  readonly references: readonly EnvReference[];
  /** One annotation per final top-level field in `config`. */
  readonly origins: Readonly<Record<string, FieldOrigin>>;
}

/** Top-level fields allowed in a complete resolved case. */
export const CASE_FIELD_KEYS: ReadonlySet<string> = new Set([
  "input",
  "fixture",
  "files",
  "timeoutMs",
  "checks",
  "runner",
]);

/** The document-level authoring control for named cases. */
export const CASES_KEY = "cases";

/** Resolve an authoring asset relative to the file that declares it. */
export function resolveAuthoringAsset(declaringDir: string, relativePath: string, label: string): string {
  assertRelativePath(relativePath, label);
  return resolve(declaringDir, relativePath);
}

/** Validate a complete resolved case record and return its typed configuration. */
export function expectCaseConfig(value: unknown, label: string): CaseConfig {
  const record = expectRecord(value, label);
  rejectUnknownKeys(record, CASE_FIELD_KEYS, label);

  const input = expectNonEmptyString(record.input, `${label}.input`);
  const fixture = record.fixture === undefined ? undefined : expectRelativePath(record.fixture, `${label}.fixture`);
  const files = record.files === undefined ? undefined : expectFiles(record.files, label);
  const timeoutMs = record.timeoutMs === undefined ? undefined : expectTimeout(record.timeoutMs, `${label}.timeoutMs`);
  if (!Array.isArray(record.checks) || record.checks.length === 0) {
    throw new ConfigError(`${label}.checks must be a non-empty list`);
  }
  const checks = record.checks.map((check, index) => expectImplementationRecord(check, `${label}.checks[${index}]`));
  const runner = expectImplementationRecord(record.runner, `${label}.runner`);

  return {
    input,
    ...(fixture === undefined ? {} : { fixture }),
    ...(files === undefined ? {} : { files }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    checks,
    runner,
  };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${label} must be a YAML mapping`);
  }
  return value as Record<string, unknown>;
}

function expectImplementationRecord(value: unknown, label: string): ImplementationRecord {
  const record = expectRecord(value, label);
  const type = record.$type;
  if (typeof type !== "string" || type.trim().length === 0) {
    throw new ConfigError(`${label}.$type must be a non-empty string`);
  }
  return record as ImplementationRecord;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function expectRelativePath(value: unknown, label: string): string {
  const path = expectNonEmptyString(value, label);
  assertRelativePath(path, label);
  return path;
}

/**
 * Read the case's file placements. Keys are workspace-relative destinations,
 * so unlike authoring sources they may not leave the workspace.
 */
function expectFiles(value: unknown, label: string): Readonly<Record<string, string>> {
  const record = expectRecord(value, `${label}.files`);
  return Object.fromEntries(
    Object.entries(record).map(([destination, source]) => {
      expectWorkspaceDestination(destination, `${label}.files destination "${destination}"`);
      return [destination, expectRelativePath(source, `${label}.files["${destination}"]`)];
    }),
  );
}

function expectWorkspaceDestination(destination: string, label: string): void {
  expectNonEmptyString(destination, label);
  if (destination.includes("\0")) {
    throw new ConfigError(`${label} contains a NUL byte`);
  }
  if (isAbsoluteLike(destination)) {
    throw new ConfigError(`${label} must be relative to the workspace root`);
  }
  if (destination.split(/[\\/]+/).includes("..")) {
    throw new ConfigError(`${label} must not contain ".."`);
  }
}

function assertRelativePath(relativePath: string, label: string): void {
  if (relativePath.includes("\0")) {
    throw new ConfigError(`${label} contains a NUL byte`);
  }
  if (isAbsoluteLike(relativePath)) {
    throw new ConfigError(`${label} must be relative to its configuration file`);
  }
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

function expectTimeout(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer number of milliseconds`);
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
