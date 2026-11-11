#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileChecker } from "./checkers/file/checker.ts";
import { judgeChecker } from "./checkers/judge/checker.ts";
import { ConfigError, errorMessage, loadCandidate, loadCase } from "./engine/config.ts";
import { addChecker, addRunner, createRegistry, loadTrustedImplementations } from "./engine/registry.ts";
import { runEvaluation } from "./engine/run.ts";
import type { EvaluationRecord } from "./engine/results.ts";
import { piRunner } from "./runners/pi/runner.ts";

const USAGE = `Usage: agent-evals --case <case.yml> --candidate <candidate.yml> [options]

Options:
  --case <path>            Case configuration (YAML)
  --candidate <path>       Candidate configuration (YAML)
  --results-dir <path>     Where run records are written (default: .eval-results)
  --runner-dir <path>      Trusted directory of runner modules (repeatable)
  --checker-dir <path>     Trusted directory of checker modules (repeatable)
  --help                   Show this help
`;

interface CliOptions {
  readonly casePath: string;
  readonly candidatePath: string;
  readonly resultsDir: string;
  readonly runnerDirs: string[];
  readonly checkerDirs: string[];
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

  const registry = createRegistry();
  addRunner(registry, piRunner, "built-in");
  addChecker(registry, fileChecker, "built-in");
  addChecker(registry, judgeChecker, "built-in");

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
    await loadTrustedImplementations(registry, { runnerDirs: options.runnerDirs, checkerDirs: options.checkerDirs });
    const loadedCase = await loadCase(options.casePath);
    const candidate = await loadCandidate(options.candidatePath);
    const record = await runEvaluation({
      case: loadedCase,
      candidate,
      registry,
      resultsDir: options.resultsDir,
      signal: abort.signal,
    });
    printRecord(record, options.resultsDir);
    return exitCode(record);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
    } else {
      process.stderr.write(`error: ${errorMessage(error)}\n`);
    }
    return 2;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function parseArguments(argv: readonly string[]): CliOptions {
  let casePath: string | undefined;
  let candidatePath: string | undefined;
  let resultsDir = ".eval-results";
  const runnerDirs: string[] = [];
  const checkerDirs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      throw new HelpRequested();
    }
    const value = () => {
      index += 1;
      const next = argv[index];
      if (next === undefined) {
        throw new ConfigError(`${argument} requires a value`);
      }
      return next;
    };
    switch (argument) {
      case "--case":
        casePath = resolve(value());
        break;
      case "--candidate":
        candidatePath = resolve(value());
        break;
      case "--results-dir":
        resultsDir = resolve(value());
        break;
      case "--runner-dir":
        runnerDirs.push(resolve(value()));
        break;
      case "--checker-dir":
        checkerDirs.push(resolve(value()));
        break;
      default:
        throw new ConfigError(`unknown argument: ${argument}`);
    }
  }

  if (casePath === undefined || candidatePath === undefined) {
    throw new ConfigError("--case and --candidate are required");
  }
  return { casePath, candidatePath, resultsDir, runnerDirs, checkerDirs };
}

function printRecord(record: EvaluationRecord, resultsDir: string): void {
  const lines = [`run ${record.runId}: ${record.status}`];
  lines.push(`  runner ${record.runner.type}: ${record.runner.status} (${record.runner.durationMs}ms)`);
  for (const check of record.checks) {
    lines.push(`  ${check.status.toUpperCase().padEnd(5)} ${check.checker} ${check.subject}${check.reason.length > 0 ? ` — ${check.reason}` : ""}`);
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
