import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { SpawnSupervisedOptions, SupervisedProcess } from "../types.ts";
import { bwrapExecutablePath, prepareBwrapLaunch, trustedHostEnv } from "./policy.ts";

const SCRIPT_BINARY = "/usr/bin/script";

/**
 * Start a command inside a bubblewrap PID namespace (`--unshare-pid --die-with-parent`).
 * Workload environment is installed via `--args` on FD 3 so host launchers (`bwrap`, `script`)
 * run with a minimal trusted environment. When interactive on a real TTY, `util-linux` `script`
 * allocates a sandbox-owned PTY so `/dev/tty` works without exposing the operator's terminal.
 */
export async function spawnSupervised(options: SpawnSupervisedOptions): Promise<SupervisedProcess> {
  const executable = bwrapExecutablePath();
  const [program, ...args] = options.command;
  const usePty = options.interactive && process.stdin.isTTY === true;
  if (usePty) {
    assertScriptAvailable();
  }
  const launch = await prepareBwrapLaunch(options.policyDirectory, options.policy, options.env, {
    // When `script` allocates a private PTY, it already starts a new session with that PTY as
    // controlling terminal; omit `--new-session` so `/dev/tty` stays attached to the private PTY.
    newSession: !usePty,
  });
  const mode = options.interactive ? "inherit" : "pipe";
  // FD 3 = bwrap --args, FD 4 = optional --seccomp, FD 5 = optional check-runner report pipe.
  const stdio: Array<"inherit" | "pipe" | "ignore" | number> = [mode, mode, mode, launch.argsFd];
  if (launch.seccompFd !== undefined) {
    stdio.push(launch.seccompFd);
  } else if (options.report === true) {
    stdio.push("ignore");
  }
  if (options.report === true) stdio.push("pipe");

  const bwrapCommand = [executable, "--args", "3", "--", program, ...args];
  let launchCommand = executable;
  let launchArgs = bwrapCommand.slice(1);
  if (usePty) {
    const quoted = bwrapCommand.map(shellQuote).join(" ");
    launchCommand = SCRIPT_BINARY;
    launchArgs = ["-q", "-e", "-f", "-c", quoted, "/dev/null"];
  }

  let child;
  try {
    child = spawn(launchCommand, launchArgs, {
      cwd: options.cwd,
      env: trustedHostEnv(usePty),
      stdio,
    });
  } finally {
    launch.closeFds();
  }
  const report =
    options.report === true
      ? ((child.stdio as unknown as Array<Readable | null | undefined>)[5] as Readable)
      : undefined;

  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      exited = true;
      reject(error);
    });
  });

  const completion = exit.then(({ code }) => {
    if (code === null) {
      throw new Error("sandbox supervisor exited without a workload completion record");
    }
    return code;
  });
  // Query operations intentionally stop a still-running ACP server, so they
  // need not await its native exit result. Rejections remain observable to login.
  completion.catch(() => {});

  const stopGraceMs = usePty ? 2_500 : 1_000;
  const waitForExit = async (ms = stopGraceMs): Promise<boolean> => {
    const deadline = new AbortController();
    try {
      return await Promise.race([exit.then(() => true), delay(ms, false, { signal: deadline.signal })]);
    } finally {
      deadline.abort();
    }
  };

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      try {
        if (!exited) {
          child.kill("SIGCONT");
          child.kill("SIGTERM");
          if (!(await waitForExit())) {
            child.kill("SIGKILL");
            const reaped = await waitForExit(1_000);
            if (!reaped) {
              throw new Error("sandbox supervisor did not exit after SIGKILL");
            }
          }
        } else {
          await exit;
        }
      } finally {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        report?.destroy();
      }
    })());

  return { child, completion, stop, ...(report === undefined ? {} : { report }) };
}

function assertScriptAvailable(): void {
  try {
    accessSync(SCRIPT_BINARY, constants.X_OK);
  } catch {
    throw new Error(
      `interactive Linux sandboxes require ${SCRIPT_BINARY} (util-linux) to isolate the controlling terminal`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
