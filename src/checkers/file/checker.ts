import { z } from "zod";
import { errorMessage } from "../../engine/config.ts";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { isMissing, readRunFile, runFileExists, type RunRoot } from "../../engine/workspace.ts";
import { evaluateRegexes } from "./regex.ts";

const MAX_PATTERNS = 100;

const runRelativePath = z
  .string()
  .min(1, "must be a non-empty run-relative path")
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]+/).includes(".."), {
    message: "must be relative to the run workspace without '..' segments",
  });

const patternSchema = z
  .string()
  .min(1, "must not be empty")
  .superRefine((pattern, context) => {
    try {
      new RegExp(pattern);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: `is not a valid regular expression: ${errorMessage(error)}`,
      });
    }
  });

const fileCheckParamsSchema = z
  .strictObject({
    path: runRelativePath,
    exists: z.boolean().optional(),
    matches: z.union([patternSchema, z.array(patternSchema).max(MAX_PATTERNS)]).optional(),
    unchanged: z.literal(true).optional(),
  })
  .superRefine((params, context) => {
    const patternCount =
      params.matches === undefined ? 0 : typeof params.matches === "string" ? 1 : params.matches.length;
    if (params.exists === undefined && params.unchanged === undefined && patternCount === 0) {
      context.addIssue({
        code: "custom",
        message: "needs at least one of exists, matches, or unchanged",
      });
    }
  })
  .transform((params) => {
    const patterns =
      params.matches === undefined ? [] : typeof params.matches === "string" ? [params.matches] : params.matches;
    return {
      path: params.path,
      ...(params.exists === undefined ? {} : { exists: params.exists }),
      ...(params.unchanged === undefined ? {} : { unchanged: params.unchanged }),
      patterns,
      matches: patterns.map((pattern) => new RegExp(pattern)),
    };
  });

type FileCheckParams = z.output<typeof fileCheckParamsSchema>;

/** Declarative workspace file assertions: exists, regex search, unchanged. */
export const fileChecker: CheckerDefinition<FileCheckParams> = {
  type: "file",
  params: fileCheckParamsSchema,
  create() {
    return new FileChecker();
  },
};

class FileChecker implements Checker<FileCheckParams> {
  readonly check = async (parsed: FileCheckParams, context: CheckerContext): Promise<readonly CheckResult[]> => {
    const results: CheckResult[] = [];

    if (parsed.exists !== undefined) {
      results.push(
        await condition(`${parsed.path} ${parsed.exists ? "exists" : "does not exist"}`, async () => {
          const exists = await runFileExists(context.workspace, parsed.path);
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
        content = await readRunFile(context.workspace, parsed.path);
      } catch (error) {
        if (!isMissing(error)) {
          readError = errorMessage(error);
        }
      }

      if (readError !== undefined || content === undefined) {
        for (const pattern of parsed.patterns) {
          const subject = `${parsed.path} matches /${truncate(pattern, 120)}/`;
          results.push(
            readError !== undefined
              ? errorResult(subject, readError)
              : { ...fail(`${parsed.path} does not exist`), subject },
          );
        }
      } else {
        const evaluation = await evaluateRegexes(content.toString("utf8"), parsed.patterns, context.signal);
        for (const [index, pattern] of parsed.patterns.entries()) {
          const subject = `${parsed.path} matches /${truncate(pattern, 120)}/`;
          const compileError = evaluation.errors[index];
          if (compileError !== undefined) {
            results.push(errorResult(subject, `regular expression failed: ${compileError}`));
            continue;
          }
          const matched = evaluation.matched[index];
          if (matched === undefined) {
            results.push(errorResult(subject, evaluation.failure ?? "regular expression did not finish evaluating"));
            continue;
          }
          results.push({ ...(matched ? pass("pattern found") : fail("pattern not found")), subject });
        }
      }
    }

    if (parsed.unchanged === true) {
      results.push(
        await condition(`${parsed.path} unchanged since run start`, async () => {
          const current = await readOptional(context.workspace, parsed.path);
          const baseline = await readOptional(context.baseline, parsed.path);
          if (current === undefined && baseline === undefined) {
            return pass("file is absent in both the run and the initial baseline");
          }
          if (current === undefined) {
            return fail(`${parsed.path} is missing but existed at run start`);
          }
          if (baseline === undefined) {
            return fail(`${parsed.path} was created during the run`);
          }
          return current.equals(baseline)
            ? pass("content matches the initial baseline")
            : fail("content changed during the run");
        }),
      );
    }

    return results;
  };
}

async function readOptional(root: RunRoot, path: string): Promise<Buffer | undefined> {
  try {
    return await readRunFile(root, path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

async function condition(subject: string, body: () => Promise<CheckResult>): Promise<CheckResult> {
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
