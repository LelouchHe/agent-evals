import { spawn } from "node:child_process";
import type { TestContext } from "node:test";

export interface CliProcessOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Local deadline for the child, below the enclosing test deadline. */
  readonly timeoutMs?: number;
  /** Usually the enclosing test's signal, so timeout/cancellation stops the child. */
  readonly signal?: AbortSignal;
}

export interface CliProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 1_000;
const KILL_REAP_MS = 5_000;

/**
 * Run a CLI child with a bounded lifecycle.
 *
 * Cleanup is registered at creation, the enclosing test signal aborts the run,
 * and the child process group is stopped with SIGTERM then SIGKILL before the
 * helper settles. This keeps a hanging CLI or a test deadline from pinning the
 * suite or leaving an orphan behind.
 */
export async function runCliProcess(
  t: TestContext,
  entry: string,
  args: readonly string[],
  options: CliProcessOptions,
): Promise<CliProcessResult> {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  let exitInfo: { readonly code: number | null } | undefined;
  let spawnError: Error | undefined;
  let exitedResolve: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    exitedResolve = resolve;
  });
  const settleExit = (code: number | null): void => {
    if (exitInfo !== undefined) {
      return;
    }
    exitInfo = { code };
    exitedResolve?.();
  };

  child.once("exit", (code) => settleExit(code));
  child.once("error", (error) => {
    spawnError = error;
    settleExit(null);
  });

  const signalChild = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) {
      return;
    }
    try {
      // The child is a detached process-group leader; stop everything it owns.
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process or group may already be gone.
      }
    }
  };

  const waitForExit = (timeoutMs: number): Promise<boolean> => {
    if (exitInfo !== undefined) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      child.once("exit", onExit);
      function onExit(): void {
        clearTimeout(timer);
        resolve(true);
      }
    });
  };

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      if (exitInfo !== undefined || child.pid === undefined) {
        return;
      }
      signalChild("SIGTERM");
      if (await waitForExit(STOP_GRACE_MS)) {
        return;
      }
      signalChild("SIGKILL");
      if (await waitForExit(KILL_REAP_MS)) {
        return;
      }
      child.unref();
      throw new Error(`CLI process ${String(child.pid)} did not exit after SIGKILL`);
    })();
    return stopPromise;
  };

  t.after(stop);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal ?? t.signal;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const failure = new Promise<Error>((resolve) => {
    onAbort = () => resolve(new Error(`CLI invocation ${entry} was cancelled by the test`));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => resolve(new Error(`CLI invocation ${entry} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const outcome = await Promise.race([exited.then(() => "exit" as const), failure.then((error) => ({ error }))]);
    if (outcome === "exit") {
      if (spawnError !== undefined) {
        throw spawnError;
      }
      return { code: exitInfo?.code ?? null, stdout, stderr };
    }

    const reason = outcome.error;
    try {
      await stop();
    } catch (cleanupError) {
      throw new Error(`${reason.message}; cleanup failed: ${String(cleanupError)}`, { cause: cleanupError });
    }
    throw reason;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
