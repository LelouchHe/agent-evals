import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { SpawnSupervisedOptions, SupervisedProcess } from "../types.ts";
import { sandboxExecutablePath, sandboxLaunchCommand, writeSeatbeltPolicy } from "./policy.ts";

export type { SupervisedProcess };

const SUPERVISOR_ASSET = new URL("./supervisor.sh", import.meta.url);

/** Start a sandbox-wide-cleanup supervisor; never execute its program on the host. */
export async function spawnSupervised(options: SpawnSupervisedOptions): Promise<SupervisedProcess> {
  const executable = sandboxExecutablePath();
  const [policyPath, supervisor] = await Promise.all([
    writeSeatbeltPolicy(options.policyDirectory, options.policy),
    readFile(SUPERVISOR_ASSET, "utf8"),
  ]);
  const mode = options.interactive ? "inherit" : "pipe";
  const stdio: Array<"inherit" | "pipe" | "ignore"> = [mode, mode, mode, "pipe"];
  // FD 4 is the supervisor's saved stdin; the optional report pipe is FD 5.
  if (options.report === true) stdio.push("ignore", "pipe");
  const child = spawn(
    executable,
    sandboxLaunchCommand(policyPath, "/bin/sh", ["-c", supervisor, "agent-evals", ...options.command]),
    {
      cwd: options.cwd,
      env: options.env,
      stdio,
    },
  );
  // stdio[3] is explicitly a pipe above; Node's general stdio type does not
  // distinguish its read direction from other possible descriptor kinds.
  const control = child.stdio[3] as Readable;
  // Node's type fixes `stdio` at five entries; a longer array is still honoured at runtime.
  const report =
    options.report === true
      ? ((child.stdio as unknown as Array<Readable | null | undefined>)[5] as Readable)
      : undefined;
  let status = "";
  const controlEnded = new Promise<void>((resolve, reject) => {
    control.on("data", (chunk: Buffer) => {
      status += chunk.toString("utf8");
      if (status.length > 16) {
        reject(new Error("invalid sandbox supervisor completion record"));
        control.destroy();
      }
    });
    control.once("end", resolve);
    control.once("error", reject);
  });
  let exited = false;
  const exit = new Promise<void>((resolve, reject) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", (error) => {
      exited = true;
      reject(error);
    });
  });
  const completion = Promise.all([exit, controlEnded]).then(() => {
    if (!/^(?:0|[1-9][0-9]{0,2})\n$/.test(status) || Number(status) > 255) {
      throw new Error("sandbox supervisor exited without a workload completion record");
    }
    return Number(status);
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
            throw new Error(
              reaped
                ? "sandbox supervisor did not perform cleanup before forced termination"
                : "sandbox supervisor did not exit after SIGKILL",
            );
          }
        } else {
          await exit;
        }
      } finally {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        control.destroy();
        report?.destroy();
      }
    })());
  return { child, completion, stop, ...(report === undefined ? {} : { report }) };
}
