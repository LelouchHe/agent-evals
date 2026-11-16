import { z } from "zod";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { patternSyntaxSchema, runRelativePathSchema } from "../../engine/params.ts";
import { truncate } from "../../engine/truncate.ts";
import { searches } from "../../engine/regex.ts";
import { isMissing, readRunFile, runFileExists, type RunRoot } from "../../engine/workspace.ts";
import { errorMessage, type PatternSyntax } from "../../engine/config.ts";

const MAX_PATTERNS = 100;

/** One pattern or a non-empty list of them, normalized to a list in declaration order. */
const patternListSchema = z.unknown().transform((value, context): readonly PatternSyntax[] => {
  if (Array.isArray(value) && value.length === 0) {
    context.addIssue({ code: "custom", message: "must hold at least one pattern" });
    return [];
  }
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > MAX_PATTERNS) {
    context.addIssue({ code: "custom", message: `must hold at most ${MAX_PATTERNS} patterns` });
    return [];
  }
  const listed = Array.isArray(value);
  return entries.flatMap((entry, index) => {
    const parsed = patternSyntaxSchema.safeParse(entry);
    if (parsed.success) {
      return [parsed.data];
    }
    // A scalar names the field itself; only a list entry needs its position.
    const path = listed ? [index] : [];
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: "custom", path: [...path, ...issue.path], message: issue.message });
    }
    return [];
  });
});

const fileCheckParamsSchema = z
  .strictObject({
    path: runRelativePathSchema,
    exists: z.boolean().optional(),
    changed: z.boolean().optional(),
    matches: patternListSchema.optional(),
    notMatches: patternListSchema.optional(),
  })
  .superRefine((params, context) => {
    if (
      params.exists === undefined &&
      params.changed === undefined &&
      params.matches === undefined &&
      params.notMatches === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "needs at least one of exists, changed, matches, or notMatches",
      });
    }
  })
  .transform((params) => ({
    path: params.path,
    ...(params.exists === undefined ? {} : { exists: params.exists }),
    ...(params.changed === undefined ? {} : { changed: params.changed }),
    matches: params.matches ?? [],
    notMatches: params.notMatches ?? [],
  }));

type FileCheckParams = z.output<typeof fileCheckParamsSchema>;

/** Declarative workspace file assertions: exists, changed, matches, notMatches. */
export const fileChecker: CheckerDefinition<FileCheckParams> = {
  type: "file",
  params: fileCheckParamsSchema,
  create(params) {
    return new FileChecker(params);
  },
};

/** One declared pattern and whether it must be found or must be absent. */
interface DeclaredPattern {
  readonly kind: "matches" | "notMatches";
  readonly pattern: PatternSyntax;
}

class FileChecker implements Checker {
  readonly #params: FileCheckParams;

  constructor(params: FileCheckParams) {
    this.#params = params;
  }

  readonly check = async (context: CheckerContext): Promise<readonly CheckResult[]> => {
    const params = this.#params;
    const results: CheckResult[] = [];

    if (params.exists !== undefined) {
      const expected = params.exists;
      results.push(
        await condition(`${params.path} ${expected ? "exists" : "does not exist"}`, async () => {
          const exists = await runFileExists(context.workspace, params.path);
          if (exists === expected) {
            return pass(`${params.path} ${expected ? "is a regular file" : "is absent"}`);
          }
          return fail(`${params.path} ${exists ? "exists" : "does not exist"}`);
        }),
      );
    }

    if (params.changed !== undefined) {
      results.push(await this.#changed(context, params.changed));
    }

    const declared: DeclaredPattern[] = [
      ...params.matches.map((pattern) => ({ kind: "matches" as const, pattern })),
      ...params.notMatches.map((pattern) => ({ kind: "notMatches" as const, pattern })),
    ];
    if (declared.length > 0) {
      results.push(...(await this.#patterns(context, declared)));
    }

    return results;
  };

  async #changed(context: CheckerContext, expected: boolean): Promise<CheckResult> {
    const { path } = this.#params;
    return condition(`${path} ${expected ? "changed" : "unchanged"} since run start`, async () => {
      const current = await readOptional(context.workspace, path);
      const baseline = await readOptional(context.baseline, path);
      const change =
        current === undefined
          ? baseline === undefined
            ? "absent"
            : "removed"
          : baseline === undefined
            ? "created"
            : current.equals(baseline)
              ? "same"
              : "modified";
      const reasons = {
        absent: "the file is absent in both the run and the initial baseline",
        created: `${path} was created during the run`,
        removed: `${path} was removed during the run`,
        modified: "content changed during the run",
        same: "content matches the initial baseline",
      } as const;
      const isChanged = change === "created" || change === "removed" || change === "modified";
      return (isChanged === expected ? pass : fail)(reasons[change]);
    });
  }

  /**
   * Read the file once for every declared pattern. A missing file fails both kinds: a restraint
   * check must not pass because the agent wrote nothing at all.
   */
  async #patterns(context: CheckerContext, declared: readonly DeclaredPattern[]): Promise<CheckResult[]> {
    const { path } = this.#params;
    let text: string | undefined;
    let readError: string | undefined;
    try {
      text = (await readRunFile(context.workspace, path)).toString("utf8");
    } catch (error) {
      if (!isMissing(error)) {
        readError = errorMessage(error);
      }
    }

    return declared.map(({ kind, pattern }) => {
      const subject = `${path} ${kind === "matches" ? "matches" : "does not match"} ${display(pattern)}`;
      if (readError !== undefined) {
        return errorResult(subject, readError);
      }
      if (text === undefined) {
        return { ...fail(`${path} does not exist`), subject };
      }
      const found = pattern.regex ? searches(pattern.source, text) : text.includes(pattern.source);
      const reason = found ? "pattern found" : "pattern not found";
      return { ...(found === (kind === "matches") ? pass : fail)(reason), subject };
    });
  }
}

/** A literal in quotes, or a regex between slashes, so the subject says which pattern was used. */
function display(pattern: PatternSyntax): string {
  return pattern.regex ? `/${truncate(pattern.source, 120)}/` : `"${truncate(pattern.source, 120)}"`;
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
