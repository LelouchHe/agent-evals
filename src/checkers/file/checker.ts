import { ConfigError, errorMessage, type ImplementationParams } from "../../engine/config.ts";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { isMissing, readRunFile, runFileExists } from "../../engine/workspace.ts";

const FILE_CHECK_KEYS = new Set(["path", "exists", "matches", "unchanged"]);
const MAX_PATTERNS = 100;

interface FileCheckParams {
  readonly path: string;
  readonly exists?: boolean;
  readonly matches?: readonly RegExp[];
  readonly patterns: readonly string[];
  readonly unchanged?: boolean;
}

/** Declarative workspace file assertions: exists, regex search, unchanged. */
export const fileChecker: CheckerDefinition = {
  type: "file",
  validate(params: ImplementationParams): void {
    parseParams(params);
  },
  create(): Checker {
    return new FileChecker();
  },
};

class FileChecker implements Checker {
  async check(params: ImplementationParams, context: CheckerContext): Promise<readonly CheckResult[]> {
    const parsed = parseParams(params);
    const results: CheckResult[] = [];

    if (parsed.exists !== undefined) {
      results.push(
        await condition(`${parsed.path} ${parsed.exists ? "exists" : "does not exist"}`, async () => {
          const exists = await runFileExists(context.workspaceDir, parsed.path);
          if (exists === parsed.exists) {
            return pass(`${parsed.path} ${parsed.exists ? "is a regular file" : "is absent"}`);
          }
          return fail(`${parsed.path} ${exists ? "exists" : "does not exist"}`);
        }),
      );
    }

    if (parsed.patterns.length > 0) {
      let content: Buffer | undefined;
      let readError: string | undefined;
      try {
        content = await readRunFile(context.workspaceDir, parsed.path);
      } catch (error) {
        if (!isMissing(error)) {
          readError = errorMessage(error);
        }
      }
      for (const [index, pattern] of parsed.patterns.entries()) {
        const regex = parsed.matches?.[index];
        const subject = `${parsed.path} matches /${truncate(pattern, 120)}/`;
        if (readError !== undefined) {
          results.push(errorResult(subject, readError));
          continue;
        }
        if (content === undefined) {
          results.push({ ...fail(`${parsed.path} does not exist`), subject });
          continue;
        }
        if (regex === undefined) {
          results.push(errorResult(subject, "regular expression was not compiled"));
          continue;
        }
        regex.lastIndex = 0;
        results.push({
          ...(regex.test(content.toString("utf8")) ? pass("pattern found") : fail("pattern not found")),
          subject,
        });
      }
    }

    if (parsed.unchanged === true) {
      results.push(
        await condition(`${parsed.path} unchanged since run start`, async () => {
          const current = await readOptional(context.workspaceDir, parsed.path);
          const baseline = await readOptional(context.baselineDir, parsed.path);
          if (current === undefined && baseline === undefined) {
            return pass("file is absent in both the run and the initial baseline");
          }
          if (current === undefined) {
            return fail(`${parsed.path} is missing but existed at run start`);
          }
          if (baseline === undefined) {
            return fail(`${parsed.path} was created during the run`);
          }
          return current.equals(baseline) ? pass("content matches the initial baseline") : fail("content changed during the run");
        }),
      );
    }

    return results;
  }
}

function parseParams(params: ImplementationParams): FileCheckParams {
  const unknown = Object.keys(params).filter((key) => !FILE_CHECK_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`file checker has unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }

  const path = params.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new ConfigError("file checker parameter path must be a non-empty string");
  }
  if (path.startsWith("/") || path.split(/[\\/]+/).includes("..")) {
    throw new ConfigError(`file checker path must be relative to the run workspace: ${path}`);
  }

  const exists = params.exists;
  if (exists !== undefined && typeof exists !== "boolean") {
    throw new ConfigError("file checker parameter exists must be a boolean");
  }

  const unchanged = params.unchanged;
  if (unchanged !== undefined && typeof unchanged !== "boolean") {
    throw new ConfigError("file checker parameter unchanged must be a boolean");
  }

  let patterns: string[] = [];
  if (params.matches !== undefined) {
    if (typeof params.matches === "string") {
      patterns = [params.matches];
    } else if (Array.isArray(params.matches) && params.matches.every((item) => typeof item === "string")) {
      patterns = params.matches as string[];
    } else {
      throw new ConfigError("file checker parameter matches must be a string or a list of strings");
    }
    if (patterns.length > MAX_PATTERNS) {
      throw new ConfigError(`file checker matches supports at most ${MAX_PATTERNS} patterns`);
    }
  }

  const matches = patterns.map((pattern, index) => {
    if (pattern.length === 0) {
      throw new ConfigError(`file checker matches[${index}] must not be empty`);
    }
    try {
      return new RegExp(pattern);
    } catch (error) {
      throw new ConfigError(`file checker matches[${index}] is not a valid regular expression: ${errorMessage(error)}`);
    }
  });

  if (exists === undefined && unchanged === undefined && patterns.length === 0) {
    throw new ConfigError("file checker needs at least one of exists, matches, or unchanged");
  }

  return { path, ...(exists === undefined ? {} : { exists }), ...(unchanged === undefined ? {} : { unchanged }), patterns, matches };
}

async function readOptional(rootDir: string, path: string): Promise<Buffer | undefined> {
  try {
    return await readRunFile(rootDir, path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

async function condition(
  subject: string,
  body: () => Promise<CheckResult>,
): Promise<CheckResult> {
  try {
    const result = await body();
    return { ...result, subject };
  } catch (error) {
    return errorResult(subject, errorMessage(error));
  }
}

function pass(reason: string): CheckResult {
  return { checker: "file", subject: "", status: "pass", reason };
}

function fail(reason: string): CheckResult {
  return { checker: "file", subject: "", status: "fail", reason };
}

function errorResult(subject: string, reason: string): CheckResult {
  return { checker: "file", subject, status: "error", reason };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit) + "…";
}
