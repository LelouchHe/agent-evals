import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError, errorMessage } from "./config.ts";

const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_STOP_GRACE_MS = 1_000;
const COMMAND_REAP_MS = 5_000;

/** Run-scoped access to credentials requested by implementation factories. */
export interface CredentialSource {
  /** Resolve one named credential from the invocation `.env`, caching it per run. */
  require(name: string): Promise<string>;
}

/**
 * Create a lazy credential source rooted at the invocation working directory.
 * The `.env` file is read only when a credential is actually requested.
 */
export function createCredentialSource(directory: string, signal?: AbortSignal): CredentialSource {
  const file = join(directory, ".env");
  const cache = new Map<string, Promise<string>>();
  let valuesPromise: Promise<Record<string, string | undefined>> | undefined;

  const values = (): Promise<Record<string, string | undefined>> =>
    (valuesPromise ??= (async () => {
      try {
        return parseEnv(await readFile(file, "utf8"));
      } catch (error) {
        throw new ConfigError(`could not load credential file ${file}: ${errorMessage(error)}`);
      }
    })());

  return {
    require(name: string): Promise<string> {
      const cached = cache.get(name);
      if (cached !== undefined) {
        return cached;
      }
      const pending = (async () => {
        if (signal?.aborted === true) {
          throw new ConfigError(`credential lookup for ${name} was cancelled`);
        }

        let parsed: Record<string, string | undefined>;
        try {
          parsed = await values();
        } catch (error) {
          throw new ConfigError(`credential ${name} is unavailable: ${errorMessage(error)}`);
        }
        if (!Object.hasOwn(parsed, name)) {
          throw new ConfigError(`credential ${name} is not defined in ${file}`);
        }

        const value = parsed[name] ?? "";
        if (value.length === 0) {
          throw new ConfigError(`credential ${name} is empty in ${file}`);
        }
        if (!value.startsWith("!")) {
          return value;
        }

        const command = value.slice(1).trim();
        if (command.length === 0) {
          throw new ConfigError(`credential ${name} has an empty lookup command in ${file}`);
        }
        return runLookupCommand(name, command, directory, signal);
      })();
      cache.set(name, pending);
      return pending;
    },
  };
}

async function runLookupCommand(
  name: string,
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted === true) {
    throw new ConfigError(`credential lookup for ${name} was cancelled`);
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const stdoutStream = child.stdout;
    const stdoutClosed = new Promise<void>((resolveClose) => {
      if (stdoutStream === null) {
        resolveClose();
      } else {
        stdoutStream.once("close", () => resolveClose());
      }
    });

    let stdout = "";
    let outputBytes = 0;
    let exitInfo: { readonly code: number | null } | undefined;
    let finalized = false;
    let terminalError: Error | undefined;

    const signalGroup = (value: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, value);
      } catch {
        try {
          child.kill(value);
        } catch {
          // Already gone.
        }
      }
    };

    const groupAlive = (): boolean => {
      if (child.pid === undefined) {
        return false;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const waitForGroupExit = async (timeoutMs: number): Promise<boolean> => {
      const deadline = performance.now() + timeoutMs;
      while (groupAlive()) {
        if (performance.now() >= deadline) {
          return false;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      return true;
    };

    const stopGroup = async (): Promise<boolean> => {
      if (!groupAlive()) {
        return true;
      }
      signalGroup("SIGTERM");
      if (await waitForGroupExit(COMMAND_STOP_GRACE_MS)) {
        return true;
      }
      signalGroup("SIGKILL");
      if (await waitForGroupExit(COMMAND_REAP_MS)) {
        return true;
      }
      child.unref();
      return false;
    };

    const waitForStdoutClose = async (timeoutMs: number): Promise<boolean> => {
      let timer: NodeJS.Timeout | undefined;
      const closed = await Promise.race([
        stdoutClosed.then(() => true),
        new Promise<boolean>((resolveWait) => {
          timer = setTimeout(() => resolveWait(false), timeoutMs);
        }),
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      return closed;
    };

    const finalize = (exitCode?: number | null): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void (async () => {
        const groupStopped = await stopGroup();
        const stdoutDrained = await waitForStdoutClose(COMMAND_REAP_MS);
        if (!stdoutDrained) {
          stdoutStream?.destroy();
        }

        let error = terminalError;
        if (outputBytes > COMMAND_MAX_OUTPUT_BYTES) {
          error = new ConfigError(`credential lookup for ${name} exceeded ${COMMAND_MAX_OUTPUT_BYTES} bytes`);
        } else if (error === undefined && !groupStopped) {
          error = new ConfigError(`credential lookup for ${name} could not terminate its process group`);
        } else if (error === undefined && !stdoutDrained) {
          error = new ConfigError(`credential lookup for ${name} left an open output stream`);
        }

        if (error !== undefined) {
          reject(error);
          return;
        }

        const code = exitCode ?? exitInfo?.code ?? null;
        if (code !== 0) {
          reject(new ConfigError(`credential lookup for ${name} exited with code ${String(code)}`));
          return;
        }
        const value = stdout.trim();
        if (value.length === 0) {
          reject(new ConfigError(`credential lookup for ${name} produced no value`));
          return;
        }
        resolve(value);
      })();
    };

    child.once("error", (error) => {
      terminalError = new ConfigError(`could not start credential lookup for ${name}: ${errorMessage(error)}`);
      finalize();
    });
    child.once("exit", (code) => {
      exitInfo = { code };
      finalize(code);
    });
    stdoutStream?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > COMMAND_MAX_OUTPUT_BYTES) {
        if (terminalError === undefined) {
          terminalError = new ConfigError(`credential lookup for ${name} exceeded ${COMMAND_MAX_OUTPUT_BYTES} bytes`);
        }
        finalize();
        return;
      }
      stdout += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      terminalError = new ConfigError(`credential lookup for ${name} timed out after ${COMMAND_TIMEOUT_MS}ms`);
      finalize();
    }, COMMAND_TIMEOUT_MS);

    const onAbort = () => {
      terminalError = new ConfigError(`credential lookup for ${name} was cancelled`);
      finalize();
    };
    if (signal?.aborted === true) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}
