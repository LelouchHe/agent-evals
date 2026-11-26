import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SpawnSupervisedOptions, SupervisedProcess } from "../types.ts";
import { buildWindowsWorkloadEnv, winSandboxExecutablePath } from "./policy.ts";

export async function spawnSupervised(options: SpawnSupervisedOptions): Promise<SupervisedProcess> {
  const helper = winSandboxExecutablePath();
  const [program, ...args] = options.command;
  await mkdir(options.policyDirectory, { recursive: true });

  const controlPipe = `\\\\.\\pipe\\agent-evals-stop-${randomUUID()}`;
  let controlSocket: Socket | undefined;
  let stopRequested = false;
  const controlServer = createServer((socket) => {
    controlSocket = socket;
    socket.on("error", () => {});
    if (stopRequested) {
      socket.end("stop\n");
    }
  });
  controlServer.unref();
  await new Promise<void>((resolveListen, rejectListen) => {
    controlServer.once("error", rejectListen);
    controlServer.listen(controlPipe, () => {
      controlServer.off("error", rejectListen);
      resolveListen();
    });
  });

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
    writeRestrictedOnly: true,
    controlPipe,
  };
  await writeFile(configPath, JSON.stringify(config), "utf8");

  const mode = options.interactive ? "inherit" : "pipe";
  const child = spawn(helper, ["--config", configPath, "--delete-config"], {
    cwd: options.cwd,
    stdio: [mode, mode, mode],
    windowsHide: !options.interactive,
  });

  const closeControl = (): void => {
    controlSocket?.destroy();
    controlServer.close();
  };

  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("exit", (code, signal) => {
      exited = true;
      closeControl();
      resolveExit({ code, signal });
    });
    child.once("error", (error) => {
      exited = true;
      closeControl();
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

  const waitForExit = async (ms: number): Promise<boolean> => {
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
          stopRequested = true;
          if (controlSocket !== undefined) {
            controlSocket.end("stop\n");
          }
          if (!(await waitForExit(2_500))) {
            child.kill();
            const reaped = await waitForExit(2_000);
            if (!reaped) {
              throw new Error("Windows sandbox supervisor did not exit after kill");
            }
          }
        } else {
          await exit;
        }
      } finally {
        closeControl();
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    })());

  return { child, completion, stop };
}
