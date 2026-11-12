import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError, errorMessage } from "./config.ts";

const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;

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

  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "/bin/sh",
        ["-c", command],
        {
          cwd,
          env: process.env,
          encoding: "utf8",
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: COMMAND_MAX_OUTPUT_BYTES,
          signal,
          killSignal: "SIGKILL",
        },
        (error, output) => {
          if (error === null) {
            resolve(output);
          } else {
            reject(error);
          }
        },
      );
    });
  } catch (error) {
    throw classifyCommandError(name, error, signal);
  }

  const value = stdout.trim();
  if (value.length === 0) {
    throw new ConfigError(`credential lookup for ${name} produced no value`);
  }
  return value;
}

function classifyCommandError(name: string, error: unknown, signal: AbortSignal | undefined): ConfigError {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  if (signal?.aborted === true || record.code === "ABORT_ERR" || record.name === "AbortError") {
    return new ConfigError(`credential lookup for ${name} was cancelled`);
  }
  if (record.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new ConfigError(`credential lookup for ${name} exceeded ${COMMAND_MAX_OUTPUT_BYTES} bytes`);
  }
  if (record.killed === true) {
    return new ConfigError(`credential lookup for ${name} timed out after ${COMMAND_TIMEOUT_MS}ms`);
  }
  if (typeof record.code === "number") {
    return new ConfigError(`credential lookup for ${name} exited with code ${String(record.code)}`);
  }
  if (typeof record.signal === "string") {
    return new ConfigError(`credential lookup for ${name} exited by signal ${record.signal}`);
  }
  return new ConfigError(
    `could not run credential lookup for ${name}${typeof record.code === "string" ? ` (${record.code})` : ""}`,
  );
}
