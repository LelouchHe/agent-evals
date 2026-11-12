import { z, type ZodError, type ZodType } from "zod";
import { ConfigError, type ImplementationParams } from "./config.ts";

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
