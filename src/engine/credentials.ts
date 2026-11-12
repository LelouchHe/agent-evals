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

    let stdout = "";
    let outputBytes = 0;
    let exitInfo: { readonly code: number | null } | undefined;
    let settled = false;
    let stopPromise: Promise<void> | undefined;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };

    const waitForExit = (timeoutMs: number): Promise<boolean> => {
      if (exitInfo !== undefined) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolveExit) => {
        const timeout = setTimeout(() => {
          child.off("exit", onExit);
          resolveExit(false);
        }, timeoutMs);
        function onExit(): void {
          clearTimeout(timeout);
          resolveExit(true);
        }
        child.once("exit", onExit);
      });
    };

    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        if (exitInfo !== undefined) {
          return;
        }
        signalGroup("SIGTERM");
        if (await waitForExit(COMMAND_STOP_GRACE_MS)) {
          // The group leader exited; also clear any owned descendants.
          signalGroup("SIGKILL");
          return;
        }
        signalGroup("SIGKILL");
        if (await waitForExit(COMMAND_REAP_MS)) {
          return;
        }
        child.unref();
      })();
      return stopPromise;
    };

    const settle = (error: Error | undefined, value?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve(value ?? "");
        return;
      }
      void stop().finally(() => reject(error));
    };

    child.once("error", (error) => {
      settle(new ConfigError(`could not start credential lookup for ${name}: ${errorMessage(error)}`));
    });
    child.once("exit", (code) => {
      exitInfo = { code };
      if (code === 0) {
        const value = stdout.trim();
        settle(
          value.length === 0 ? new ConfigError(`credential lookup for ${name} produced no value`) : undefined,
          value,
        );
      } else {
        settle(new ConfigError(`credential lookup for ${name} exited with code ${String(code)}`));
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > COMMAND_MAX_OUTPUT_BYTES) {
        settle(new ConfigError(`credential lookup for ${name} exceeded ${COMMAND_MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      stdout += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      settle(new ConfigError(`credential lookup for ${name} timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    const onAbort = () => settle(new ConfigError(`credential lookup for ${name} was cancelled`));
    if (signal?.aborted === true) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}
