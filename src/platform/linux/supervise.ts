import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { SpawnSupervisedOptions, SupervisedProcess } from "../types.ts";
import { buildBwrapArgs, bwrapExecutablePath } from "./policy.ts";

/**
 * Start a command inside a bubblewrap PID namespace (`--unshare-pid --die-with-parent`).
 * When the workload exits or `bwrap` is terminated, the kernel tears down the PID namespace
 * and sends SIGKILL to every remaining descendant automatically.
 */
export async function spawnSupervised(options: SpawnSupervisedOptions): Promise<SupervisedProcess> {
  const executable = bwrapExecutablePath();
  const [program, ...args] = options.command;
  const mode = options.interactive ? "inherit" : "pipe";
  const stdio: Array<"inherit" | "pipe" | "ignore"> = [mode, mode, mode];
  // Optional private report pipe at FD 5 (FD 3 and 4 unused on Linux).
  if (options.report === true) stdio.push("ignore", "ignore", "pipe");

  const child = spawn(executable, buildBwrapArgs(options.policy, program, args), {
    cwd: options.cwd,
    env: options.env,
    stdio,
  });
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

  const waitForExit = async (): Promise<boolean> => {
    const deadline = new AbortController();
    try {
      return await Promise.race([exit.then(() => true), delay(1000, false, { signal: deadline.signal })]);
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
            const reaped = await waitForExit();
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
