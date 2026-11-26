import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError, errorMessage } from "./config.ts";

const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;

/** Run-scoped access to `${env:NAME}` values from the invocation `.env`. */
export interface EnvSource {
  /** Resolve one named value from the invocation `.env`, caching it per run. */
  require(name: string): Promise<string>;
}

/**
 * Create a lazy environment-value source rooted at the invocation working directory.
 * The `.env` file is read only when a value is actually requested.
 */
export function createEnvSource(directory: string, signal?: AbortSignal): EnvSource {
  const file = join(directory, ".env");
  const cache = new Map<string, Promise<string>>();
  let valuesPromise: Promise<Record<string, string | undefined>> | undefined;

  const values = (): Promise<Record<string, string | undefined>> =>
    (valuesPromise ??= (async () => {
      try {
        return parseEnv(await readFile(file, "utf8"));
      } catch (error) {
        throw new ConfigError(`could not load environment file ${file}: ${errorMessage(error)}`);
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
          throw new ConfigError(`environment lookup for ${name} was cancelled`);
        }

        let parsed: Record<string, string | undefined>;
        try {
          parsed = await values();
        } catch (error) {
          throw new ConfigError(`environment value ${name} is unavailable: ${errorMessage(error)}`);
        }
        if (!Object.hasOwn(parsed, name)) {
          throw new ConfigError(`environment value ${name} is not defined in ${file}`);
        }

        const value = parsed[name] ?? "";
        if (value.length === 0) {
          throw new ConfigError(`environment value ${name} is empty in ${file}`);
        }
        if (!value.startsWith("!")) {
          return value;
        }

        const command = value.slice(1).trim();
        if (command.length === 0) {
          throw new ConfigError(`environment value ${name} has an empty lookup command in ${file}`);
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
    throw new ConfigError(`environment lookup for ${name} was cancelled`);
  }

  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      // Spawn in its own process group so abort/timeout kills the shell and any direct child
      // regardless of whether `/bin/sh` exec-optimizes simple commands (dash vs bash).
      const child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timedOut = false;
      let aborted = false;

      const killGroup = (): void => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already exited.
          }
        }
      };

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const onAbort = (): void => {
        aborted = true;
        killGroup();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, COMMAND_TIMEOUT_MS);

      signal?.addEventListener("abort", onAbort, { once: true });

      const onData = (chunk: Buffer, collect: boolean): void => {
        bytes += chunk.length;
        if (bytes > COMMAND_MAX_OUTPUT_BYTES) {
          killGroup();
          finish(() =>
            reject(Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })),
          );
          return;
        }
        if (collect) chunks.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => onData(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => onData(chunk, false));
      child.on("error", (error) => {
        finish(() => reject(error));
      });
      child.on("close", (code, exitSignal) => {
        finish(() => {
          if (aborted) {
            reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
          } else if (timedOut) {
            reject(Object.assign(new Error("timed out"), { killed: true }));
          } else if (code === 0) {
            resolve(Buffer.concat(chunks).toString("utf8"));
          } else if (code !== null) {
            reject(Object.assign(new Error("non-zero exit"), { code }));
          } else {
            reject(Object.assign(new Error("signalled"), { signal: exitSignal ?? "SIGKILL" }));
          }
        });
      });
    });
  } catch (error) {
    throw classifyCommandError(name, error, signal);
  }

  const value = stdout.trim();
  if (value.length === 0) {
    throw new ConfigError(`environment lookup for ${name} produced no value`);
  }
  return value;
}

function classifyCommandError(name: string, error: unknown, signal: AbortSignal | undefined): ConfigError {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  if (signal?.aborted === true || record.code === "ABORT_ERR" || record.name === "AbortError") {
    return new ConfigError(`environment lookup for ${name} was cancelled`);
  }
  if (record.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new ConfigError(`environment lookup for ${name} exceeded ${COMMAND_MAX_OUTPUT_BYTES} bytes`);
  }
  if (record.killed === true) {
    return new ConfigError(`environment lookup for ${name} timed out after ${COMMAND_TIMEOUT_MS}ms`);
  }
  if (typeof record.code === "number") {
    return new ConfigError(`environment lookup for ${name} exited with code ${String(record.code)}`);
  }
  if (typeof record.signal === "string") {
    return new ConfigError(`environment lookup for ${name} exited by signal ${record.signal}`);
  }
  return new ConfigError(
    `could not run environment lookup for ${name}${typeof record.code === "string" ? ` (${record.code})` : ""}`,
  );
}
