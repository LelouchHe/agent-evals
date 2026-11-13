import { z } from "zod";
import { runRelativePathSchema } from "../../engine/params.ts";

const argument = z.string().min(1);
const command = z.tuple([argument]).rest(argument);

/** Shared by standalone helper input and the future ACP runner's inline agent object. */
export const agentSchema = z.strictObject({
  acpCommand: command,
  command: command.optional(),
  home: z.strictObject({
    deps: argument,
    login: argument.optional(),
    path: z.array(runRelativePathSchema),
  }),
  login: z.array(runRelativePathSchema).optional(),
});

export type AgentConfig = z.output<typeof agentSchema>;
