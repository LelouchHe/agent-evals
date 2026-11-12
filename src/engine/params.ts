import type { ZodType } from "zod";
import { ConfigError, errorMessage, type ImplementationParams } from "./config.ts";

interface SchemaIssue {
  readonly path?: readonly PropertyKey[];
  readonly message?: string;
}

/** Parse raw declared parameters exactly once with the implementation's Zod schema. */
export async function parseImplementationParams<P>(
  schema: ZodType<P>,
  raw: ImplementationParams,
  label: string,
): Promise<P> {
  let result;
  try {
    result = await schema.safeParseAsync(raw);
  } catch (error) {
    throw new ConfigError(`${label} parameter validation failed: ${errorMessage(error)}`);
  }
  if (result.success) {
    return result.data;
  }
  throw new ConfigError(formatSchemaError(label, result.error));
}

function formatSchemaError(label: string, error: unknown): string {
  const issues = issuesOf(error);
  if (issues.length === 0) {
    return `${label} parameters are invalid`;
  }
  const shown = issues.slice(0, 10).map((issue) => {
    const path = issue.path?.map(String).join(".");
    const location = path === undefined || path.length === 0 ? `${label} parameters` : `${label} parameter ${path}`;
    return `${location}: ${issue.message ?? "is invalid"}`;
  });
  const remaining = issues.length - shown.length;
  return shown.join("; ") + (remaining > 0 ? `; ${remaining} more parameter issue${remaining === 1 ? "" : "s"}` : "");
}

function issuesOf(error: unknown): SchemaIssue[] {
  if (typeof error !== "object" || error === null) {
    return [];
  }
  const issues = (error as { readonly issues?: unknown }).issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.filter((issue): issue is SchemaIssue => typeof issue === "object" && issue !== null);
}
