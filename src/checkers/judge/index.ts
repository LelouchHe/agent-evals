import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { errorMessage, type ImplementationRecord } from "../../engine/config.ts";
import { nonEmptyTrimmedString, runRelativePathSchema } from "../../engine/params.ts";
import { truncate } from "../../engine/truncate.ts";
import type {
  CheckResult,
  Checker,
  CheckerContext,
  CheckerDefinition,
  PreparedRunner,
  RunnerContext,
} from "../../engine/registry.ts";
import { isMissing, readRunFile } from "../../engine/workspace.ts";
import { buildJudgePrompt, type JudgeEvidence } from "./prompt.ts";
import { renderTrace } from "./trace.ts";

/** Where the judge's workspace holds the run's rendered trace. */
const TRACE_PATH = "trace.md";

const judgeParamsSchema = z
  .strictObject({
    /** A runner declaration: any runner's own parameters, and the type it names. */
    runner: z.record(z.string(), z.unknown()).transform(runnerDeclaration).optional(),
    rubric: z.array(nonEmptyTrimmedString).min(1, "must contain at least one statement"),
    /** A workspace file given as evidence. */
    file: runRelativePathSchema.optional(),
    /** Give the run's trace as evidence; the runner must record one. */
    trace: z.literal(true).optional(),
  })
  .refine((params) => params.file !== undefined || params.trace !== undefined, {
    message: "needs file, trace or both as evidence",
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
      const runner = this.#judge.runner;
      let finalText: string | null;
      let diagnostics: readonly string[];
      try {
        await runner.prepareHome?.(runnerContext);
        ({ finalText, diagnostics } = await runner.run(runnerContext));
      } finally {
        // The judge's verdict stands; its private run root is removed either way.
        await runner.stop().catch(() => {});
      }
      return parseVerdict(finalText, parsed.rubric, diagnostics);
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
 * Copy the requested evidence out of the run and into the judge's workspace. The evaluated
 * workspace is read once, through the same regular-file evidence access every checker uses, so a
 * run can never hand the judge a path it replaced.
 */
async function stageEvidence(
  params: JudgeParams,
  context: CheckerContext,
  workspaceDir: string,
): Promise<readonly JudgeEvidence[]> {
  const evidence: JudgeEvidence[] = [];
  if (params.file !== undefined) {
    const path = params.file;
    let content: Buffer | null = null;
    try {
      content = await readRunFile(context.workspace, path);
    } catch (error) {
      if (!isMissing(error)) {
        throw new JudgeError(`could not read judge evidence ${path}: ${errorMessage(error)}`);
      }
    }
    if (content !== null) {
      const target = join(workspaceDir, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600 });
    }
    evidence.push({ path, kind: "file", present: content !== null });
  }
  if (params.trace) {
    await writeFile(join(workspaceDir, TRACE_PATH), `${renderTrace(context.trace!)}\n`, { mode: 0o600 });
    evidence.push({ path: TRACE_PATH, kind: "trace", present: true });
  }
  return evidence;
}

function runnerDeclaration(record: Record<string, unknown>, context: z.RefinementCtx): ImplementationRecord {
  const type = record.$type;
  if (typeof type !== "string" || type.trim().length === 0) {
    context.addIssue({ code: "custom", message: 'must name the runner "$type"' });
    return z.NEVER;
  }
  return record as ImplementationRecord;
}

function parseVerdict(text: string | null, rubric: readonly string[], diagnostics: readonly string[]): CheckResult[] {
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
    reason: truncate(entry.reason.trim(), 500),
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
