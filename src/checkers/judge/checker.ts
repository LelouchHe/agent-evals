import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../../engine/config.ts";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { isMissing, readRunFile } from "../../engine/workspace.ts";
import { assertSeatbeltAvailable } from "../../platform/macos/policy.ts";
import { invokePi, resolvePiExecutable, type PiSessionError } from "../../runners/pi/session.ts";
import {
  assertEnvPassthroughAvailable,
  envPassthroughSchema,
  nonEmptyTrimmedString,
  thinkingSchema,
} from "../../runners/pi/params.ts";
import { buildJudgePrompt } from "./prompt.ts";

const runRelativePath = z
  .string()
  .min(1, "must be a non-empty run-relative path")
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]+/).includes(".."), {
    message: "must be relative to the run workspace without '..' segments",
  });

const judgeParamsSchema = z.strictObject({
  model: nonEmptyTrimmedString,
  thinking: thinkingSchema.default("medium"),
  rubric: z.array(nonEmptyTrimmedString).min(1, "must contain at least one statement"),
  file: runRelativePath,
  executable: nonEmptyTrimmedString.default("pi"),
  envPassthrough: envPassthroughSchema,
});

type JudgeParams = z.output<typeof judgeParamsSchema>;

export class JudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeError";
  }
}

/** Independent Pi invocation that evaluates task and file evidence against a rubric. */
export const judgeChecker: CheckerDefinition<JudgeParams> = {
  type: "judge",
  params: judgeParamsSchema,
  async create(params) {
    await resolvePiExecutable(params.executable);
    assertEnvPassthroughAvailable(params.envPassthrough);
    assertSeatbeltAvailable();
    return new JudgeChecker(params);
  },
};

class JudgeChecker implements Checker {
  readonly #params: JudgeParams;

  constructor(params: JudgeParams) {
    this.#params = params;
  }

  readonly check = async (context: CheckerContext): Promise<readonly CheckResult[]> => {
    const parsed = this.#params;
    let fileContent: string | null;
    try {
      fileContent = (await readRunFile(context.workspace, parsed.file)).toString("utf8");
    } catch (error) {
      if (isMissing(error)) {
        fileContent = null;
      } else {
        throw new JudgeError(`could not read judge evidence ${parsed.file}: ${errorMessage(error)}`);
      }
    }

    const judgeDir = await mkdtemp(join(context.runRootDir, "judge-"));
    try {
      const workspaceDir = join(judgeDir, "workspace");
      await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
      const result = await invokePi(
        {
          executable: parsed.executable,
          runRootDir: judgeDir,
          model: parsed.model,
          thinking: parsed.thinking,
          dirs: {
            workspaceDir,
            homeDir: join(judgeDir, "home"),
            configDir: join(judgeDir, "config"),
            scratchDir: join(judgeDir, "scratch"),
          },
          skills: [],
          tools: null,
          envPassthrough: parsed.envPassthrough,
          allowNetwork: true,
        },
        buildJudgePrompt({
          task: context.input,
          file: parsed.file,
          fileContent,
          rubric: parsed.rubric,
        }),
        { timeoutMs: context.timeoutMs, signal: context.signal },
      );
      return parseVerdict(result.finalText, parsed.rubric, result.diagnostics);
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
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { criteria?: unknown }).criteria)) {
    throw new JudgeError(withDiagnostics("invalid judge verdict: missing criteria array", diagnostics));
  }
  const criteria = (parsed as { criteria: unknown[] }).criteria;
  if (criteria.length !== rubric.length) {
    throw new JudgeError(
      withDiagnostics(
        `invalid judge verdict: expected ${rubric.length} criteria, received ${criteria.length}`,
        diagnostics,
      ),
    );
  }

  return criteria.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new JudgeError(withDiagnostics(`invalid judge verdict: criteria[${index}] is not an object`, diagnostics));
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.pass !== "boolean") {
      throw new JudgeError(
        withDiagnostics(`invalid judge verdict: criteria[${index}].pass is not a boolean`, diagnostics),
      );
    }
    if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
      throw new JudgeError(withDiagnostics(`invalid judge verdict: criteria[${index}].reason is missing`, diagnostics));
    }
    return {
      checker: "judge",
      subject: rubric[index] ?? "",
      status: record.pass ? "pass" : "fail",
      reason: truncate(record.reason.trim(), 500),
    } satisfies CheckResult;
  });
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
  if (error instanceof JudgeError) {
    return error.message;
  }
  const diagnostic = isPiSessionError(error) ? error.diagnostics[0] : undefined;
  const base = `judge invocation failed: ${errorMessage(error)}`;
  return diagnostic === undefined ? base : truncate(`${base} (${diagnostic})`, 800);
}

function isPiSessionError(error: unknown): error is PiSessionError {
  return typeof error === "object" && error !== null && "diagnostics" in error;
}

function withDiagnostics(message: string, diagnostics: readonly string[]): string {
  return diagnostics.length === 0 ? message : truncate(`${message} (${diagnostics[0]})`, 800);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit) + "…";
}
