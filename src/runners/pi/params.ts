import { z } from "zod";
import { ConfigError } from "../../engine/config.ts";
import { THINKING_LEVELS } from "./session.ts";

export const thinkingSchema = z.enum(THINKING_LEVELS);

export const nonEmptyTrimmedString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must be a non-empty string" });

export const envPassthroughSchema = z
  .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name"))
  .default([]);

/** Validate that every forwarded environment variable is present. */
export function assertEnvPassthroughAvailable(names: readonly string[]): void {
  for (const name of names) {
    if (process.env[name] === undefined) {
      throw new ConfigError(`envPassthrough requires ${name} to be set in the invoking environment`);
    }
  }
}
