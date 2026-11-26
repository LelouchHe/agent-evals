import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "./config.ts";
import { stageCheckFiles } from "./files.ts";
import type { CheckSandbox, CheckSandboxOutcome } from "./registry.ts";
import { siblingRuntimeModule } from "./runtime-assets.ts";
import { SYSTEM_PATH, spawnSupervised, type SupervisedProcess } from "../platform/index.ts";

/** How much of a program's combined output a check may keep as its reason. */
const MAX_OUTPUT_LENGTH = 4_096;
const CHECK_RUNNER = fileURLToPath(siblingRuntimeModule(import.meta.url, "check-runner"));

export interface CheckSandboxOptions {
  /** Prepared workspace root; the program starts here and may write in it. */
  readonly workspaceDir: string;
  /** Engine-private directory; the check's own HOME, temporary directory and policy live here. */
  readonly engineDir: string;
  /** Where a checker's `files` sources resolve from, normally the case file's directory. */
  readonly authoringDir: string;
  /** The check's deadline or cancellation. */
  readonly signal: AbortSignal;
  /** The run's own abort signal; when it fired, an aborted check was cancelled, not timed out. */
  readonly cancelled?: AbortSignal;
}

/**
 * The engine's check sandbox: the evaluated agent has stopped, so reads are open, while writes
 * stay beneath the workspace and a private HOME and temporary directory and the network is denied.
 */
export function createCheckSandbox(options: CheckSandboxOptions): CheckSandbox {
  return { run: (command, runOptions) => runProgram(options, command, runOptions?.files) };
}

/** The outcome the wrapper reports, before the launcher attaches the program's output. */
type ReportedOutcome =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "signalled"; readonly signal: string }
  | { readonly kind: "failed"; readonly reason: string };

async function runProgram(
  options: CheckSandboxOptions,
  command: readonly string[],
  files: Readonly<Record<string, string>> | undefined,
): Promise<CheckSandboxOutcome> {
  const [program, ...args] = command;
  if (program === undefined) {
    return { kind: "failed", reason: "the check named no program", output: "" };
  }
  const path = process.env.PATH ?? SYSTEM_PATH.join(":");
  const directory = await mkdtemp(join(options.engineDir, "check-"));
  const homeDir = join(directory, "home");
  const tmpDir = join(directory, "tmp");
  let supervised: SupervisedProcess | undefined;
  let stagingDir: string | undefined;
  try {
    await Promise.all([mkdir(homeDir, { mode: 0o700 }), mkdir(tmpDir, { mode: 0o700 })]);
    if (files !== undefined && Object.keys(files).length > 0) {
      if (options.signal.aborted) {
        return { kind: "failed", reason: abortReason(options), output: "" };
      }
      stagingDir = join(directory, "staged");
      try {
        await mkdir(stagingDir);
        await stageCheckFiles(files, options.authoringDir, stagingDir, options.signal, "check files");
      } catch (error) {
        if (options.signal.aborted) {
          return { kind: "failed", reason: abortReason(options), output: "" };
        }
        return { kind: "failed", reason: `could not place files: ${errorMessage(error)}`, output: "" };
      }
    }
    if (options.signal.aborted) {
      return { kind: "failed", reason: abortReason(options), output: "" };
    }
    supervised = await spawnSupervised({
      policy: {
        writableRoots: [options.workspaceDir, homeDir, tmpDir],
        readableRoots: stagingDir === undefined ? [] : [stagingDir],
        readAll: true,
        allowNetwork: false,
      },
      policyDirectory: directory,
      command: [process.execPath, CHECK_RUNNER, stagingDir ?? "-", program, ...args],
      cwd: options.workspaceDir,
      env: { PATH: path, HOME: homeDir, TMPDIR: tmpDir },
      interactive: false,
      report: true,
    });
    return await supervise(supervised, options);
  } catch (error) {
    return { kind: "failed", reason: `the check sandbox failed: ${errorMessage(error)}`, output: "" };
  } finally {
    try {
      await supervised?.stop();
    } catch {
      // The run root is removed with everything the supervisor could not stop.
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
      // The engine removes the containing run root and records any failure there.
    });
  }
}

async function supervise(supervised: SupervisedProcess, options: CheckSandboxOptions): Promise<CheckSandboxOutcome> {
  let stdout = "";
  let stderr = "";
  let report = "";
  supervised.child.stdout?.on("data", (chunk: Buffer) => {
    stdout = keepTail(stdout, chunk);
  });
  supervised.child.stderr?.on("data", (chunk: Buffer) => {
    stderr = keepTail(stderr, chunk);
  });
  supervised.report?.on("data", (chunk: Buffer) => {
    if (report.length <= MAX_OUTPUT_LENGTH) report += chunk.toString("utf8");
  });
  // The check program reads no standard input, so it does not wait for the engine.
  supervised.child.stdin?.end();

  let aborted = options.signal.aborted;
  const onAbort = (): void => {
    aborted = true;
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  const cancelled = new Promise<"cancelled">((resolveCancelled) => {
    if (options.signal.aborted) {
      resolveCancelled("cancelled");
      return;
    }
    options.signal.addEventListener("abort", () => resolveCancelled("cancelled"), { once: true });
  });
  const closed = new Promise<void>((resolveClosed) => supervised.child.once("close", () => resolveClosed()));
  try {
    const status = await Promise.race([supervised.completion.catch(() => undefined), cancelled]);
    if (status === "cancelled" || aborted) {
      return { kind: "failed", reason: abortReason(options), output: tail(stdout + stderr) };
    }
    if (status === undefined) {
      return { kind: "failed", reason: "the check sandbox ended without an outcome", output: tail(stdout + stderr) };
    }
    // Completion arrives on its own pipe before the output and report pipes are drained.
    await closed;
    const outcome = readReport(report);
    if (outcome === undefined) {
      return { kind: "failed", reason: "the check program did not report an outcome", output: tail(stdout + stderr) };
    }
    return { ...outcome, output: tail(stdout + stderr) };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}

function abortReason(options: CheckSandboxOptions): string {
  return options.cancelled?.aborted === true
    ? "the run was cancelled while this check was running"
    : "the program did not finish before the check deadline";
}

/** Read the wrapper's one report line; anything else means the report is missing or corrupt. */
function readReport(report: string): ReportedOutcome | undefined {
  const lines = report.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(lines[0] as string);
  } catch {
    return undefined;
  }
  return reportedOutcome(value);
}

function reportedOutcome(value: unknown): ReportedOutcome | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "exited" && Number.isSafeInteger(record.exitCode)) {
    return { kind: "exited", exitCode: record.exitCode as number };
  }
  if (record.kind === "signalled" && typeof record.signal === "string") {
    return { kind: "signalled", signal: record.signal };
  }
  if (record.kind === "failed" && typeof record.reason === "string") {
    return { kind: "failed", reason: record.reason };
  }
  return undefined;
}

function keepTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_OUTPUT_LENGTH ? next.slice(-MAX_OUTPUT_LENGTH) : next;
}

function tail(value: string): string {
  return value.length > MAX_OUTPUT_LENGTH ? value.slice(-MAX_OUTPUT_LENGTH) : value;
}
