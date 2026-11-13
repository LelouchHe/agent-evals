import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { sandboxExecutablePath, sandboxLaunchCommand, writeSeatbeltPolicy, type SandboxPolicy } from "./policy.ts";

// Deliberately not a standalone executable: this program is only ever passed
// to sandbox-exec with our generated same-sandbox signal policy. FD 3 is the
// private completion channel; the workload never inherits it. Save stdin on
// FD 4 because asynchronous shell commands otherwise receive /dev/null.
const SUPERVISOR = `
trap 'kill -KILL -- -1' TERM INT HUP
exec 4<&0
"$@" <&4 3>&- 4<&- &
child=$!
exec 4<&-
wait "$child"
status=$?
printf '%s\\n' "$status" >&3
kill -KILL -- -1
`;

export interface SupervisedProcess {
  readonly child: ChildProcess;
  /** Native workload result, not the supervisor's intentional SIGKILL exit. */
  readonly completion: Promise<number>;
  readonly stop: () => Promise<void>;
}

/** Start a sandbox-wide-cleanup supervisor; never execute its program on the host. */
export async function spawnSupervised(options: {
  readonly policy: SandboxPolicy;
  readonly policyDirectory: string;
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly interactive: boolean;
}): Promise<SupervisedProcess> {
  const executable = sandboxExecutablePath();
  const policyPath = await writeSeatbeltPolicy(options.policyDirectory, options.policy);
  const mode = options.interactive ? "inherit" : "pipe";
  const child = spawn(
    executable,
    sandboxLaunchCommand(policyPath, "/bin/sh", ["-c", SUPERVISOR, "agent-evals", ...options.command]),
    {
      cwd: options.cwd,
      env: options.env,
      stdio: [mode, mode, mode, "pipe"],
    },
  );
  // stdio[3] is explicitly a pipe above; Node's general stdio type does not
  // distinguish its read direction from other possible descriptor kinds.
  const control = child.stdio[3] as Readable;
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
      }
    })());
  return { child, completion, stop };
}
