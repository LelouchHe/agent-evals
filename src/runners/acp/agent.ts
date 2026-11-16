import { z } from "zod";
import { ENV_NAME_PATTERN } from "../../engine/config.ts";
import { runRelativePathSchema } from "../../engine/params.ts";

const argument = z.string().min(1);
const command = z.tuple([argument]).rest(argument);

/** Set by ACP setup for every agent process; a declaration cannot replace them. */
export const RESERVED_VARIABLES: ReadonlySet<string> = new Set(["HOME", "TMPDIR", "PATH", "TERM"]);

/** Persistent login state: one native command, one directory, the files that compose it. */
const loginSchema = z.strictObject({
  command,
  dir: argument,
  files: z.array(runRelativePathSchema).min(1, "must list at least one login file"),
});

/** Shared by standalone helper input and the ACP runner's inline agent object. */
export const agentSchema = z.strictObject({
  acpCommand: command,
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
  /** Caller-prepared software, linked into the run as `deps`. */
  deps: argument,
  /** `deps`-relative command directories; the caller owns the software layout. */
  path: z.array(runRelativePathSchema).default(["bin"]),
  /** What the agent file places in HOME: `~/` destination to authoring source. */
  files: z.record(z.string(), z.string()).optional(),
  login: loginSchema.optional(),
});

export type AgentConfig = z.output<typeof agentSchema>;
