#!/usr/bin/env node
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileChecker } from "./checkers/file/checker.ts";
import { judgeChecker } from "./checkers/judge/checker.ts";
import { mockChecker } from "./checkers/mock/checker.ts";
import { shellChecker } from "./checkers/shell/checker.ts";
import { loadCase } from "./engine/authoring.ts";
import { ConfigError, errorMessage } from "./engine/config.ts";
import { addChecker, addRunner, createRegistry, loadTrustedImplementations } from "./engine/registry.ts";
import { runEvaluation } from "./engine/run.ts";
import type { EvaluationRecord } from "./engine/results.ts";
import { formatResolvedCase } from "./engine/view.ts";
import { piRunner } from "./runners/pi/runner.ts";
import { noopRunner } from "./runners/noop/runner.ts";
import { runAgentCommand } from "./runners/acp/commands.ts";
import { acpRunner } from "./runners/acp/runner.ts";

const USAGE = `Usage: agent-evals <command> <config.yml> [options]

Commands:
  run <config.yml>         Execute one resolved case
  view <config.yml>        Show the resolved case and its field origins
  config <agent.yml>       Query ACP configuration values without prompting
  login <agent.yml>        Run the declared native command and save login files

Options:
  --case <name>            Named case to select (required for files with cases)
  --results-dir <path>     Where run records are written (default: .agent-evals)
  --runner-dir <path>      Trusted directory of runner modules (repeatable)
  --checker-dir <path>     Trusted directory of checker modules (repeatable)
  --help                   Show this help

Configuration errors exit with code 2 before any run resource is created.
`;

type Command = "run" | "view" | "config" | "login";

interface CliOptions {
  readonly command: Command;
  readonly configPath: string;
  readonly caseName?: string;
  readonly resultsDir?: string;
  readonly runnerDirs: readonly string[];
  readonly checkerDirs: readonly string[];
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
      process.stdout.write(formatResolvedCase(resolved));
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
    // Resolve authoring configuration before loading or running any implementation.
    const resolved = await loadCase(options.configPath, {
      ...(options.caseName === undefined ? {} : { caseName: options.caseName }),
    });
    await loadTrustedImplementations(registry, {
      runnerDirs: options.runnerDirs,
      checkerDirs: options.checkerDirs,
    });
    const resultsDir = options.resultsDir ?? resolve(".agent-evals");
    const record = await runEvaluation({
      case: resolved,
      registry,
      resultsDir,
      signal: abort.signal,
    });
    printRecord(record, resultsDir);
    return exitCode(record);
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
        "runner-dir": { type: "string", multiple: true },
        "checker-dir": { type: "string", multiple: true },
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
    (values.case !== undefined ||
      values["results-dir"] !== undefined ||
      values["runner-dir"] !== undefined ||
      values["checker-dir"] !== undefined)
  ) {
    throw new ConfigError(`${command} accepts only an agent configuration file, not case or run options`);
  }
  const runnerDirs = (values["runner-dir"] ?? []).map((directory) => resolve(directory));
  const checkerDirs = (values["checker-dir"] ?? []).map((directory) => resolve(directory));
  if (command === "view" && (values["results-dir"] !== undefined || runnerDirs.length > 0 || checkerDirs.length > 0)) {
    throw new ConfigError("view does not accept --results-dir, --runner-dir, or --checker-dir");
  }

  return {
    command,
    configPath: resolve(rawConfigPath),
    ...(values.case === undefined ? {} : { caseName: values.case }),
    ...(values["results-dir"] === undefined ? {} : { resultsDir: resolve(values["results-dir"]) }),
    runnerDirs,
    checkerDirs,
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

class HelpRequested extends Error {}

const code = await main(process.argv.slice(2));
process.exitCode = code;
