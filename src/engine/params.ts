import { z, type ZodError, type ZodType } from "zod";
import {
  ConfigError,
  parsePatternScalar,
  type ImplementationParams,
  type PatternScalarResult,
  type PatternSyntax,
} from "./config.ts";

/**
 * One literal or /…/ pattern. A YAML number is compared as its text; a boolean or a mapping is
 * rejected, because an unquoted `state: failed` in a list is a mapping rather than the string
 * the author meant.
 */
export const patternSyntaxSchema = z.unknown().transform((value, context): PatternSyntax => {
  const parsed = parsePatternScalar(value);
  if (parsed.kind === "pattern") {
    if (parsed.pattern.regex && parsed.pattern.source.length === 0) {
      context.addIssue({ code: "custom", message: "must name a pattern inside /…/" });
      return z.NEVER;
    }
    return parsed.pattern;
  }
  context.addIssue({ code: "custom", message: patternIssue(value, parsed) });
  return z.NEVER;
});

/** The field-level message for a scalar that is not a pattern; each caller names its own mistake. */
function patternIssue(value: unknown, parsed: Extract<PatternScalarResult, { kind: "invalid" }>): string {
  if (parsed.reason === "regex") {
    return `is not a valid RE2 pattern: ${parsed.message}`;
  }
  if (typeof value === "object" && value !== null) {
    return 'must be a string, number or /…/ RE2 pattern; quote a string containing ": ", as in "state: failed"';
  }
  if (typeof value === "boolean") {
    return "must be a string, number or /…/ RE2 pattern; quote a boolean literal";
  }
  return "must be a non-empty string, number or /…/ RE2 pattern";
}

/** Shared schema rule for check targets relative to the evaluated workspace. */
export const runRelativePathSchema = z
  .string()
  .min(1, "must be a non-empty run-relative path")
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]+/).includes(".."), {
    message: "must be relative to the run workspace without '..' segments",
  });

/** Parse raw declared parameters exactly once with the implementation's Zod schema. */
export async function parseImplementationParams<P>(
  schema: ZodType<P>,
  raw: ImplementationParams,
  label: string,
): Promise<P> {
  const result = await schema.safeParseAsync(raw);
  if (result.success) {
    return result.data;
  }
  throw new ConfigError(formatSchemaError(label, result.error));
}

function formatSchemaError(label: string, error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      const location = path.length === 0 ? `${label} parameters` : `${label} parameter ${path}`;
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}
