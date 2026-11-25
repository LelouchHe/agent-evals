#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileChecker } from "./checkers/file/index.ts";
import { judgeChecker } from "./checkers/judge/index.ts";
import { mockChecker } from "./checkers/mock/index.ts";
import { shellChecker } from "./checkers/shell/index.ts";
import { traceChecker } from "./checkers/trace/index.ts";
import { loadCase, loadCases } from "./engine/authoring.ts";
import { ConfigError, errorMessage } from "./engine/config.ts";
import { addChecker, addRunner, createRegistry, loadTrustedImplementations } from "./engine/registry.ts";
import { executeEvaluation, prepareEvaluation, type PreparedEvaluation } from "./engine/run.ts";
import { formatMatrix, formatReport } from "./engine/report.ts";
import type { EvaluationRecord } from "./engine/results.ts";
import { describePlacement } from "./engine/placement.ts";
import { formatResolvedCase } from "./engine/view.ts";
import { piRunner } from "./runners/pi/index.ts";
import { noopRunner } from "./runners/noop/index.ts";
import { runAgentCommand } from "./runners/acp/commands.ts";
import { acpRunner } from "./runners/acp/index.ts";

const USAGE = `Usage: agent-evals <command> <config.yml> [options]

Commands:
  run <config.yml>         Execute the selected case, or every case when --case is omitted
  view <config.yml>        Show the resolved case, its field origins and its placement
  report <results-dir>...  Print a session report from retained run records
  config <agent.yml>       Query ACP configuration values without prompting
  login <agent.yml>        Run the declared native command and save login files

Options:
  --case <name>            Named case to select (required by view for files with cases)
  --reps <n>               Repeat each selected case n times, serially (default: 1)
  --results-dir <path>     Where run records are written (default: .agent-evals)
  --extension-dir <path>   Trusted extension root, one implementation per subdirectory (repeatable)
  --files                  With view: list every placed and excluded path
  --matrix                 With report: one table of checks by case instead of the session report
  --help                   Show this help

Configuration errors exit with code 2 before any run resource is created.
`;

type Command = "run" | "view" | "report" | "config" | "login";

interface CliOptions {
  readonly command: Command;
  readonly configPath: string;
  readonly caseName?: string;
  readonly resultsDir?: string;
  readonly extensionDirs: readonly string[];
  readonly showFiles: boolean;
  readonly matrix: boolean;
  readonly reps: number;
  /** Additional paths for `report`; the first one is `configPath`. */
  readonly extraPaths: readonly string[];
}

async function main(argv: readonly string[]): Promise<number> {
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  if (major < 24) {
    process.stderr.write(`error: Node.js 24 or newer is required (running ${process.versions.node})\n`);
    return 2;
  }

  let options: CliOptions;
  try {
    options = parseArguments(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`error: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }

  try {
    if (options.command === "view") {
      const resolved = await loadCase(options.configPath, {
        ...(options.caseName === undefined ? {} : { caseName: options.caseName }),
      });
      const placement = await describePlacement(resolved);
      process.stdout.write(formatResolvedCase(resolved, { placement, files: options.showFiles }));
      return 0;
    }
    if (options.command === "report") {
      const records = await readRecords(options.configPath, ...options.extraPaths);
      process.stdout.write(options.matrix ? formatMatrix(records) : formatReport(records));
      return 0;
    }
    if (options.command === "config" || options.command === "login") {
      const abort = new AbortController();
      const onSignal = () => abort.abort();
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      try {
        process.stdout.write(await runAgentCommand(options.command, options.configPath, abort.signal));
        return 0;
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    }
    return await runCommand(options);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
    } else {
      process.stderr.write(`error: ${errorMessage(error)}\n`);
    }
    return 2;
  }
}

async function runCommand(options: CliOptions): Promise<number> {
  const registry = createRegistry();
  addRunner(registry, piRunner, "built-in");
  addRunner(registry, acpRunner, "built-in");
  addRunner(registry, noopRunner, "built-in");
  addChecker(registry, fileChecker, "built-in");
  addChecker(registry, judgeChecker, "built-in");
  addChecker(registry, mockChecker, "built-in");
  addChecker(registry, shellChecker, "built-in");
  addChecker(registry, traceChecker, "built-in");

  const abort = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) {
      process.exit(130);
    }
    interrupted = true;
    abort.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // Resolve and validate every selected case before the first one runs, so a configuration
    // error in any of them runs none.
    const cases = await loadCases(options.configPath, {
      ...(options.caseName === undefined ? {} : { caseName: options.caseName }),
    });
    await loadTrustedImplementations(registry, { extensionDirs: options.extensionDirs });
    const resultsDir = options.resultsDir ?? resolve(".agent-evals");
    const prepared: PreparedEvaluation[] = [];
    for (let rep = 0; rep < options.reps; rep += 1) {
      for (const entry of cases) {
        prepared.push(await prepareEvaluation({ case: entry, registry, resultsDir, signal: abort.signal }));
      }
    }

    // One repetition of one case keeps the single-run output; so does an ordinary document.
    if (options.reps === 1 && (options.caseName !== undefined || !cases.some((entry) => entry.name !== undefined))) {
      const record = await executeEvaluation(prepared[0]!);
      printRecord(record, resultsDir);
      process.stdout.write(`\n${formatReport([record])}`);
      return exitCode(record);
    }

    const records: EvaluationRecord[] = [];
    for (const entry of prepared) {
      // Cancellation stops the rest; an error or a failed check does not.
      if (abort.signal.aborted) break;
      records.push(await executeEvaluation(entry));
    }
    const casesPerRep = cases.length;
    for (const [index, record] of records.entries()) {
      const repLabel = options.reps === 1 ? "" : `rep ${Math.floor(index / casesPerRep) + 1}/${options.reps} `;
      printCaseLine(record, resultsDir, repLabel);
    }
    const notRunCases = prepared.length - records.length;
    if (notRunCases > 0) {
      process.stdout.write(`cancelled: ${notRunCases} run${notRunCases === 1 ? "" : "s"} not run\n`);
      // The retained runs still get their report; the exit code carries the shortfall.
      if (records.length > 0) process.stdout.write(`\n${formatReport(records)}`);
      return 2;
    }
    // Every invocation ends with a session report, one run or many; nothing is written to disk.
    process.stdout.write(`\n${formatReport(records)}`);
    return aggregateExit(records);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function parseArguments(argv: readonly string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        case: { type: "string" },
        "results-dir": { type: "string" },
        "extension-dir": { type: "string", multiple: true },
        files: { type: "boolean" },
        matrix: { type: "boolean" },
        reps: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new ConfigError(errorMessage(error));
  }

  const { values, positionals } = parsed;
  if (values.help === true) {
    throw new HelpRequested();
  }

  const [command, rawConfigPath, ...unexpected] = positionals;
  if (command !== "run" && command !== "view" && command !== "report" && command !== "config" && command !== "login") {
    throw new ConfigError(command === undefined ? "a command is required" : `unknown command: ${command}`);
  }
  if (rawConfigPath === undefined) {
    throw new ConfigError(
      command === "report" ? "a results directory is required" : "a configuration file is required",
    );
  }
  if (command !== "report" && unexpected.length > 0) {
    throw new ConfigError(`unexpected argument: ${unexpected[0]}`);
  }

  if (
    (command === "config" || command === "login") &&
    (values.case !== undefined ||
      values["results-dir"] !== undefined ||
      values["extension-dir"] !== undefined ||
      values.reps !== undefined)
  ) {
    throw new ConfigError(`${command} accepts only an agent configuration file, not case or run options`);
  }
  const extensionDirs = (values["extension-dir"] ?? []).map((directory) => resolve(directory));
  if (
    command === "view" &&
    (values["results-dir"] !== undefined || extensionDirs.length > 0 || values.reps !== undefined)
  ) {
    throw new ConfigError("view does not accept --results-dir, --extension-dir or --reps");
  }
  if (command !== "view" && values.files === true) {
    throw new ConfigError("--files applies only to view");
  }
  if (command !== "report" && values.matrix === true) {
    throw new ConfigError("--matrix applies only to report");
  }
  if (
    command === "report" &&
    (values.case !== undefined ||
      values["results-dir"] !== undefined ||
      values["extension-dir"] !== undefined ||
      values.reps !== undefined)
  ) {
    throw new ConfigError("report accepts only results directories");
  }
  const reps = values.reps === undefined ? 1 : expectReps(values.reps);

  return {
    command,
    configPath: resolve(rawConfigPath),
    ...(values.case === undefined ? {} : { caseName: values.case }),
    ...(values["results-dir"] === undefined ? {} : { resultsDir: resolve(values["results-dir"]) }),
    extensionDirs,
    showFiles: values.files === true,
    matrix: values.matrix === true,
    reps,
    extraPaths: unexpected.map((path) => resolve(path)),
  };
}

/** A repetition count is a positive integer written in decimal that a loop can count to. */
function expectReps(value: string): number {
  const count = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(count) || count < 1) {
    throw new ConfigError(`--reps must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return count;
}

/**
 * Read every retained run record under the given paths. A path may be a results directory (walked
 * recursively), a single run directory or a `result.json` file.
 */
async function readRecords(...paths: readonly string[]): Promise<EvaluationRecord[]> {
  const files: string[] = [];
  for (const path of paths) {
    for (const file of await findResultFiles(path)) files.push(file);
  }
  if (files.length === 0) {
    throw new ConfigError(`no result.json found under ${paths.join(", ")}`);
  }
  const records: EvaluationRecord[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      throw new ConfigError(`cannot read ${file}: ${errorMessage(error)}`);
    }
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { checks?: unknown }).checks)) {
      throw new ConfigError(`${file} is not an agent-evals result record`);
    }
    const record = parsed as EvaluationRecord;
    // Overlapping arguments can name one record twice; a record is one run however it is reached.
    if (seen.has(record.runId)) continue;
    seen.add(record.runId);
    records.push(record);
  }
  return records;
}

async function findResultFiles(path: string): Promise<string[]> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${errorMessage(error)}`);
  }
  if (info.isFile()) {
    return [path];
  }
  const found: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      for (const file of await findResultFiles(child)) found.push(file);
    } else if (entry.name === "result.json") {
      found.push(child);
    }
  }
  return found.sort();
}

function printRecord(record: EvaluationRecord, resultsDir: string): void {
  const caseLabel = record.case.name === undefined ? record.case.path : `${record.case.name} (${record.case.path})`;
  const lines = [`run ${record.runId}: ${outcome(record)}`, `  case: ${caseLabel}`];
  lines.push(`  runner ${record.runner.type}: ${record.runner.status} (${record.runner.durationMs}ms)`);
  for (const check of record.checks) {
    lines.push(
      `  ${check.status.toUpperCase().padEnd(5)} ${check.checker} ${check.subject}${check.reason.length > 0 ? ` — ${check.reason}` : ""}`,
    );
  }
  if (record.error !== undefined) {
    lines.push(`  error: ${record.error}`);
  }
  lines.push(`  results: ${join(resultsDir, record.runId, "result.json")}`);
  process.stdout.write(lines.join("\n") + "\n");
}

/** `expect: fail` inverts a pass or fail verdict; an error is still an error. */
function exitCode(record: EvaluationRecord): number {
  switch (record.status) {
    case "pass":
      return record.resolvedConfig.expect === "fail" ? 1 : 0;
    case "fail":
      return record.resolvedConfig.expect === "fail" ? 0 : 1;
    default:
      return 2;
  }
}

/** The status a reader should see, with a negative case's expectations applied. */
function outcome(record: EvaluationRecord): string {
  if (record.resolvedConfig.expect !== "fail") {
    return record.status;
  }
  return record.status === "fail" ? "expected-fail" : record.status === "pass" ? "unexpected-pass" : record.status;
}

/** One summary line per executed case: name, status and the retained result record. */
function printCaseLine(record: EvaluationRecord, resultsDir: string, prefix = ""): void {
  const name = record.case.name ?? record.case.path;
  process.stdout.write(`${prefix}${name}: ${outcome(record)} ${join(resultsDir, record.runId, "result.json")}\n`);
}

/** Zero only when every case passed, 1 for failed checks, 2 for anything that could not be judged. */
function aggregateExit(records: readonly EvaluationRecord[]): number {
  if (records.every((record) => exitCode(record) === 0)) {
    return 0;
  }
  return records.some((record) => exitCode(record) === 2) ? 2 : 1;
}

class HelpRequested extends Error {}

const code = await main(process.argv.slice(2));
process.exitCode = code;
