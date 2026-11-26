import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { z } from "zod";
import { ConfigError, errorMessage, type ImplementationRecord } from "../../engine/config.ts";
import { nonEmptyTrimmedString, runFilePathSchema } from "../../engine/params.ts";
import { truncate } from "../../engine/truncate.ts";
import type {
  CheckResult,
  Checker,
  CheckerContext,
  CheckerDefinition,
  PreparedRunner,
  Runner,
  RunnerContext,
  RunnerOutcome,
} from "../../engine/registry.ts";
import {
  assertRunRoot,
  fileIdentity,
  isMissing,
  isProtectedHomePath,
  readRunFile,
  resolveWorkspacePath,
  type RunRoot,
} from "../../engine/workspace.ts";
import { buildJudgePrompt, type JudgeEvidence } from "./prompt.ts";
import { renderTrace } from "./trace.ts";

/** Where the judge's workspace holds the run's rendered trace. */
const TRACE_PATH = "trace.md";
const GLOB_META = /[*?[\]{}]/u;

function isGlob(path: string): boolean {
  return GLOB_META.test(path);
}

const judgeParamsSchema = z
  .strictObject({
    /** A runner declaration: any runner's own parameters, and the type it names. */
    runner: z.record(z.string(), z.unknown()).transform(runnerDeclaration).optional(),
    rubric: z.array(nonEmptyTrimmedString).min(1, "must contain at least one statement"),
    /** Workspace or `~/` file, directory, or glob paths given as evidence. */
    files: z.array(runFilePathSchema).min(1, "must contain at least one path").optional(),
    /** Give the run's trace as evidence; the runner must record one. */
    trace: z.literal(true).optional(),
  })
  .refine((params) => params.files !== undefined || params.trace !== undefined, {
    message: "needs files, trace or both as evidence",
  });

type JudgeParams = z.output<typeof judgeParamsSchema>;

const verdictSchema = z.object({
  criteria: z.array(
    z.object({
      pass: z.boolean(),
      reason: z.string().refine((value) => value.trim().length > 0, { message: "reason is missing" }),
    }),
  ),
});

export class JudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeError";
  }
}

/**
 * Model judgment of the task against file or trace evidence: the checker stages that evidence in
 * its own workspace and runs the declared runner there. Everything about how the model is
 * reached — harness, model, credentials, tools, sandbox — belongs to that runner.
 */
export const judgeChecker: CheckerDefinition<JudgeParams> = {
  type: "judge",
  params: judgeParamsSchema,
  async create(params, context) {
    const homePath = params.files?.find((entry) => entry.startsWith("~/"));
    if (homePath !== undefined && !context.runnerSupportsHome) {
      throw new ConfigError(
        `judge files path "${homePath}" is in the run HOME, which the selected runner does not provide`,
      );
    }
    return new JudgeChecker(params, await context.createRunner(params.runner));
  },
};

class JudgeChecker implements Checker {
  readonly #params: JudgeParams;
  readonly #judge: PreparedRunner;

  constructor(params: JudgeParams, judge: PreparedRunner) {
    this.#params = params;
    this.#judge = judge;
  }

  readonly check = async (context: CheckerContext): Promise<readonly CheckResult[]> => {
    const parsed = this.#params;
    if (parsed.trace && context.trace === undefined) {
      throw new JudgeError("trace evidence requested, but this runner records no trace");
    }
    const judgeDir = await mkdtemp(join(context.runRootDir, "judge-"));
    try {
      const runnerContext = await prepareRun(parsed, context, judgeDir);
      const { finalText, diagnostics } = await runJudge(this.#judge.runner, runnerContext);
      const judgeLabel = this.#judge.label ?? this.#judge.runner.label ?? this.#judge.type;
      return parseVerdict(finalText, parsed.rubric, diagnostics, judgeLabel);
    } catch (error) {
      if (error instanceof JudgeError) {
        throw error;
      }
      throw new JudgeError(formatInvocationError(error));
    } finally {
      try {
        await rm(judgeDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // The engine removes the containing run root and records any failure there.
      }
    }
  };
}

/**
 * Run the judge's runner once and stop it whatever happens. The abort handler stops it alongside
 * the pending run, as the engine's own path does; a stop that fails after a verdict is part of the
 * result, because a runner that did not tear down cleanly did not judge cleanly either.
 */
async function runJudge(runner: Runner, context: RunnerContext): Promise<RunnerOutcome> {
  if (context.signal.aborted) {
    throw new JudgeError("judge was cancelled before its runner started");
  }
  let outcome: RunnerOutcome | undefined;
  let failure: unknown;
  let failed = false;
  const fail = (error: unknown): void => {
    failure = error;
    failed = true;
  };
  const stopOnAbort = (): void => {
    void runner.stop().catch(() => {});
  };
  context.signal.addEventListener("abort", stopOnAbort, { once: true });
  try {
    await runner.prepareHome?.(context);
    // The only stop a runner may need is the one the abort handler already sent, so a run that
    // starts after cancellation would have nothing left to end it.
    if (context.signal.aborted) {
      throw new JudgeError("judge was cancelled before its runner started");
    }
    outcome = await runner.run(context);
  } catch (error) {
    fail(error);
  } finally {
    context.signal.removeEventListener("abort", stopOnAbort);
    try {
      await runner.stop();
    } catch (error) {
      if (!failed) {
        fail(new JudgeError(`judge teardown failed: ${errorMessage(error)}`));
      }
    }
  }
  if (failed) {
    throw failure;
  }
  // Reaching here means `run` returned, so the outcome is the one it returned.
  return outcome as RunnerOutcome;
}

/** The judge's private run root: empty directories plus the evidence it staged. */
async function prepareRun(params: JudgeParams, context: CheckerContext, judgeDir: string): Promise<RunnerContext> {
  const dirs = {
    workspaceDir: join(judgeDir, "workspace"),
    homeDir: join(judgeDir, "home"),
    configDir: join(judgeDir, "config"),
    tmpDir: join(judgeDir, "tmp"),
    engineDir: join(judgeDir, "engine"),
  };
  await Promise.all(Object.values(dirs).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const evidence = await stageEvidence(params, context, dirs.workspaceDir);
  return {
    ...dirs,
    runRootDir: judgeDir,
    input: buildJudgePrompt({ task: context.input, evidence, rubric: params.rubric }),
    timeoutMs: context.timeoutMs,
    signal: context.signal,
  };
}

/**
 * Copy the requested evidence out of the run and into the judge's workspace under `workspace/` and
 * `home/`, keeping `trace.md` at the root. Files are read through the same regular-file access
 * every checker uses, and runner login state is never exposed to the judge.
 */
async function stageEvidence(
  params: JudgeParams,
  context: CheckerContext,
  workspaceDir: string,
): Promise<readonly JudgeEvidence[]> {
  const evidence: JudgeEvidence[] = [];
  const stagedPaths = new Set<string>();
  const absentPaths = new Set<string>();
  const protectedPaths = context.protectedHome?.paths ?? [];
  const protectedIdentities = new Set(context.protectedHome?.identities ?? []);

  const stageRegularFile = async (
    root: RunRoot,
    rel: string,
    stagedRel: string,
    source: "workspace" | "home",
    declared: string,
  ): Promise<void> => {
    if (context.signal.aborted) {
      throw new JudgeError("judge was cancelled before its runner started");
    }
    const destRel = `${source}/${stagedRel}`;
    if (stagedPaths.has(destRel)) {
      return;
    }
    let content: Buffer;
    try {
      content = await readRunFile(root, rel);
    } catch (error) {
      throw new JudgeError(`could not read judge evidence ${declared}: ${errorMessage(error)}`);
    }
    if (context.signal.aborted) {
      throw new JudgeError("judge was cancelled before its runner started");
    }
    const target = join(workspaceDir, destRel);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
    stagedPaths.add(destRel);
    evidence.push({ path: destRel, kind: "file", present: true, source });
  };

  for (const entry of params.files ?? []) {
    if (context.signal.aborted) {
      throw new JudgeError("judge was cancelled before its runner started");
    }
    const isHome = entry.startsWith("~/");
    const source: "workspace" | "home" = isHome ? "home" : "workspace";
    const root = isHome ? context.home : context.workspace;
    const rawRel = isHome ? entry.slice(2) : entry;

    if (isGlob(rawRel)) {
      const matched = await matchGlobFiles(root, rawRel, context.signal, {
        isHome,
        protectedPaths,
        protectedIdentities,
      });
      if (matched.length === 0) {
        evidence.push({ path: entry, kind: "glob", present: false, source });
      } else {
        for (const fileRel of matched) {
          await stageRegularFile(root, fileRel, fileRel, source, entry);
        }
      }
      continue;
    }

    const normalized = stagedPath(rawRel);
    if (isHome && isProtectedHomePath(normalized, protectedPaths)) {
      throw new JudgeError(`refusing to stage protected file: ${entry}`);
    }

    let resolved: string;
    try {
      resolved = await resolveWorkspacePath(root, rawRel);
    } catch (error) {
      throw new JudgeError(`could not read judge evidence ${entry}: ${errorMessage(error)}`);
    }

    let info;
    try {
      info = await lstat(resolved, { bigint: true });
    } catch (error) {
      if (isMissing(error)) {
        const destRel = normalized === "." ? source : `${source}/${normalized}`;
        if (!absentPaths.has(destRel)) {
          absentPaths.add(destRel);
          evidence.push({ path: destRel, kind: "file", present: false, source });
        }
        continue;
      }
      throw new JudgeError(`could not read judge evidence ${entry}: ${errorMessage(error)}`);
    }

    const resolvedRel = relative(root.path, resolved).split(sep).join("/");
    if (isHome && resolvedRel.length > 0 && isProtectedHomePath(resolvedRel, protectedPaths)) {
      throw new JudgeError(`refusing to stage protected file: ${entry}`);
    }

    if (info.isFile()) {
      if (protectedIdentities.has(fileIdentity(info))) {
        throw new JudgeError(`refusing to stage protected file: ${entry}`);
      }
      await stageRegularFile(root, rawRel, normalized, source, entry);
    } else if (info.isDirectory()) {
      const dirFiles = await collectDirectoryFiles(
        root,
        resolved,
        normalized === "." ? "" : normalized,
        context.signal,
        {
          isHome,
          protectedPaths,
          protectedIdentities,
        },
      );
      if (dirFiles.length === 0) {
        evidence.push({
          path: normalized === "." ? source : `${source}/${normalized}`,
          kind: "directory",
          present: true,
          source,
        });
      } else {
        for (const fileRel of dirFiles) {
          await stageRegularFile(root, fileRel, fileRel, source, entry);
        }
      }
    } else {
      throw new JudgeError(`could not read judge evidence ${entry}: not a regular file or directory`);
    }
  }

  if (params.trace) {
    await writeFile(join(workspaceDir, TRACE_PATH), `${renderTrace(context.trace!)}\n`, { mode: 0o600 });
    evidence.push({ path: TRACE_PATH, kind: "trace", present: true });
  }
  return evidence;
}

interface StagingFilter {
  readonly isHome: boolean;
  readonly protectedPaths: readonly string[];
  readonly protectedIdentities: ReadonlySet<string>;
}

/** Collect regular files under a directory in sorted order, skipping symlinks and protected files. */
async function collectDirectoryFiles(
  root: RunRoot,
  dirAbs: string,
  relPrefix: string,
  signal: AbortSignal,
  filter: StagingFilter,
  shouldDescend: (dirRel: string) => boolean = () => true,
): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (currentAbs: string, prefix: string): Promise<void> => {
    if (signal.aborted) {
      throw new JudgeError("judge was cancelled before its runner started");
    }
    const names = (await readdir(currentAbs)).sort();
    for (const name of names) {
      if (signal.aborted) {
        throw new JudgeError("judge was cancelled before its runner started");
      }
      const childRel = prefix === "" ? name : `${prefix}/${name}`;
      const childAbs = join(currentAbs, name);
      if (filter.isHome) {
        const canonicalRel = relative(root.path, childAbs).split(sep).join("/");
        if (
          isProtectedHomePath(childRel, filter.protectedPaths) ||
          isProtectedHomePath(canonicalRel, filter.protectedPaths)
        ) {
          continue;
        }
      }
      let info;
      try {
        info = await lstat(childAbs, { bigint: true });
      } catch (error) {
        if (isMissing(error)) continue;
        throw new JudgeError(`could not inspect judge evidence ${childRel}: ${errorMessage(error)}`);
      }
      if (info.isFile()) {
        if (filter.protectedIdentities.has(fileIdentity(info))) continue;
        files.push(childRel);
      } else if (info.isDirectory() && shouldDescend(childRel)) {
        await visit(childAbs, childRel);
      }
      // Symlinks and special files are skipped so an agent-created link cannot pull outside files.
    }
  };
  await visit(dirAbs, relPrefix);
  return files;
}

/** Resolve regular files matching a glob pattern, skipping symlinks and protected files. */
async function matchGlobFiles(
  root: RunRoot,
  pattern: string,
  signal: AbortSignal,
  filter: StagingFilter,
): Promise<readonly string[]> {
  await assertRunRoot(root);
  const normalized = posix.normalize(pattern).replace(/\/+$/u, "");
  const segments = normalized.split("/");
  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (isGlob(segment)) break;
    staticSegments.push(segment);
  }
  // Walk the static prefix without following symlinks so prefix symlinks are skipped just like
  // symlinks encountered below the wildcard.
  let startAbs = root.path;
  let prefixRel = "";
  for (const segment of staticSegments) {
    if (signal.aborted) {
      throw new JudgeError("judge was cancelled before its runner started");
    }
    prefixRel = prefixRel === "" ? segment : `${prefixRel}/${segment}`;
    if (filter.isHome && isProtectedHomePath(prefixRel, filter.protectedPaths)) {
      return [];
    }
    startAbs = join(startAbs, segment);
    let info;
    try {
      info = await lstat(startAbs, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw new JudgeError(`could not inspect judge evidence ${prefixRel}: ${errorMessage(error)}`);
    }
    if (!info.isDirectory()) {
      return [];
    }
  }

  const pruneDepth = !segments.includes("**") && !normalized.includes("{");
  const shouldDescend = (dirRel: string): boolean => {
    if (!pruneDepth) return true;
    const depth = dirRel.split("/").length;
    if (depth >= segments.length) return false;
    return posix.matchesGlob(dirRel, segments.slice(0, depth).join("/"));
  };

  const allFiles = await collectDirectoryFiles(root, startAbs, prefixRel, signal, filter, shouldDescend);
  return allFiles.filter((fileRel) => posix.matchesGlob(fileRel, normalized));
}

/**
 * The run-relative path as the judge's workspace will hold it: POSIX segments, no `.` segments and
 * no trailing separator, which is also the path the prompt advertises. A backslash is filename
 * data on this platform, so it is left alone.
 */
function stagedPath(path: string): string {
  return posix.normalize(path).replace(/\/+$/u, "");
}

function runnerDeclaration(record: Record<string, unknown>, context: z.RefinementCtx): ImplementationRecord {
  const type = record.$type;
  if (typeof type !== "string" || type.trim().length === 0) {
    context.addIssue({ code: "custom", message: 'must name the runner "$type"' });
    return z.NEVER;
  }
  return record as ImplementationRecord;
}

function parseVerdict(
  text: string | null,
  rubric: readonly string[],
  diagnostics: readonly string[],
  judgeLabel: string,
): CheckResult[] {
  if (text === null) {
    throw new JudgeError(withDiagnostics("judge produced no assistant text", diagnostics));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (error) {
    throw new JudgeError(withDiagnostics(`invalid judge verdict: ${errorMessage(error)}`, diagnostics));
  }
  const verdict = verdictSchema.safeParse(parsed);
  if (!verdict.success) {
    const issue = verdict.error.issues[0];
    const detail =
      issue === undefined ? "invalid shape" : `${issue.path.map(String).join(".") || "verdict"}: ${issue.message}`;
    throw new JudgeError(withDiagnostics(`invalid judge verdict: ${detail}`, diagnostics));
  }
  const criteria = verdict.data.criteria;
  if (criteria.length !== rubric.length) {
    throw new JudgeError(
      withDiagnostics(
        `invalid judge verdict: expected ${rubric.length} criteria, received ${criteria.length}`,
        diagnostics,
      ),
    );
  }

  return criteria.map((entry, index) => ({
    checker: "judge",
    subject: rubric[index] ?? "",
    status: entry.pass ? "pass" : "fail",
    reason: truncate(`[${judgeLabel}] ${entry.reason.trim()}`, 500),
  }));
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    return fenced[1];
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return trimmed;
  }
  return trimmed.slice(start, end + 1);
}

function formatInvocationError(error: unknown): string {
  const diagnostic = diagnosticsOf(error)[0];
  const base = `judge invocation failed: ${errorMessage(error)}`;
  return diagnostic === undefined ? base : truncate(`${base} (${diagnostic})`, 800);
}

function diagnosticsOf(error: unknown): readonly string[] {
  if (typeof error !== "object" || error === null || !("diagnostics" in error)) {
    return [];
  }
  const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
  return Array.isArray(diagnostics) ? diagnostics.filter((entry) => typeof entry === "string") : [];
}

function withDiagnostics(message: string, diagnostics: readonly string[]): string {
  return diagnostics.length === 0 ? message : truncate(`${message} (${diagnostics[0]})`, 800);
}
