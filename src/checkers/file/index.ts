import { lstat, readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { z } from "zod";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { patternListSchema, runRelativePathSchema } from "../../engine/params.ts";
import { truncate } from "../../engine/truncate.ts";
import { searches } from "../../engine/regex.ts";
import {
  WorkspacePathError,
  assertRunRoot,
  isMissing,
  readRunFile,
  readRunTree,
  resolveWorkspacePath,
  runPathExists,
  type RunRoot,
  type RunTree,
} from "../../engine/workspace.ts";
import { ConfigError, errorMessage, type PatternSyntax } from "../../engine/config.ts";

const GLOB_META = /[*?[\]{}]/u;

function isGlob(path: string): boolean {
  return GLOB_META.test(path);
}

/** A workspace path, or `~/…` for a file in the run HOME. `~/` alone names HOME, not a file. */
const filePathSchema = runRelativePathSchema.superRefine((value, context) => {
  if (value === "~/" || value === "~/.") {
    context.addIssue({ code: "custom", message: "must name a file or directory inside HOME, not HOME itself" });
  }
});

const fileCheckParamsSchema = z
  .strictObject({
    path: filePathSchema,
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
    if (isGlob(params.path) && params.changed !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["changed"],
        message: "changed does not support glob patterns; name a specific file or directory",
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
  create(params, context) {
    if (params.path.startsWith("~/") && !context.runnerSupportsHome) {
      throw new ConfigError(
        `file check path "${params.path}" is in the run HOME, which the selected runner does not provide`,
      );
    }
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
    const target = this.#target(context);
    const results: CheckResult[] = [];
    const declared: DeclaredPattern[] = [
      ...params.matches.map((pattern) => ({ kind: "matches" as const, pattern })),
      ...params.notMatches.map((pattern) => ({ kind: "notMatches" as const, pattern })),
    ];

    if (isGlob(params.path)) {
      return this.#checkGlob(target, declared, context.signal);
    }

    if (params.exists !== undefined) {
      const expected = params.exists;
      results.push(
        await condition(`${params.path} ${expected ? "exists" : "does not exist"}`, async () => {
          const exists = await runPathExists(target.root, target.relative);
          if (exists === expected) {
            return pass(`${params.path} ${expected ? "exists" : "is absent"}`);
          }
          return fail(`${params.path} ${exists ? "exists" : "does not exist"}`);
        }),
      );
    }

    if (params.changed !== undefined) {
      results.push(await this.#changed(context, params.changed));
    }

    if (declared.length > 0) {
      results.push(...(await this.#patterns(context, declared)));
    }

    return results;
  };

  async #checkGlob(
    target: { readonly root: RunRoot; readonly relative: string },
    declared: readonly DeclaredPattern[],
    signal: AbortSignal,
  ): Promise<readonly CheckResult[]> {
    const params = this.#params;
    const results: CheckResult[] = [];
    let matched: GlobMatches | undefined;
    let globError: string | undefined;
    try {
      matched = await resolveGlobMatches(target.root, target.relative, signal);
    } catch (error) {
      globError = errorMessage(error);
    }

    const prefix = params.path.startsWith("~/") ? "~/" : "";

    if (params.exists !== undefined) {
      const expected = params.exists;
      const subject = `${params.path} ${expected ? "exists" : "does not exist"}`;
      if (globError !== undefined || matched === undefined) {
        results.push(errorResult(subject, globError ?? "glob resolution failed"));
      } else {
        const found = matched.all.length > 0;
        const reason = found
          ? `matched ${matched.all.length} path(s), e.g. ${prefix}${matched.all[0]}`
          : `no paths matched ${params.path}`;
        results.push({ ...(found === expected ? pass : fail)(reason), subject });
      }
    }

    if (declared.length === 0) {
      return results;
    }

    if (globError !== undefined || matched === undefined) {
      for (const { kind, pattern } of declared) {
        results.push(
          errorResult(
            `${params.path} ${kind === "matches" ? "matches" : "does not match"} ${display(pattern)}`,
            globError ?? "glob resolution failed",
          ),
        );
      }
      return results;
    }

    if (matched.files.length === 0) {
      for (const { kind, pattern } of declared) {
        const subject = `${params.path} ${kind === "matches" ? "matches" : "does not match"} ${display(pattern)}`;
        results.push({ ...fail(`no files matched ${params.path}`), subject });
      }
      return results;
    }

    // Stream matched files one at a time so aggregate memory stays bounded by one file.
    const hits: (string | undefined)[] = new Array(declared.length).fill(undefined);
    let readError: string | undefined;
    try {
      for (const rel of matched.files) {
        if (signal.aborted) {
          throw new Error("check cancelled");
        }
        const text = (await readRunFile(target.root, rel)).toString("utf8");
        const displayPath = `${prefix}${rel}`;
        for (const [index, { pattern }] of declared.entries()) {
          if (hits[index] !== undefined) continue;
          const found = pattern.regex ? searches(pattern.source, text) : text.includes(pattern.source);
          if (found) hits[index] = displayPath;
        }
        if (hits.every((hit) => hit !== undefined)) break;
      }
    } catch (error) {
      readError = errorMessage(error);
    }

    for (const [index, { kind, pattern }] of declared.entries()) {
      const subject = `${params.path} ${kind === "matches" ? "matches" : "does not match"} ${display(pattern)}`;
      if (readError !== undefined) {
        results.push(errorResult(subject, readError));
        continue;
      }
      const hit = hits[index];
      const found = hit !== undefined;
      const reason = found ? `pattern found in ${hit}` : `pattern not found in ${matched.files.length} matched file(s)`;
      results.push({ ...(found === (kind === "matches") ? pass : fail)(reason), subject });
    }

    return results;
  }

  async #changed(context: CheckerContext, expected: boolean): Promise<CheckResult> {
    const { path } = this.#params;
    const target = this.#target(context);
    return condition(`${path} ${expected ? "changed" : "unchanged"} since run start`, async () => {
      const [current, baseline] = await Promise.all([
        readRunTree(target.root, target.relative),
        readRunTree(target.baseline, target.relative),
      ]);
      const changes = await diffTrees(
        { root: target.baseline, relative: target.relative, entries: baseline },
        { root: target.root, relative: target.relative, entries: current },
      );
      const isChanged = changes.length > 0;
      return (isChanged === expected ? pass : fail)(describeChanges(path, baseline, current, changes));
    });
  }

  /**
   * Read the file once for every declared pattern. A missing file fails both kinds: a restraint
   * check must not pass because the agent wrote nothing at all.
   */
  async #patterns(context: CheckerContext, declared: readonly DeclaredPattern[]): Promise<CheckResult[]> {
    const { path } = this.#params;
    const target = this.#target(context);
    let text: string | undefined;
    let readError: string | undefined;
    try {
      text = (await readRunFile(target.root, target.relative)).toString("utf8");
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

  /** Which run root a declared path names, and the path inside it. */
  #target(context: CheckerContext): { readonly root: RunRoot; readonly baseline: RunRoot; readonly relative: string } {
    const { path } = this.#params;
    return path.startsWith("~/")
      ? { root: context.home, baseline: context.homeBaseline, relative: path.slice(2) }
      : { root: context.workspace, baseline: context.baseline, relative: path };
  }
}

interface GlobMatches {
  readonly all: readonly string[];
  readonly files: readonly string[];
}

async function resolveGlobMatches(root: RunRoot, pattern: string, signal: AbortSignal): Promise<GlobMatches> {
  await assertRunRoot(root);
  const normalized = pattern.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
  const segments = normalized.split("/");
  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (isGlob(segment)) break;
    staticSegments.push(segment);
  }
  const baseDir = staticSegments.length === 0 ? "." : staticSegments.join("/");
  const startAbs = baseDir === "." ? root.path : await resolveWorkspacePath(root, baseDir);
  let startStats;
  try {
    startStats = await lstat(startAbs);
  } catch (error) {
    if (isMissing(error)) return { all: [], files: [] };
    throw new WorkspacePathError(`could not inspect ${baseDir}: ${errorMessage(error)}`);
  }
  if (!startStats.isDirectory()) {
    return { all: [], files: [] };
  }

  const all: string[] = [];
  const files: string[] = [];

  const visit = async (dirAbs: string, relPrefix: string): Promise<void> => {
    if (signal.aborted) {
      throw new Error("check cancelled");
    }
    const names = (await readdir(dirAbs)).sort();
    for (const name of names) {
      if (signal.aborted) {
        throw new Error("check cancelled");
      }
      const childAbs = join(dirAbs, name);
      const relative = relPrefix === "" ? name : `${relPrefix}/${name}`;
      let info;
      try {
        info = await lstat(childAbs);
      } catch (error) {
        if (isMissing(error)) continue;
        throw new WorkspacePathError(`could not inspect ${relative}: ${errorMessage(error)}`);
      }
      if (posix.matchesGlob(relative, normalized)) {
        if (info.isFile()) {
          all.push(relative);
          files.push(relative);
        } else if (info.isDirectory()) {
          all.push(relative);
        } else if (info.isSymbolicLink()) {
          // Validate symlinks with the exact-path rules: escaping/broken links and special targets error.
          const resolved = await resolveWorkspacePath(root, relative);
          const targetInfo = await stat(resolved);
          if (targetInfo.isFile()) {
            all.push(relative);
            files.push(relative);
          } else if (targetInfo.isDirectory()) {
            all.push(relative);
          } else {
            throw new WorkspacePathError(`not a regular file or directory: ${relative}`);
          }
        } else {
          throw new WorkspacePathError(`not a regular file or directory: ${relative}`);
        }
      }
      if (info.isDirectory()) {
        await visit(childAbs, relative);
      }
    }
  };

  await visit(startAbs, baseDir === "." ? "" : baseDir);
  return { all, files };
}

/** One differing path between the run and its baseline. */
interface TreeChange {
  readonly kind: "added" | "removed" | "modified";
  readonly path: string;
}

/** One side of a comparison: the root it names, its path, and its snapshot when it exists. */
interface TreeSide {
  readonly root: RunRoot;
  readonly relative: string;
  readonly entries: RunTree | undefined;
}

/**
 * Every path that differs, sorted; the root is `""`, so a replaced path is one change.
 * Files are compared one pair at a time, so peak memory follows the check's per-file
 * cap rather than the size of the tree.
 */
async function diffTrees(baseline: TreeSide, current: TreeSide): Promise<readonly TreeChange[]> {
  if (baseline.entries === undefined || current.entries === undefined) {
    const present = current.entries === undefined ? baseline : current;
    if (present.entries === undefined) {
      return [];
    }
    const kind = current.entries === undefined ? "removed" : "added";
    return [...present.entries.keys()].sort().map((path) => ({ kind, path }));
  }

  const changes: TreeChange[] = [];
  const paths = [...new Set([...baseline.entries.keys(), ...current.entries.keys()])].sort();
  for (const path of paths) {
    const before = baseline.entries.get(path);
    const after = current.entries.get(path);
    if (before === undefined) {
      changes.push({ kind: "added", path });
    } else if (after === undefined) {
      changes.push({ kind: "removed", path });
    } else if (before.kind !== after.kind || before.size !== after.size) {
      changes.push({ kind: "modified", path });
    } else if (before.kind === "file" && !(await sameContent(baseline, current, path))) {
      changes.push({ kind: "modified", path });
    }
  }
  return changes;
}

/** Compare two files with equal size by their bytes, read one pair at a time. */
async function sameContent(baseline: TreeSide, current: TreeSide, path: string): Promise<boolean> {
  const [before, after] = await Promise.all([
    readRunFile(baseline.root, runPath(baseline.relative, path)),
    readRunFile(current.root, runPath(current.relative, path)),
  ]);
  return before.equals(after);
}

/** The run-relative path of `path` under a compared path: `""` is the compared path itself. */
function runPath(relative: string, path: string): string {
  return path === "" ? relative : relative === "" ? path : `${relative}/${path}`;
}

/** Why the comparison held, keeping a single file's wording and summarizing a tree. */
function describeChanges(
  path: string,
  baseline: RunTree | undefined,
  current: RunTree | undefined,
  changes: readonly TreeChange[],
): string {
  if (changes.length === 0) {
    return current === undefined
      ? "the file is absent in both the run and the initial baseline"
      : "content matches the initial baseline";
  }

  const [only] = changes;
  if (changes.length === 1 && only !== undefined && only.path === "") {
    if (only.kind === "added") {
      return `${path} was created during the run`;
    }
    if (only.kind === "removed") {
      return `${path} was removed during the run`;
    }
    const beforeKind = baseline?.get("")?.kind ?? "absent";
    const afterKind = current?.get("")?.kind ?? "absent";
    return beforeKind === "file" && afterKind === "file"
      ? "content changed during the run"
      : `${path} changed from a ${beforeKind} to a ${afterKind}`;
  }

  const shown = changes
    .slice(0, 5)
    .map((change) => `${change.kind} ${change.path === "" ? "." : change.path}`)
    .join(", ");
  const rest = changes.length > 5 ? `, and ${changes.length - 5} more` : "";
  const count = `${changes.length} change${changes.length === 1 ? "" : "s"}`;
  return truncate(`${count}: ${shown}${rest}`, 300);
}

/** A literal in quotes, or a regex between slashes, so the subject says which pattern was used. */
function display(pattern: PatternSyntax): string {
  return pattern.regex ? `/${truncate(pattern.source, 120)}/` : `"${truncate(pattern.source, 120)}"`;
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
