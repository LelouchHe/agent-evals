import { cp, copyFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { ConfigError, errorMessage, resolveAuthoringAsset, type ImplementationParams } from "../../engine/config.ts";
import { assertSeatbeltAvailable } from "../../platform/macos/policy.ts";
import type { Runner, RunnerContext, RunnerDefinition, RunnerOutcome } from "../../engine/registry.ts";
import {
  invokePi,
  resolvePiExecutable,
  THINKING_LEVELS,
  validateEnvPassthrough,
  type ThinkingLevel,
} from "./session.ts";

const RUNNER_KEYS = new Set(["model", "thinking", "skills", "executable", "envPassthrough"]);

interface PiRunnerParams {
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly skills: readonly string[];
  readonly executable: string;
  readonly envPassthrough: readonly string[];
}

/** Pi native RPC runner: one user message, autonomous tool turns, Seatbelt isolation. */
export const piRunner: RunnerDefinition = {
  type: "pi",
  async validate(params: ImplementationParams, authoringDir: string): Promise<void> {
    rejectUnknownParams(params);
    await parseParams(params, authoringDir);
    assertSeatbeltAvailable();
  },
  create(): Runner {
    return new PiRunner();
  },
};

class PiRunner implements Runner {
  #stop: (() => Promise<void>) | undefined;

  async run(params: ImplementationParams, context: RunnerContext): Promise<RunnerOutcome> {
    const parsed = await parseParams(params, context.authoringDir);
    const skills = await stageSkills(parsed.skills, context.authoringDir, join(context.configDir, "skills"));
    const result = await invokePi(
      {
        executable: parsed.executable,
        runRootDir: context.runRootDir,
        model: parsed.model,
        thinking: parsed.thinking,
        dirs: {
          workspaceDir: context.workspaceDir,
          homeDir: context.homeDir,
          configDir: context.configDir,
          scratchDir: context.scratchDir,
        },
        skills,
        tools: ["read", "write", "edit", "bash"],
        envPassthrough: parsed.envPassthrough,
        allowNetwork: true,
      },
      context.input,
      {
        timeoutMs: context.timeoutMs,
        signal: context.signal,
        onProcess: (stop) => {
          this.#stop = stop;
        },
      },
    );
    return { finalText: result.finalText, diagnostics: result.diagnostics };
  }

  async stop(): Promise<void> {
    await this.#stop?.();
  }
}

async function parseParams(params: ImplementationParams, authoringDir: string): Promise<PiRunnerParams> {
  const model = params.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new ConfigError("pi runner parameter model must be a non-empty string");
  }

  const thinking = params.thinking ?? "medium";
  if (typeof thinking !== "string" || !isThinkingLevel(thinking)) {
    throw new ConfigError(`pi runner parameter thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }

  const executable = params.executable ?? "pi";
  if (typeof executable !== "string" || executable.trim().length === 0) {
    throw new ConfigError("pi runner parameter executable must be a non-empty string");
  }
  await resolvePiExecutable(executable);

  const rawSkills = params.skills ?? [];
  if (!Array.isArray(rawSkills) || rawSkills.some((skill) => typeof skill !== "string" || skill.length === 0)) {
    throw new ConfigError("pi runner parameter skills must be a list of relative paths");
  }
  const skills = rawSkills as string[];
  for (const skill of skills) {
    const path = resolveAuthoringAsset(authoringDir, skill, "pi runner skill");
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      throw new ConfigError(`pi runner skill ${skill} is not accessible: ${errorMessage(error)}`);
    }
    if (info.isDirectory()) {
      try {
        await stat(join(path, "SKILL.md"));
      } catch {
        throw new ConfigError(`pi runner skill directory ${skill} has no SKILL.md`);
      }
    } else if (!info.isFile()) {
      throw new ConfigError(`pi runner skill ${skill} must be a directory or a Markdown file`);
    }
  }

  const rawEnv = params.envPassthrough ?? [];
  if (!Array.isArray(rawEnv) || rawEnv.some((name) => typeof name !== "string")) {
    throw new ConfigError("pi runner parameter envPassthrough must be a list of variable names");
  }
  const envPassthrough = rawEnv as string[];
  validateEnvPassthrough(envPassthrough);

  return { model, thinking, skills, executable, envPassthrough };
}

function rejectUnknownParams(params: ImplementationParams): void {
  const unknown = Object.keys(params).filter((key) => !RUNNER_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`pi runner has unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

async function stageSkills(skills: readonly string[], authoringDir: string, destination: string): Promise<string[]> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const staged: string[] = [];
  const names = new Set<string>();
  for (const skill of skills) {
    const source = resolveAuthoringAsset(authoringDir, skill, "pi runner skill");
    const info = await stat(source);
    const name = basename(source);
    if (names.has(name)) {
      throw new ConfigError(`pi runner skills contain duplicate name: ${name}`);
    }
    names.add(name);
    const target = join(destination, name);
    if (info.isDirectory()) {
      try {
        await stat(join(source, "SKILL.md"));
      } catch {
        throw new ConfigError(`pi runner skill directory ${skill} has no SKILL.md`);
      }
      await cp(source, target, { recursive: true });
    } else {
      await copyFile(source, target);
    }
    staged.push(target);
  }
  return staged;
}
