import { z } from "zod";
import { THINKING_LEVELS } from "./session.ts";

export const thinkingSchema = z.enum(THINKING_LEVELS);

export const nonEmptyTrimmedString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must be a non-empty string" });

const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const credentialNamesSchema = z
  .array(z.string().regex(CREDENTIAL_NAME, "must be a valid environment variable name"))
  .default([]);
