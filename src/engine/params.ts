import type { ZodError, ZodType } from "zod";
import { ConfigError, errorMessage, type ImplementationParams } from "./config.ts";

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

function formatSchemaError(label: string, error: ZodError): string {
  const issues = error.issues;
  if (issues.length === 0) {
    return `${label} parameters are invalid`;
  }
  const shown = issues.slice(0, 10).map((issue) => {
    const path = issue.path.map(String).join(".");
    const location = path.length === 0 ? `${label} parameters` : `${label} parameter ${path}`;
    return `${location}: ${issue.message}`;
  });
  const remaining = issues.length - shown.length;
  return shown.join("; ") + (remaining > 0 ? `; ${remaining} more parameter issue${remaining === 1 ? "" : "s"}` : "");
}
