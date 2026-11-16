import { z } from "zod";
import type { PatternSyntax } from "../../engine/config.ts";
import { patternSyntaxSchema } from "../../engine/params.ts";
import { searches } from "../../engine/regex.ts";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { skillConsultations } from "../../engine/skills.ts";
import { truncate } from "../../engine/truncate.ts";

const MAX_REASON = 800;
const MAX_LISTED_SKILLS = 10;

const traceCheckParamsSchema = z
  .strictObject(
    {
      /** The kind of trace event to select. M5 derives only skill consultations. */
      event: z.literal("skill", { error: 'must be "skill" (accepted events: skill)' }),
      /** The skill's name: a literal for one exact name, or a /…/ RE2 pattern searched within it. */
      name: patternSyntaxSchema,
      /** The exact number of matching consultations; omitted means at least one. */
      times: z.number().int().min(0, "must be a non-negative integer").optional(),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? `accepts only event, name and times; unexpected: ${issue.keys.join(", ")}`
          : undefined,
    },
  )
  .superRefine((params, context) => {
    if (!params.name.regex && params.times !== undefined && params.times > 1) {
      context.addIssue({
        code: "custom",
        path: ["times"],
        message: "must be 0 or 1 with a literal name, which matches at most one skill",
      });
    }
  });

type TraceCheckParams = z.output<typeof traceCheckParamsSchema>;

/** Assert on the skills the run's trace shows it consulted. */
export const traceChecker: CheckerDefinition<TraceCheckParams> = {
  type: "trace",
  params: traceCheckParamsSchema,
  create(params) {
    return new TraceChecker(params);
  },
};

class TraceChecker implements Checker {
  readonly #params: TraceCheckParams;

  constructor(params: TraceCheckParams) {
    this.#params = params;
  }

  readonly check = async (context: CheckerContext): Promise<readonly CheckResult[]> => {
    const { name, times } = this.#params;
    const subject = `skill ${display(name)}`;
    if (context.trace === undefined) {
      return [
        {
          checker: "trace",
          subject,
          status: "error",
          reason: "this runner records no trace, so no skill consultation can be derived",
        },
      ];
    }

    const consultations = await skillConsultations(context.trace, {
      workspace: context.workspace,
      baseline: context.baseline,
    });
    const matching = consultations.filter((consultation) => matches(name, consultation.name));
    const satisfied = times === undefined ? matching.length >= 1 : matching.length === times;
    return [
      {
        checker: "trace",
        subject,
        status: satisfied ? "pass" : "fail",
        reason: truncate(satisfied ? found(matching) : expected(name, times, consultations, matching), MAX_REASON),
      },
    ];
  };
}

/** A literal names one exact skill; a /…/ pattern is searched within the name. */
function matches(pattern: PatternSyntax, name: string): boolean {
  return pattern.regex ? searches(pattern.source, name) : name === pattern.source;
}

function expected(
  name: PatternSyntax,
  times: number | undefined,
  consultations: readonly { readonly name: string; readonly fromDirectory: boolean }[],
  matching: readonly { readonly name: string; readonly fromDirectory: boolean }[],
): string {
  const wanted =
    times === undefined ? `expected ${display(name)}` : `expected exactly ${count(times)} of ${display(name)}`;
  const consulted =
    consultations.length === 0
      ? "none"
      : consultations
          .slice(0, MAX_LISTED_SKILLS)
          .map((consultation) => consultation.name)
          .join(", ") + (consultations.length > MAX_LISTED_SKILLS ? ", …" : "");
  return `${wanted}, consulted: ${consulted}${fallbackNote(matching)}`;
}

function found(matching: readonly { readonly name: string; readonly fromDirectory: boolean }[]): string {
  return `found ${count(matching.length)}${fallbackNote(matching)}`;
}

/** Say when a matched name is only the skill's parent directory. */
function fallbackNote(matching: readonly { readonly name: string; readonly fromDirectory: boolean }[]): string {
  const unnamed = matching
    .filter((consultation) => consultation.fromDirectory)
    .map((consultation) => consultation.name);
  return unnamed.length === 0 ? "" : ` (named from the parent directory, not frontmatter: ${unnamed.join(", ")})`;
}

function display(pattern: PatternSyntax): string {
  return pattern.regex ? `/${truncate(pattern.source, 120)}/` : truncate(pattern.source, 120);
}

function count(value: number): string {
  return `${value} consultation${value === 1 ? "" : "s"}`;
}
