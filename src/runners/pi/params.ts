import { z } from "zod";
import { THINKING_LEVELS } from "./session.ts";

export const thinkingSchema = z.enum(THINKING_LEVELS);

export const nonEmptyTrimmedString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must be a non-empty string" });

const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_CREDENTIAL_NAMES = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "PI_CODING_AGENT_DIR",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "AGENT_EVALS_SHELL_STATE_DIR",
]);
const RESERVED_CREDENTIAL_PREFIXES = ["NODE_", "PI_", "AGENT_EVALS_", "DYLD_", "LD_"];

function isReservedCredentialName(name: string): boolean {
  return RESERVED_CREDENTIAL_NAMES.has(name) || RESERVED_CREDENTIAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export const credentialNamesSchema = z
  .array(z.string().regex(CREDENTIAL_NAME, "must be a valid environment variable name"))
  .default([])
  .superRefine((names, context) => {
    for (const [index, name] of names.entries()) {
      if (isReservedCredentialName(name)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `credential name ${name} is reserved for runtime isolation`,
        });
      }
    }
  });
