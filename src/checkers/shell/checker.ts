import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  ConfigError,
  errorMessage,
  expectRelativePath,
  expectWorkspaceDestination,
  workspaceTargetPath,
} from "../../engine/config.ts";
import { stageFiles } from "../../engine/files.ts";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { assertSeatbeltAvailable } from "../../platform/macos/policy.ts";
import { truncate } from "../../engine/truncate.ts";

const MAX_REASON = 800;
const MAX_SUBJECT = 200;

/** Check-time files: workspace destinations on the left, authoring sources on the right. */
const shellFilesSchema = z.record(z.string(), z.string()).superRefine((files, context) => {
  for (const [destination, source] of Object.entries(files)) {
    try {
      expectWorkspaceDestination(destination, `files destination "${destination}"`);
      if (workspaceTargetPath(destination) === "") {
        throw new ConfigError(`files destination "${destination}" must name a file or directory inside the workspace`);
      }
    } catch (error) {
      context.addIssue({ code: "custom", path: ["files", destination], message: errorMessage(error) });
    }
    try {
      expectRelativePath(source, `files["${destination}"]`);
    } catch (error) {
      context.addIssue({ code: "custom", path: ["files", destination], message: errorMessage(error) });
    }
  }
});

const shellCheckParamsSchema = z.strictObject({
  /** A program and its arguments, started in the workspace root; never a shell interpreter. */
  run: z.array(z.string().min(1, "must be a non-empty string")).min(1, "must name a program"),
  /** Authoring files placed into the live workspace only after the agent stopped. */
  files: shellFilesSchema.optional(),
});

type ShellCheckParams = z.output<typeof shellCheckParamsSchema>;

/** Run an author's program after the run and judge its exit status in the check sandbox. */
export const shellChecker: CheckerDefinition<ShellCheckParams> = {
  type: "shell",
  params: shellCheckParamsSchema,
  async create(params, context) {
    assertSeatbeltAvailable();
    await validateFiles(params.files, context.authoringDir);
    return new ShellChecker(params, context.authoringDir);
  },
};

/**
 * Stage every source once, so a missing source, a special file, a symlink to one, or overlapping
 * entries fails at load time instead of during the check.
 */
async function validateFiles(files: Record<string, string> | undefined, authoringDir: string): Promise<void> {
  if (files === undefined || Object.keys(files).length === 0) return;
  const staging = await mkdtemp(join(tmpdir(), "agent-evals-shell-files-"));
  try {
    await stageFiles(files, authoringDir, staging, "shell checker files");
  } catch (error) {
    throw new ConfigError(`shell checker files: ${errorMessage(error)}`);
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

class ShellChecker implements Checker {
  readonly #params: ShellCheckParams;
  readonly #authoringDir: string;

  constructor(params: ShellCheckParams, authoringDir: string) {
    this.#params = params;
    this.#authoringDir = authoringDir;
  }

  readonly check = async (context: CheckerContext): Promise<readonly CheckResult[]> => {
    const subject = truncate(`run ${this.#params.run.join(" ")}`, MAX_SUBJECT);
    const files = this.#params.files;
    let stagingDir: string | undefined;
    if (files !== undefined && Object.keys(files).length > 0) {
      try {
        stagingDir = await mkdtemp(join(context.runRootDir, "check-files-"));
        await stageFiles(files, this.#authoringDir, stagingDir, "shell checker files", context.signal);
      } catch (error) {
        if (stagingDir !== undefined) {
          await rm(stagingDir, { recursive: true, force: true, maxRetries: 3 });
        }
        // The engine owns cancellation and deadline reporting for an aborted check.
        if (context.signal.aborted) throw error;
        return [
          {
            checker: "shell",
            subject,
            status: "error",
            reason: truncate(`could not place files: ${errorMessage(error)}`, MAX_REASON),
          },
        ];
      }
    }

    try {
      const outcome = await context.checkSandbox.run(
        this.#params.run,
        stagingDir === undefined ? undefined : { stagingDir },
      );
      switch (outcome.kind) {
        case "exited": {
          if (outcome.exitCode === 0) {
            return [{ checker: "shell", subject, status: "pass", reason: "exit status 0" }];
          }
          return [
            {
              checker: "shell",
              subject,
              status: "fail",
              reason: failureReason(outcome.exitCode, outcome.output),
            },
          ];
        }
        case "signalled":
          return [{ checker: "shell", subject, status: "error", reason: `program died from ${outcome.signal}` }];
        case "failed":
          return [{ checker: "shell", subject, status: "error", reason: truncate(outcome.reason, MAX_REASON) }];
      }
    } finally {
      if (stagingDir !== undefined) {
        await rm(stagingDir, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  };
}

/** Keep the end of the output, where a test runner's assertion failure is. */
function failureReason(exitCode: number, output: string): string {
  const header = `exit status ${exitCode}`;
  const text = output.trim();
  if (text === "") return header;
  const available = MAX_REASON - header.length - 2;
  const body = text.length <= available ? text : `…${text.slice(-(available - 1))}`;
  return `${header}: ${body}`;
}
