#!/usr/bin/env node
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
  config <agent.yml>       Query ACP configuration values without prompting
  login <agent.yml>        Run the declared native command and save login files

Options:
  --case <name>            Named case to select (required by view for files with cases)
  --results-dir <path>     Where run records are written (default: .agent-evals)
  --extension-dir <path>   Trusted extension root, one implementation per subdirectory (repeatable)
  --files                  With view: list every placed and excluded path
  --help                   Show this help

Configuration errors exit with code 2 before any run resource is created.
`;

type Command = "run" | "view" | "config" | "login";

interface CliOptions {
  readonly command: Command;
  readonly configPath: string;
  readonly caseName?: string;
  readonly resultsDir?: string;
  readonly extensionDirs: readonly string[];
  readonly showFiles: boolean;
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
    for (const entry of cases) {
      prepared.push(await prepareEvaluation({ case: entry, registry, resultsDir, signal: abort.signal }));
    }

    // A named selection keeps the single-run output; so does an ordinary document.
    if (options.caseName !== undefined || !cases.some((entry) => entry.name !== undefined)) {
      const record = await executeEvaluation(prepared[0]!);
      printRecord(record, resultsDir);
      return exitCode(record);
    }

    const records: EvaluationRecord[] = [];
    for (const entry of prepared) {
      // Cancellation stops the rest; an error or a failed check does not.
      if (abort.signal.aborted) break;
      records.push(await executeEvaluation(entry));
    }
    for (const record of records) {
      printCaseLine(record, resultsDir);
    }
    const notRun = prepared.length - records.length;
    if (notRun > 0) {
      process.stdout.write(`cancelled: ${notRun} case${notRun === 1 ? "" : "s"} not run\n`);
      return 2;
    }
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
  if (command !== "run" && command !== "view" && command !== "config" && command !== "login") {
    throw new ConfigError(command === undefined ? "a command is required" : `unknown command: ${command}`);
  }
  if (rawConfigPath === undefined) {
    throw new ConfigError("a configuration file is required");
  }
  if (unexpected.length > 0) {
    throw new ConfigError(`unexpected argument: ${unexpected[0]}`);
  }

  if (
    (command === "config" || command === "login") &&
    (values.case !== undefined || values["results-dir"] !== undefined || values["extension-dir"] !== undefined)
  ) {
    throw new ConfigError(`${command} accepts only an agent configuration file, not case or run options`);
  }
  const extensionDirs = (values["extension-dir"] ?? []).map((directory) => resolve(directory));
  if (command === "view" && (values["results-dir"] !== undefined || extensionDirs.length > 0)) {
    throw new ConfigError("view does not accept --results-dir or --extension-dir");
  }
  if (command !== "view" && values.files === true) {
    throw new ConfigError("--files applies only to view");
  }

  return {
    command,
    configPath: resolve(rawConfigPath),
    ...(values.case === undefined ? {} : { caseName: values.case }),
    ...(values["results-dir"] === undefined ? {} : { resultsDir: resolve(values["results-dir"]) }),
    extensionDirs,
    showFiles: values.files === true,
  };
}

function printRecord(record: EvaluationRecord, resultsDir: string): void {
  const caseLabel = record.case.name === undefined ? record.case.path : `${record.case.name} (${record.case.path})`;
  const lines = [`run ${record.runId}: ${record.status}`, `  case: ${caseLabel}`];
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

function exitCode(record: EvaluationRecord): number {
  switch (record.status) {
    case "pass":
      return 0;
    case "fail":
      return 1;
    default:
      return 2;
  }
}

/** One summary line per executed case: name, status and the retained result record. */
function printCaseLine(record: EvaluationRecord, resultsDir: string): void {
  const name = record.case.name ?? record.case.path;
  process.stdout.write(`${name}: ${record.status} ${join(resultsDir, record.runId, "result.json")}\n`);
}

/** Zero only when every case passed, 1 for failed checks, 2 for anything that could not be judged. */
function aggregateExit(records: readonly EvaluationRecord[]): number {
  if (records.every((record) => record.status === "pass")) {
    return 0;
  }
  return records.some((record) => exitCode(record) === 2) ? 2 : 1;
}

class HelpRequested extends Error {}

const code = await main(process.argv.slice(2));
process.exitCode = code;
