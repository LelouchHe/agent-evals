import { z } from "zod";
import { runRelativePathSchema } from "../../engine/params.ts";

const argument = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "must not contain NUL");
const command = z.tuple([argument]).rest(argument);
const relative = runRelativePathSchema.refine((value) => !value.includes("\0"), "must not contain NUL");

/** Shared by standalone helper input and the future ACP runner's inline agent object. */
export const agentSchema = z.strictObject({
  acpCommand: command,
  command: command.optional(),
  home: z.strictObject({
    deps: argument,
    login: argument.optional(),
    path: z.array(relative),
  }),
  login: z.array(relative).optional(),
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
    .refine(
      (env) => !["HOME", "PATH", "TMPDIR"].some((key) => Object.hasOwn(env, key)),
      "HOME, PATH and TMPDIR are provided by the runtime",
    )
    .default({}),
});

export type AgentConfig = z.output<typeof agentSchema>;
