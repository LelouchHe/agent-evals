import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SpawnSupervisedOptions, SupervisedProcess } from "../types.ts";
import { buildWindowsWorkloadEnv, winSandboxExecutablePath } from "./policy.ts";

export async function spawnSupervised(options: SpawnSupervisedOptions): Promise<SupervisedProcess> {
  const helper = winSandboxExecutablePath();
  const [program, ...args] = options.command;
  await mkdir(options.policyDirectory, { recursive: true });
  const configPath = join(options.policyDirectory, `win-sandbox-${randomUUID()}.json`);
  const config = {
    command: program,
    args,
    cwd: resolve(options.cwd),
    env: buildWindowsWorkloadEnv(options.env),
    writableRoots: options.policy.writableRoots,
    readableRoots: options.policy.readableRoots,
    writableFiles: options.policy.writableFiles ?? [],
    readableFiles: options.policy.readableFiles ?? [],
    allowNetwork: options.policy.allowNetwork,
  };
  await writeFile(configPath, JSON.stringify(config), "utf8");

  const mode = options.interactive ? "inherit" : "pipe";
  const child = spawn(helper, ["--config", configPath, "--delete-config"], {
    cwd: options.cwd,
    stdio: [mode, mode, mode],
    windowsHide: !options.interactive,
  });

  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolveExit({ code, signal });
    });
    child.once("error", (error) => {
      exited = true;
      rejectExit(error);
    });
  });

  const completion = exit.then(({ code }) => {
    if (code === null) {
      throw new Error("sandbox supervisor exited without a workload completion record");
    }
    return code;
  });
  completion.catch(() => {});

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      try {
        if (!exited) {
          child.kill();
          const deadline = new AbortController();
          try {
            const reaped = await Promise.race([
              exit.then(() => true),
              delay(3_000, false, { signal: deadline.signal }),
            ]);
            if (!reaped) {
              throw new Error("Windows sandbox supervisor did not exit after kill");
            }
          } finally {
            deadline.abort();
          }
        } else {
          await exit;
        }
      } finally {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    })());

  return { child, completion, stop };
}
