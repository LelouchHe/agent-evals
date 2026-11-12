import { z } from "zod";
import { THINKING_LEVELS } from "./session.ts";

export const thinkingSchema = z.enum(THINKING_LEVELS);

export const nonEmptyTrimmedString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must be a non-empty string" });
