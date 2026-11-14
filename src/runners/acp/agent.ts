import { z } from "zod";
import { ENV_NAME_PATTERN } from "../../engine/config.ts";
import { runRelativePathSchema } from "../../engine/params.ts";

const argument = z.string().min(1);
const command = z.tuple([argument]).rest(argument);

/** Set by ACP setup for every agent process; a declaration cannot replace them. */
export const RESERVED_VARIABLES: ReadonlySet<string> = new Set(["HOME", "TMPDIR", "PATH", "TERM"]);

/** Shared by standalone helper input and the ACP runner's inline agent object. */
export const agentSchema = z.strictObject({
  acpCommand: command,
  command: command.optional(),
  /** Extra variables for both commands, after placeholder substitution. */
  environment: z
    .record(z.string(), z.string())
    .superRefine((environment, context) => {
      for (const name of Object.keys(environment)) {
        if (!ENV_NAME_PATTERN.test(name)) {
          context.addIssue({ code: "custom", path: [name], message: "must be a variable name" });
        } else if (RESERVED_VARIABLES.has(name)) {
          context.addIssue({ code: "custom", path: [name], message: "is set by ACP setup" });
        }
      }
    })
    .default({}),
  home: z.strictObject({
    deps: argument,
    login: argument.optional(),
    path: z.array(runRelativePathSchema),
  }),
  login: z.array(runRelativePathSchema).optional(),
});

export type AgentConfig = z.output<typeof agentSchema>;
