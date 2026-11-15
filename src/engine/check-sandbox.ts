import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { spawnSupervised, type SupervisedProcess } from "../platform/macos/supervise.ts";
import type { CheckSandbox, CheckSandboxOutcome } from "./registry.ts";
import { SYSTEM_PATH } from "../platform/macos/policy.ts";

/** How much of a program's combined output a check may keep as its reason. */
const MAX_OUTPUT_LENGTH = 4_096;
/** A shell reports a child killed by a signal as this exit status. */
const SIGNAL_STATUS_OFFSET = 128;

export interface CheckSandboxOptions {
  /** Prepared workspace root; the program starts here and may write in it. */
  readonly workspaceDir: string;
  /** The run root, where the private HOME, temporary directory and policy are created. */
  readonly runRootDir: string;
  readonly signal: AbortSignal;
}

/**
 * The engine's check sandbox: the evaluated agent has stopped, so reads are open, while writes
 * stay beneath the workspace and a private HOME and temporary directory and the network is denied.
 */
export function createCheckSandbox(options: CheckSandboxOptions): CheckSandbox {
  return { run: (command) => runProgram(options, command) };
}

async function runProgram(options: CheckSandboxOptions, command: readonly string[]): Promise<CheckSandboxOutcome> {
  const [program, ...args] = command;
  if (program === undefined) {
    return { kind: "failed", reason: "the check named no program", output: "" };
  }
  const path = process.env.PATH ?? SYSTEM_PATH.join(":");
  const executable = await resolveProgram(program, path, options.workspaceDir);
  if (executable === undefined) {
    return { kind: "failed", reason: `could not start ${program}: no executable`, output: "" };
  }

  const directory = await mkdtemp(join(options.runRootDir, "check-"));
  const homeDir = join(directory, "home");
  const tmpDir = join(directory, "tmp");
  let supervised: SupervisedProcess | undefined;
  try {
    await Promise.all([mkdir(homeDir, { mode: 0o700 }), mkdir(tmpDir, { mode: 0o700 })]);
    supervised = await spawnSupervised({
      policy: {
        writableRoots: [options.workspaceDir, homeDir, tmpDir],
        readableRoots: [],
        readAll: true,
        allowNetwork: false,
      },
      policyDirectory: directory,
      // `env -i` keeps the supervisor's shell from adding PWD, SHLVL or `_` to the program.
      command: ["/usr/bin/env", "-i", `PATH=${path}`, `HOME=${homeDir}`, `TMPDIR=${tmpDir}`, executable, ...args],
      cwd: options.workspaceDir,
      env: { PATH: path, HOME: homeDir, TMPDIR: tmpDir },
      interactive: false,
    });
    return await supervise(supervised, options);
  } catch (error) {
    return {
      kind: "failed",
      reason: `could not start ${program}: ${error instanceof Error ? error.message : String(error)}`,
      output: "",
    };
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
  let output = "";
  const append = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
    if (output.length > MAX_OUTPUT_LENGTH) output = output.slice(-MAX_OUTPUT_LENGTH);
  };
  supervised.child.stdout?.on("data", append);
  supervised.child.stderr?.on("data", append);
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
  try {
    const status = await Promise.race([supervised.completion, cancelled]);
    if (status === "cancelled" || aborted) {
      return { kind: "failed", reason: "the program did not finish before the check deadline", output };
    }
    const signal = signalOf(status);
    if (signal !== undefined) {
      return { kind: "signalled", signal, output };
    }
    return { kind: "exited", exitCode: status, output };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}

/** A POSIX shell reports a child killed by signal n as 128+n; no other status distinguishes it. */
function signalOf(status: number): string | undefined {
  if (status <= SIGNAL_STATUS_OFFSET) return undefined;
  const number = status - SIGNAL_STATUS_OFFSET;
  for (const [name, value] of Object.entries(osConstants.signals)) {
    if (value === number) return name;
  }
  return undefined;
}

/** Resolve the program the way the sandbox's `PATH` and working directory would. */
async function resolveProgram(program: string, path: string, cwd: string): Promise<string | undefined> {
  const candidates = program.includes("/")
    ? [isAbsolute(program) ? program : resolve(cwd, program)]
    : path
        .split(":")
        .filter((directory) => directory.length > 0)
        .map((directory) => join(directory, program));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}
