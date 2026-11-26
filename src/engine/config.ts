import { resolve } from "node:path";
import { compilePattern } from "./regex.ts";

/** A configuration problem detected before any runtime resource is created. */
export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

/** Implementation-owned parameters. Only `$type` has engine-defined meaning. */
export type ImplementationParams = Readonly<Record<string, unknown>>;

export interface ImplementationRecord extends ImplementationParams {
  readonly $type: string;
}

/** What the case's checks are expected to do: pass, or fail as a vacancy or negative baseline. */
export type CaseExpectation = "pass" | "fail";

/** One complete, executable case after composition. */
export interface CaseConfig {
  readonly input: string;
  readonly fixture?: string;
  /** Authoring asset placed at a workspace-relative destination path. */
  readonly files?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly mocks?: MocksConfig;
  /** Absent means `pass`: a case is a test unless it declares itself a negative one. */
  readonly expect?: CaseExpectation;
  readonly checks: readonly ImplementationRecord[];
  readonly runner: ImplementationRecord;
}

/** A fixed result returned to a called command. */
export interface MockResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A literal text, or a RE2 pattern written as /…/; the caller decides what it is matched against. */
export interface PatternSyntax {
  /** The literal text, or the pattern source without its slashes. */
  readonly source: string;
  readonly regex: boolean;
}

/** A literal token, or a RE2 pattern written as /…/ and matched against the whole token. */
export type MockPattern = PatternSyntax;

/** One entry of a rule's option map: required, forbidden, or required with a value. */
export type MockArgument =
  | { readonly key: MockPattern; readonly kind: "required" }
  | { readonly key: MockPattern; readonly kind: "forbidden" }
  | { readonly key: MockPattern; readonly kind: "value"; readonly value: MockPattern };

/** A rule's optional argument condition: a positional prefix plus one unordered option map. */
export interface MockArgs {
  readonly positional: readonly MockPattern[];
  readonly options: readonly MockArgument[];
}

/** What a matching rule does with the call. */
export type MockAction =
  | { readonly kind: "return"; readonly result: MockResult }
  | { readonly kind: "run"; readonly command: readonly string[]; readonly pass: boolean }
  | { readonly kind: "pass" }
  | { readonly kind: "refuse" };

/** One ordered rule; a rule without `args` is the fallback. */
export interface MockRule {
  readonly args?: MockArgs;
  readonly action: MockAction;
}

/** One target's ordered rules; the first match wins. */
export type ShellMock = readonly MockRule[];

/** One ordered rule list per bare `PATH` command name or workspace-relative script path. */
export type ShellMocks = Readonly<Record<string, ShellMock>>;

export interface MocksConfig {
  readonly shell: ShellMocks;
}

/**
 * Structural YAML type of a top-level case field, which determines how common and case declarations compose:
 * - `"value"`: scalar or atomic object; a case replaces the common default as a whole.
 * - `"list"`: sequence; a case appends its items after the common items.
 * - `{ kind: "map", child }`: mapping; keys merge recursively using `child` (when `child` is `"value"`,
 *   a repeated key in the case replaces the common value).
 */
export type FieldType = "value" | "list" | { readonly kind: "map"; readonly child: FieldType };

/** Where a single declaration originated in a YAML document, plus the declaration it overrode if any. */
export type SourceOrigin =
  | { readonly file: string; readonly line: number; readonly kind: "common"; readonly overrides?: SourceOrigin }
  | {
      readonly file: string;
      readonly line: number;
      readonly kind: "case";
      readonly caseName: string;
      readonly overrides?: SourceOrigin;
    };

/** Origin annotation mirroring `FieldType`: a leaf origin, list items, or recursive map entries. */
export type FieldOrigin =
  | SourceOrigin
  | { readonly kind: "list"; readonly base: SourceOrigin; readonly items: readonly SourceOrigin[] }
  | { readonly kind: "map"; readonly base: SourceOrigin; readonly entries: Readonly<Record<string, FieldOrigin>> };

/** Basic environment-variable name grammar used by placeholders and declared variables. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One source file resolved to a single case, or to common fields plus a selected case. */
export interface ResolvedCase {
  readonly path: string;
  readonly dir: string;
  /** The selected named case, or absent for an ordinary single-case document. */
  readonly name?: string;
  readonly config: CaseConfig;
  /** One annotation per final top-level field in `config`. */
  readonly origins: Readonly<Record<string, FieldOrigin>>;
}

/**
 * Single source of truth for case fields and their structural types.
 * Naming convention: plural names (`files`, `checks`, `mocks`) are collections (`list` / `map`);
 * singular names (`input`, `runner`, `fixture`, `timeoutMs`, `expect`) are atomic `value`s.
 */
export const CASE_FIELDS: Readonly<Record<keyof CaseConfig, FieldType>> = {
  input: "value",
  fixture: "value",
  files: { kind: "map", child: "value" },
  timeoutMs: "value",
  mocks: { kind: "map", child: { kind: "map", child: "value" } },
  expect: "value",
  checks: "list",
  runner: "value",
};

/** Top-level fields allowed in a complete resolved case. */
export const CASE_FIELD_KEYS: ReadonlySet<string> = new Set(Object.keys(CASE_FIELDS));

/** The document-level authoring control for named cases. */
export const CASES_KEY = "cases";

const MOCK_KEYS: ReadonlySet<string> = new Set(["shell"]);
const MOCK_RULE_KEYS: ReadonlySet<string> = new Set(["args", "return", "run", "pass"]);
const MOCK_RESULT_KEYS: ReadonlySet<string> = new Set(["exitCode", "stdout", "stderr"]);

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
  const mocks = record.mocks === undefined ? undefined : expectMocks(record.mocks, `${label}.mocks`);
  const expect = record.expect === undefined ? undefined : expectExpectation(record.expect, `${label}.expect`);
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
    ...(mocks === undefined ? {} : { mocks }),
    ...(expect === undefined ? {} : { expect }),
    checks,
    runner,
  };
}

function expectExpectation(value: unknown, label: string): CaseExpectation {
  if (value === "pass" || value === "fail") {
    return value;
  }
  throw new ConfigError(`${label} must be "pass" or "fail"`);
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

export function expectRelativePath(value: unknown, label: string): string {
  const path = expectNonEmptyString(value, label);
  assertRelativePath(path, label);
  return path;
}

/**
 * Read the case's file placements. Keys are workspace-relative destinations, or `~/…`
 * destinations in the run HOME, so unlike authoring sources they may not leave their root.
 */
function expectFiles(value: unknown, label: string): Readonly<Record<string, string>> {
  const record = expectRecord(value, `${label}.files`);
  return Object.fromEntries(
    Object.entries(record).map(([destination, source]) => {
      expectPlacementDestination(destination, `${label}.files destination "${destination}"`);
      return [destination, expectRelativePath(source, `${label}.files["${destination}"]`)];
    }),
  );
}

/** A placement destination is workspace-relative, or starts with `~/` to name the run HOME. */
export function expectPlacementDestination(destination: string, label: string): void {
  expectNonEmptyString(destination, label);
  if (destination.includes("\0")) {
    throw new ConfigError(`${label} contains a NUL byte`);
  }
  if (destination.startsWith("~/")) {
    const homePath = destination.slice(2);
    // `~/` alone names the HOME root; anything after it follows the workspace rules.
    if (homePath.length === 0) {
      return;
    }
    expectWorkspaceDestination(homePath, label);
    return;
  }
  expectWorkspaceDestination(destination, label);
}

export function expectWorkspaceDestination(destination: string, label: string): void {
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

/**
 * Read the declared shell mocks: one target per bare command name or workspace-relative script
 * path, each with one rule or an ordered list. Every pattern compiles at load time, so an
 * unsupported RE2 construct or an unsupported shape is a configuration error rather than a
 * silent fallback to the real command.
 */
function expectMocks(value: unknown, label: string): MocksConfig {
  const record = expectRecord(value, label);
  rejectUnknownKeys(record, MOCK_KEYS, label);
  if (record.shell === undefined) {
    throw new ConfigError(`${label} must declare shell targets`);
  }
  const shell = expectRecord(record.shell, `${label}.shell`);
  const entries = Object.entries(shell).map(
    ([target, rules]) =>
      [expectMockTarget(target, `${label}.shell`), expectMockRules(rules, `${label}.shell["${target}"]`)] as const,
  );
  // `./scripts/x`, `scripts/.//x` and `scripts/x` name one workspace file, and a bare name and
  // `./name` name different things: a PATH command and a workspace-root script.
  const seen = new Map<string, string>();
  for (const [target] of entries) {
    const identity = mockTargetIdentity(target);
    const previous = seen.get(identity);
    if (previous !== undefined) {
      throw new ConfigError(`${label}.shell declares "${previous}" and "${target}" as the same target`);
    }
    seen.set(identity, target);
  }
  return { shell: Object.fromEntries(entries) };
}

/** The declared spelling two targets name the same thing by, for duplicates and checks. */
export function mockTargetIdentity(target: string): string {
  return target.includes("/") ? `workspace:${workspaceTargetPath(target)}` : `path:${target}`;
}

/** The workspace-relative file a target names, without `.` or empty segments. */
export function workspaceTargetPath(target: string): string {
  return target
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

/** A bare command name is placed on `PATH`; a path containing `/` is workspace-relative. */
export function expectMockTarget(target: string, label: string): string {
  if (target.trim().length === 0) {
    throw new ConfigError(`${label} has an empty target name`);
  }
  if (target.includes("\0")) {
    throw new ConfigError(`${label} target "${target}" contains a NUL byte`);
  }
  if (target.includes("/")) {
    expectWorkspaceDestination(target, `${label} target "${target}"`);
    if (target.endsWith("/") || target.split("/").at(-1) === "") {
      throw new ConfigError(`${label} target "${target}" must name a file, not a directory`);
    }
    return target;
  }
  if (target === "." || target === "..") {
    throw new ConfigError(`${label} target "${target}" is not a command name`);
  }
  return target;
}

function expectMockRules(value: unknown, label: string): readonly MockRule[] {
  const rules = Array.isArray(value) ? value : [value];
  if (rules.length === 0) {
    throw new ConfigError(`${label} must declare at least one rule`);
  }
  return rules.map((rule, index) => expectMockRule(rule, Array.isArray(value) ? `${label}[${index}]` : label));
}

function expectMockRule(value: unknown, label: string): MockRule {
  const rule = expectRecord(value, label);
  rejectUnknownKeys(rule, MOCK_RULE_KEYS, label);
  const args = rule.args === undefined ? undefined : expectMockArgs(rule.args, `${label}.args`);
  const action = expectMockAction(rule, label);
  return { ...(args === undefined ? {} : { args }), action };
}

function expectMockAction(rule: Record<string, unknown>, label: string): MockAction {
  const declared = ["return", "run", "pass"].filter((key) => rule[key] !== undefined);
  if (declared.length === 0) {
    throw new ConfigError(`${label} must declare one of return, run or pass`);
  }
  if (rule.return !== undefined) {
    if (declared.length > 1) {
      throw new ConfigError(
        `${label} cannot combine return with ${declared.filter((key) => key !== "return").join(" and ")}`,
      );
    }
    return { kind: "return", result: expectMockResult(rule.return, `${label}.return`) };
  }
  if (rule.run !== undefined) {
    const pass = rule.pass === undefined ? false : expectMockPass(rule.pass, `${label}.pass`);
    return { kind: "run", command: expectMockCommand(rule.run, `${label}.run`), pass };
  }
  return expectMockPass(rule.pass, `${label}.pass`) ? { kind: "pass" } : { kind: "refuse" };
}

/** `true` hands the call to the real command; `false` refuses it, or keeps `run` from passing. */
function expectMockPass(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${label} must be true or false`);
  }
  return value;
}

function expectMockCommand(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${label} must be a non-empty list of program and arguments`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigError(`${label}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

export function expectMockArgs(value: unknown, label: string): MockArgs {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { positional: [], options: expectMockOptions(value, label) };
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(`${label} must be a list or a map`);
  }
  const positional: MockPattern[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      if (index !== value.length - 1) {
        throw new ConfigError(`${label} may hold an option map only as its last element`);
      }
      return { positional, options: expectMockOptions(entry, label) };
    }
    positional.push(expectMockPattern(entry, `${label}[${index}]`));
  }
  return { positional, options: [] };
}

function expectMockOptions(value: object, label: string): readonly MockArgument[] {
  return Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if (key.length === 0) {
      throw new ConfigError(`${label} has an empty option name`);
    }
    const pattern = expectMockPattern(key, `${label} option "${key}"`, true);
    if (entry === true) return { key: pattern, kind: "required" };
    if (entry === false) return { key: pattern, kind: "forbidden" };
    if (typeof entry === "boolean") {
      throw new ConfigError(`${label} option "${key}" must be true, false or a value`);
    }
    return { key: pattern, kind: "value", value: expectMockPattern(entry, `${label}["${key}"]`) };
  });
}

/**
 * Read one pattern scalar, shared by mock rules and file checks. A finite number is compared as
 * its text; a non-empty string that starts and ends with `/` is a RE2 pattern with the outer
 * slashes removed; any other string is a literal. Callers own the labels, the wording of each
 * error, and whether an empty `/…/` source is allowed.
 */
export function parsePatternScalar(value: unknown): PatternScalarResult {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { kind: "pattern", pattern: { source: String(value), regex: false } };
  }
  if (typeof value === "string" && value.length === 0) {
    return { kind: "invalid", reason: "empty" };
  }
  if (typeof value !== "string") {
    return { kind: "invalid", reason: "unsupported" };
  }
  if (value.length < 2 || !value.startsWith("/") || !value.endsWith("/")) {
    return { kind: "pattern", pattern: { source: value, regex: false } };
  }
  const source = value.slice(1, -1);
  try {
    compilePattern(source);
  } catch (error) {
    return { kind: "invalid", reason: "regex", message: errorMessage(error) };
  }
  return { kind: "pattern", pattern: { source, regex: true } };
}

/** A parsed pattern scalar, or why the value is not one. */
export type PatternScalarResult =
  | { readonly kind: "pattern"; readonly pattern: PatternSyntax }
  | { readonly kind: "invalid"; readonly reason: "empty" | "unsupported" }
  | { readonly kind: "invalid"; readonly reason: "regex"; readonly message: string };

/**
 * Read one literal or /…/ pattern. A YAML number is compared as its text; an unquoted boolean
 * is rejected because it would read as a required or forbidden option.
 */
function expectMockPattern(value: unknown, label: string, optionName = false): MockPattern {
  const parsed = parsePatternScalar(value);
  if (parsed.kind === "pattern") {
    return parsed.pattern;
  }
  if (parsed.reason === "regex") {
    throw new ConfigError(`${label} is not a valid RE2 pattern: ${parsed.message}`);
  }
  throw new ConfigError(
    optionName
      ? `${label} must be a non-empty string`
      : `${label} must be a non-empty string, number, or /…/ pattern; quote a boolean literal`,
  );
}

function expectMockResult(value: unknown, label: string): MockResult {
  const result = expectRecord(value, label);
  rejectUnknownKeys(result, MOCK_RESULT_KEYS, label);
  return {
    exitCode: result.exitCode === undefined ? 0 : expectExitCode(result.exitCode, `${label}.exitCode`),
    stdout: result.stdout === undefined ? "" : expectText(result.stdout, `${label}.stdout`),
    stderr: result.stderr === undefined ? "" : expectText(result.stderr, `${label}.stderr`),
  };
}

function expectExitCode(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new ConfigError(`${label} must be an integer from 0 to 255`);
  }
  return value;
}

function expectText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(`${label} must be a string`);
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
