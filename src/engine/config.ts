import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

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

export interface CaseConfig {
  readonly input: string;
  readonly fixture?: string;
  readonly timeoutMs?: number;
  readonly checks: readonly ImplementationRecord[];
}

export interface CandidateConfig {
  readonly name?: string;
  readonly runner: ImplementationRecord;
}

export interface Loaded<T> {
  readonly path: string;
  readonly dir: string;
  readonly config: T;
}

const CASE_KEYS = new Set(["input", "fixture", "timeoutMs", "checks"]);
const CANDIDATE_KEYS = new Set(["name", "runner"]);

export async function loadCase(path: string): Promise<Loaded<CaseConfig>> {
  const file = resolve(path);
  const document = await readYaml(file, "case");
  const record = expectRecord(document, "case");
  rejectUnknownKeys(record, CASE_KEYS, "case");

  const input = expectNonEmptyString(record.input, "case.input");
  const fixture = record.fixture === undefined ? undefined : expectRelativePath(record.fixture, "case.fixture");
  const timeoutMs = record.timeoutMs === undefined ? undefined : expectTimeout(record.timeoutMs, "case.timeoutMs");
  if (!Array.isArray(record.checks) || record.checks.length === 0) {
    throw new ConfigError("case.checks must be a non-empty list");
  }
  const checks = record.checks.map((value, index) => expectImplementationRecord(value, `case.checks[${index}]`));

  return {
    path: file,
    dir: dirname(file),
    config: {
      input,
      ...(fixture === undefined ? {} : { fixture }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      checks,
    },
  };
}

export async function loadCandidate(path: string): Promise<Loaded<CandidateConfig>> {
  const file = resolve(path);
  const document = await readYaml(file, "candidate");
  const record = expectRecord(document, "candidate");
  rejectUnknownKeys(record, CANDIDATE_KEYS, "candidate");

  const name = record.name === undefined ? undefined : expectNonEmptyString(record.name, "candidate.name");
  const runner = expectImplementationRecord(record.runner, "candidate.runner");

  return { path: file, dir: dirname(file), config: { ...(name === undefined ? {} : { name }), runner } };
}

/** Resolve an authoring asset relative to the configuration file that declares it. */
export function resolveAuthoringAsset(declaringDir: string, relativePath: string, label: string): string {
  assertRelativePath(relativePath, label);
  return resolve(declaringDir, relativePath);
}

async function readYaml(file: string, kind: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new ConfigError(`could not read ${kind} configuration ${file}: ${errorMessage(error)}`);
  }
  try {
    return parse(text);
  } catch (error) {
    throw new ConfigError(`invalid YAML in ${kind} configuration ${file}: ${errorMessage(error)}`);
  }
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
  if (typeof type !== "string" || type.length === 0) {
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

function assertRelativePath(relativePath: string, label: string): void {
  if (relativePath.includes("\0")) {
    throw new ConfigError(`${label} contains a NUL byte`);
  }
  if (relativePath.startsWith("/") || relativePath.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new ConfigError(`${label} must be relative to its configuration file`);
  }
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
