import { cp, copyFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { ConfigError, errorMessage, resolveAuthoringAsset } from "../../engine/config.ts";
import { assertSeatbeltAvailable } from "../../platform/macos/policy.ts";
import type { Runner, RunnerContext, RunnerDefinition, RunnerOutcome } from "../../engine/registry.ts";
import {
  assertEnvPassthroughAvailable,
  envPassthroughSchema,
  nonEmptyTrimmedString,
  thinkingSchema,
} from "./params.ts";
import { invokePi, resolvePiExecutable } from "./session.ts";

const piRunnerParamsSchema = z.strictObject({
  model: nonEmptyTrimmedString,
  thinking: thinkingSchema.default("medium"),
  skills: z.array(z.string().min(1, "must be a non-empty relative path")).default([]),
  executable: nonEmptyTrimmedString.default("pi"),
  envPassthrough: envPassthroughSchema,
});

type PiRunnerParams = z.output<typeof piRunnerParamsSchema>;

/** Pi native RPC runner: one user message, autonomous tool turns, Seatbelt isolation. */
export const piRunner: RunnerDefinition<PiRunnerParams> = {
  type: "pi",
  params: piRunnerParamsSchema,
  async create(params, authoringDir) {
    await resolvePiExecutable(params.executable);
    await assertSkillsAvailable(params.skills, authoringDir);
    assertEnvPassthroughAvailable(params.envPassthrough);
    assertSeatbeltAvailable();
    return new PiRunner(params, authoringDir);
  },
};

class PiRunner implements Runner {
  readonly #params: PiRunnerParams;
  readonly #authoringDir: string;
  #stop: (() => Promise<void>) | undefined;

  constructor(params: PiRunnerParams, authoringDir: string) {
    this.#params = params;
    this.#authoringDir = authoringDir;
  }

  readonly run = async (context: RunnerContext): Promise<RunnerOutcome> => {
    const params = this.#params;
    const skills = await stageSkills(params.skills, this.#authoringDir, join(context.configDir, "skills"));
    const result = await invokePi(
      {
        executable: params.executable,
        runRootDir: context.runRootDir,
        model: params.model,
        thinking: params.thinking,
        dirs: {
          workspaceDir: context.workspaceDir,
          homeDir: context.homeDir,
          configDir: context.configDir,
          scratchDir: context.scratchDir,
        },
        skills,
        tools: ["read", "write", "edit", "bash"],
        envPassthrough: params.envPassthrough,
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
  };

  readonly stop = async (): Promise<void> => {
    await this.#stop?.();
  };
}

interface SkillSource {
  readonly skill: string;
  readonly source: string;
  readonly info: Awaited<ReturnType<typeof stat>>;
}

async function inspectSkills(skills: readonly string[], authoringDir: string): Promise<SkillSource[]> {
  const inspected: SkillSource[] = [];
  for (const skill of skills) {
    const source = resolveAuthoringAsset(authoringDir, skill, "pi runner skill");
    let info;
    try {
      info = await stat(source);
    } catch (error) {
      throw new ConfigError(`pi runner skill ${skill} is not accessible: ${errorMessage(error)}`);
    }
    if (info.isDirectory()) {
      try {
        await stat(join(source, "SKILL.md"));
      } catch {
        throw new ConfigError(`pi runner skill directory ${skill} has no SKILL.md`);
      }
    } else if (!info.isFile()) {
      throw new ConfigError(`pi runner skill ${skill} must be a directory or a Markdown file`);
    }
    inspected.push({ skill, source, info });
  }
  return inspected;
}

async function assertSkillsAvailable(skills: readonly string[], authoringDir: string): Promise<void> {
  await inspectSkills(skills, authoringDir);
}

async function stageSkills(skills: readonly string[], authoringDir: string, destination: string): Promise<string[]> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const staged: string[] = [];
  const names = new Set<string>();
  for (const { source, info } of await inspectSkills(skills, authoringDir)) {
    const name = basename(source);
    if (names.has(name)) {
      throw new ConfigError(`pi runner skills contain duplicate name: ${name}`);
    }
    names.add(name);
    const target = join(destination, name);
    if (info.isDirectory()) {
      await cp(source, target, { recursive: true });
    } else {
      await copyFile(source, target);
    }
    staged.push(target);
  }
  return staged;
}
