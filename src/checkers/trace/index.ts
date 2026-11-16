import { z } from "zod";
import type { PatternSyntax } from "../../engine/config.ts";
import { messageText } from "../../engine/messages.ts";
import { patternListSchema, patternSyntaxSchema } from "../../engine/params.ts";
import { searches } from "../../engine/regex.ts";
import type { CheckResult, Checker, CheckerContext, CheckerDefinition } from "../../engine/registry.ts";
import { skillConsultations, shellSkillAccess, type ShellSkillAccess } from "../../engine/skills.ts";
import { truncate } from "../../engine/truncate.ts";

const MAX_REASON = 800;
const MAX_LISTED_SKILLS = 10;

/** Report an unexpected parameter by name: each event accepts only the fields it asserts on. */
function acceptsOnly(accepted: string) {
  return (issue: { readonly code: string; readonly keys?: readonly string[] }): string | undefined =>
    issue.code === "unrecognized_keys" ? `accepts only ${accepted}; unexpected: ${issue.keys?.join(", ")}` : undefined;
}

/** `event: skill` asserts on the skills the run consulted, derived from completed tool calls. */
const skillEventSchema = z
  .strictObject(
    {
      event: z.literal("skill"),
      /** The skill's name: a literal for one exact name, or a /…/ RE2 pattern searched within it. */
      name: patternSyntaxSchema,
      /** The exact number of matching consultations; omitted means at least one. */
      times: z.number().int().min(0, "must be a non-negative integer").optional(),
    },
    { error: acceptsOnly("event, name and times for a skill event") },
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

/** `event: message` asserts on the text the agent produced, joined from every `message` entry. */
const messageEventSchema = z
  .strictObject(
    {
      event: z.literal("message"),
      /** Text the artifact must hold: a literal substring, or a /…/ RE2 pattern searched within it. */
      matches: patternListSchema.optional(),
      /** Text the artifact must not hold, in the same grammar. */
      notMatches: patternListSchema.optional(),
    },
    { error: acceptsOnly("event, matches and notMatches for a message event") },
  )
  .superRefine((params, context) => {
    if (params.matches === undefined && params.notMatches === undefined) {
      context.addIssue({ code: "custom", message: "needs at least one of matches or notMatches" });
    }
  });

/** One declared pattern of a message assertion and whether it must be found or must be absent. */
interface DeclaredPattern {
  readonly kind: "matches" | "notMatches";
  readonly pattern: PatternSyntax;
}

type SkillParams = z.output<typeof skillEventSchema>;

type TraceCheckParams = SkillParams | { readonly event: "message"; readonly patterns: readonly DeclaredPattern[] };

const traceCheckParamsSchema = z
  .discriminatedUnion("event", [skillEventSchema, messageEventSchema], {
    error: (issue) =>
      issue.code === "invalid_union" ? 'must be "skill" or "message" (accepted events: skill, message)' : undefined,
  })
  .transform((params): TraceCheckParams =>
    params.event === "message"
      ? {
          event: "message",
          patterns: [
            ...(params.matches ?? []).map((pattern) => ({ kind: "matches" as const, pattern })),
            ...(params.notMatches ?? []).map((pattern) => ({ kind: "notMatches" as const, pattern })),
          ],
        }
      : params,
  );

/** Assert on derived trace events: the skills a run consulted, or the text it produced. */
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
    const params = this.#params;
    return params.event === "message" ? messages(context, params.patterns) : skills(context, params);
  };
}

async function skills(context: CheckerContext, params: SkillParams): Promise<readonly CheckResult[]> {
  const { name, times } = params;
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

  const sources = {
    workspace: context.workspace,
    home: context.home,
    workspaceBaseline: context.baseline,
    homeBaseline: context.homeBaseline,
  };
  const consultations = await skillConsultations(context.trace, sources);
  const shell = await shellSkillAccess(context.trace, sources);
  const matching = consultations.filter((consultation) => matches(name, consultation.name));
  const satisfied = times === undefined ? matching.length >= 1 : matching.length === times;
  return [
    {
      checker: "trace",
      subject,
      status: satisfied ? "pass" : "fail",
      reason: truncate(
        (satisfied ? found(matching, consultations) : expected(name, times, consultations, matching)) +
          shellNote(shell),
        MAX_REASON,
      ),
    },
  ];
}

/** Assert on the joined agent text; a run that produced none is an error, never a vacuous pass. */
function messages(context: CheckerContext, patterns: readonly DeclaredPattern[]): readonly CheckResult[] {
  const text = context.trace === undefined ? undefined : messageText(context.trace);
  if (text === undefined) {
    return [
      {
        checker: "trace",
        subject: "message",
        status: "error",
        reason: "this runner records no trace, so no message text can be derived",
      },
    ];
  }
  if (text === "") {
    return [
      {
        checker: "trace",
        subject: "message",
        status: "error",
        reason: "the trace holds no message text, so there is nothing to assert on",
      },
    ];
  }
  return patterns.map(({ kind, pattern }) => {
    const found = pattern.regex ? searches(pattern.source, text) : text.includes(pattern.source);
    return {
      checker: "trace",
      subject: `message ${kind === "matches" ? "matches" : "does not match"} ${quoted(pattern)}`,
      status: found === (kind === "matches") ? "pass" : "fail",
      reason: found ? "pattern found" : "pattern not found",
    };
  });
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
  return `${wanted}, consulted: ${listed(consultations)}${fallbackNote(matching)}`;
}

/** A pass still names what the run consulted, so a reader sees why the check held. */
function found(
  matching: readonly { readonly name: string; readonly fromDirectory: boolean }[],
  consultations: readonly { readonly name: string; readonly fromDirectory: boolean }[],
): string {
  return `found ${count(matching.length)}, consulted: ${listed(consultations)}${fallbackNote(matching)}`;
}

function listed(consultations: readonly { readonly name: string }[]): string {
  return consultations.length === 0
    ? "none"
    : consultations
        .slice(0, MAX_LISTED_SKILLS)
        .map((consultation) => consultation.name)
        .join(", ") + (consultations.length > MAX_LISTED_SKILLS ? ", …" : "");
}

/** Shell access is reported, never counted: it does not change the status or the count. */
function shellNote(shell: readonly ShellSkillAccess[]): string {
  return shell.length === 0 ? "" : `; touched via shell: ${listed(shell)}`;
}

/** Say when a matched name is only the skill's parent directory. */
function fallbackNote(matching: readonly { readonly name: string; readonly fromDirectory: boolean }[]): string {
  const unnamed = matching
    .filter((consultation) => consultation.fromDirectory)
    .map((consultation) => consultation.name);
  return unnamed.length === 0 ? "" : ` (named from the parent directory, not frontmatter: ${unnamed.join(", ")})`;
}

/** A skill name as written; its pattern slashes already show that it is a pattern. */
function display(pattern: PatternSyntax): string {
  return pattern.regex ? `/${truncate(pattern.source, 120)}/` : truncate(pattern.source, 120);
}

/** A literal in quotes, or a regex between slashes, so the subject says which pattern was used. */
function quoted(pattern: PatternSyntax): string {
  return pattern.regex ? `/${truncate(pattern.source, 120)}/` : `"${truncate(pattern.source, 120)}"`;
}

function count(value: number): string {
  return `${value} consultation${value === 1 ? "" : "s"}`;
}
