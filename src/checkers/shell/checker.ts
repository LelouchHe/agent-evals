import { z } from "zod";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { assertSeatbeltAvailable } from "../../platform/macos/policy.ts";
import { truncate } from "../../engine/truncate.ts";

const MAX_REASON = 800;
const MAX_SUBJECT = 200;

const shellCheckParamsSchema = z.strictObject({
  /** A program and its arguments, started in the workspace root; never a shell interpreter. */
  run: z.array(z.string().min(1, "must be a non-empty string")).min(1, "must name a program"),
});

type ShellCheckParams = z.output<typeof shellCheckParamsSchema>;

/** Run an author's program after the run and judge its exit status in the check sandbox. */
export const shellChecker: CheckerDefinition<ShellCheckParams> = {
  type: "shell",
  params: shellCheckParamsSchema,
  create(params) {
    assertSeatbeltAvailable();
    return new ShellChecker(params);
  },
};

class ShellChecker implements Checker {
  readonly #params: ShellCheckParams;

  constructor(params: ShellCheckParams) {
    this.#params = params;
  }

  readonly check = async (context: CheckerContext): Promise<readonly CheckResult[]> => {
    const subject = truncate(`run ${this.#params.run.join(" ")}`, MAX_SUBJECT);
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

/** Keep the end of the output, where a test runner's assertion failure is. */
function failureReason(exitCode: number, output: string): string {
  const header = `exit status ${exitCode}`;
  const text = output.trim();
  if (text === "") return header;
  const available = MAX_REASON - header.length - 2;
  const body = text.length <= available ? text : `…${text.slice(-(available - 1))}`;
  return `${header}: ${body}`;
}
