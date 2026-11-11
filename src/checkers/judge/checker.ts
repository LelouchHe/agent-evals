import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, errorMessage, type ImplementationParams } from "../../engine/config.ts";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { isMissing, readRunFile } from "../../engine/workspace.ts";
import { assertSeatbeltAvailable } from "../../platform/macos/policy.ts";
import { invokePi, resolvePiExecutable, THINKING_LEVELS, validateEnvPassthrough, type PiSessionError, type ThinkingLevel } from "../../runners/pi/session.ts";
import { buildJudgePrompt } from "./prompt.ts";

const JUDGE_KEYS = new Set(["model", "thinking", "rubric", "file", "executable", "envPassthrough"]);

interface JudgeParams {
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly rubric: readonly string[];
  readonly file: string;
  readonly executable: string;
  readonly envPassthrough: readonly string[];
}

export class JudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeError";
  }
}

/** Independent Pi invocation that evaluates task and file evidence against a rubric. */
export const judgeChecker: CheckerDefinition = {
  type: "judge",
  async validate(params: ImplementationParams): Promise<void> {
    await parseParams(params);
    assertSeatbeltAvailable();
  },
  create(): Checker {
    return new JudgeChecker();
  },
};

class JudgeChecker implements Checker {
  async check(params: ImplementationParams, context: CheckerContext): Promise<readonly CheckResult[]> {
    const parsed = await parseParams(params);

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
  }
}

async function parseParams(params: ImplementationParams): Promise<JudgeParams> {
  const unknown = Object.keys(params).filter((key) => !JUDGE_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`judge checker has unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }

  const model = params.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new ConfigError("judge checker parameter model must be a non-empty string");
  }

  const thinking = params.thinking ?? "medium";
  if (typeof thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new ConfigError(`judge checker parameter thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }

  const rubric = params.rubric;
  if (!Array.isArray(rubric) || rubric.length === 0 || rubric.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new ConfigError("judge checker parameter rubric must be a non-empty list of statements");
  }

  const file = params.file;
  if (typeof file !== "string" || file.length === 0) {
    throw new ConfigError("judge checker parameter file must be a non-empty run-relative path");
  }
  if (file.startsWith("/") || file.split(/[\\/]+/).includes("..")) {
    throw new ConfigError(`judge checker file must be relative to the run workspace: ${file}`);
  }

  const executable = params.executable ?? "pi";
  if (typeof executable !== "string" || executable.trim().length === 0) {
    throw new ConfigError("judge checker parameter executable must be a non-empty string");
  }
  await resolvePiExecutable(executable);

  const rawEnv = params.envPassthrough ?? [];
  if (!Array.isArray(rawEnv) || rawEnv.some((name) => typeof name !== "string")) {
    throw new ConfigError("judge checker parameter envPassthrough must be a list of variable names");
  }
  const envPassthrough = rawEnv as string[];
  validateEnvPassthrough(envPassthrough);

  return {
    model,
    thinking: thinking as ThinkingLevel,
    rubric: rubric as string[],
    file,
    executable,
    envPassthrough,
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
      withDiagnostics(`invalid judge verdict: expected ${rubric.length} criteria, received ${criteria.length}`, diagnostics),
    );
  }

  return criteria.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new JudgeError(withDiagnostics(`invalid judge verdict: criteria[${index}] is not an object`, diagnostics));
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.pass !== "boolean") {
      throw new JudgeError(withDiagnostics(`invalid judge verdict: criteria[${index}].pass is not a boolean`, diagnostics));
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
