import { lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  ConfigError,
  errorMessage,
  expectRelativePath,
  expectWorkspaceDestination,
  resolveAuthoringAsset,
  workspaceTargetPath,
} from "../../engine/config.ts";
import { placeStagedFiles, stageFiles } from "../../engine/files.ts";
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

/** Check every source and stage them once, so a missing source or overlap fails before any run. */
async function validateFiles(files: Record<string, string> | undefined, authoringDir: string): Promise<void> {
  if (files === undefined || Object.keys(files).length === 0) return;
  for (const [destination, source] of Object.entries(files)) {
    const path = resolveAuthoringAsset(authoringDir, source, `shell checker files["${destination}"]`);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      throw new ConfigError(
        `shell checker files source ${source} for "${destination}" is not accessible: ${errorMessage(error)}`,
      );
    }
    if (info.isDirectory() || info.isFile()) continue;
    if (info.isSymbolicLink()) {
      try {
        if ((await stat(path)).isFile()) continue;
      } catch (error) {
        throw new ConfigError(
          `shell checker files source ${source} for "${destination}" is not accessible: ${errorMessage(error)}`,
        );
      }
    }
    throw new ConfigError(
      `shell checker files source ${source} for "${destination}" must be a regular file or directory`,
    );
  }

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
    if (files !== undefined && Object.keys(files).length > 0) {
      try {
        await placeFiles(files, this.#authoringDir, context);
      } catch (error) {
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

    const outcome = await context.checkSandbox.run(this.#params.run);
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
  };
}

/** Stage the check's files and copy them into the live workspace before the program starts. */
async function placeFiles(
  files: Readonly<Record<string, string>>,
  authoringDir: string,
  context: CheckerContext,
): Promise<void> {
  const staging = await mkdtemp(join(context.runRootDir, "check-files-"));
  try {
    await stageFiles(files, authoringDir, staging, "shell checker files");
    await placeStagedFiles(staging, context.workspace, "shell checker files");
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 });
  }
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
