import { z } from "zod";
import {
  ConfigError,
  errorMessage,
  expectMockArgs,
  expectMockTarget,
  mockTargetIdentity,
  type MockArgs,
  type MockArgument,
  type MockPattern,
} from "../../engine/config.ts";
import { compileMockArgs } from "../../engine/mock-match.ts";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { truncate } from "../../engine/truncate.ts";

const MAX_REASON = 800;
const MAX_LISTED_CALLS = 10;

const mockCheckParamsSchema = z
  .strictObject({
    /** A declared `mocks.shell` target, then the mock rule's argument grammar. */
    shell: z.array(z.unknown()).min(1, "must name a target"),
    times: z.number().int().min(0, "must be a non-negative integer").optional(),
  })
  .superRefine((params, context) => {
    const [target, ...rest] = params.shell;
    if (typeof target !== "string" || target.length === 0) {
      context.addIssue({ code: "custom", path: ["shell", 0], message: "must be a non-empty target" });
    } else if (target.length >= 2 && target.startsWith("/") && target.endsWith("/")) {
      context.addIssue({
        code: "custom",
        path: ["shell", 0],
        message: "must be a literal declared target, not a /…/ pattern",
      });
    } else {
      try {
        // The same shape a `mocks.shell` target must have, so identity cannot normalise it away.
        expectMockTarget(target, "shell[0]");
      } catch (error) {
        context.addIssue({ code: "custom", path: ["shell", 0], message: errorMessage(error) });
      }
    }
    try {
      expectMockArgs(rest, "shell");
    } catch (error) {
      context.addIssue({ code: "custom", path: ["shell"], message: errorMessage(error) });
    }
  })
  .transform((params) => {
    const [target, ...rest] = params.shell as [string, ...unknown[]];
    return {
      target,
      args: expectMockArgs(rest, "shell"),
      ...(params.times === undefined ? {} : { times: params.times }),
    };
  });

type MockCheckParams = z.output<typeof mockCheckParamsSchema>;

/** Assert on the calls the run recorded for one declared `mocks.shell` target. */
export const mockChecker: CheckerDefinition<MockCheckParams> = {
  type: "mock",
  params: mockCheckParamsSchema,
  create(params, context) {
    return new MockChecker(params, requireDeclaredTarget(context.mockTargets, params.target));
  },
};

/** The declared spelling of the target a check names, or a load-time error. */
function requireDeclaredTarget(targets: readonly string[] | undefined, requested: string): string {
  if (targets === undefined) {
    throw new ConfigError(`mock checker "${requested}" needs a case that declares mocks`);
  }
  const identity = mockTargetIdentity(requested);
  const declared = targets.find((target) => mockTargetIdentity(target) === identity);
  if (declared === undefined) {
    const available = targets.length === 0 ? "none" : targets.join(", ");
    throw new ConfigError(`mock checker "${requested}" is not a declared mocks.shell target (declared: ${available})`);
  }
  return declared;
}

class MockChecker implements Checker {
  readonly #params: MockCheckParams;
  readonly #target: string;
  readonly #matches: (argv: readonly string[]) => boolean;

  constructor(params: MockCheckParams, target: string) {
    this.#params = params;
    this.#target = target;
    this.#matches = compileMockArgs(params.args);
  }

  readonly check = async (context: CheckerContext): Promise<readonly CheckResult[]> => {
    const subject = `${this.#target} ${renderArgs(this.#params.args)}`.trim();
    const calls = (context.mockRecords ?? [])
      .filter((record) => record.target === this.#target)
      .filter((record) => this.#matches(record.arguments));
    const expected = this.#params.times;
    const matched = expected === undefined ? calls.length >= 1 : calls.length === expected;
    return [
      {
        checker: "mock",
        subject,
        status: matched ? "pass" : "fail",
        reason: matched
          ? `found ${count(calls.length)}`
          : describeFailure(
              calls.map((call) => call.arguments),
              expected,
            ),
      },
    ];
  };
}

function describeFailure(found: readonly (readonly string[])[], expected: number | undefined): string {
  const wanted = expected === undefined ? "at least 1 matching call" : `exactly ${count(expected)}`;
  const listed = found
    .slice(0, MAX_LISTED_CALLS)
    .map((arguments_) => JSON.stringify(arguments_))
    .join(", ");
  return truncate(`expected ${wanted}, found ${count(found.length)}${listed === "" ? "" : `: ${listed}`}`, MAX_REASON);
}

function count(value: number): string {
  return `${value} call${value === 1 ? "" : "s"}`;
}

/** Render the check's own argument grammar for the result's subject. */
function renderArgs(args: MockArgs): string {
  const positional = args.positional.map(renderPattern);
  return [...positional, ...(args.options.length === 0 ? [] : [renderOptions(args.options)])].join(" ");
}

function renderOptions(options: readonly MockArgument[]): string {
  const entries = options.map((option) => {
    const key = renderPattern(option.key);
    if (option.kind === "required") return `${key}:true`;
    if (option.kind === "forbidden") return `${key}:false`;
    return `${key}:${renderPattern(option.value)}`;
  });
  return `{${entries.join(",")}}`;
}

function renderPattern(pattern: MockPattern): string {
  return pattern.regex ? `/${pattern.source}/` : pattern.source;
}
