import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SpawnSandboxedOptions } from "../types.ts";
import { sandboxExecutablePath, sandboxLaunchCommand, writeSeatbeltPolicy } from "./policy.ts";

/**
 * Launch a command inside the Seatbelt sandbox as its own process group.
 * The process group lets the owner terminate the harness and its children.
 */
export async function spawnSandboxed(options: SpawnSandboxedOptions): Promise<ChildProcessWithoutNullStreams> {
  const executable = sandboxExecutablePath();
  const policyPath = await writeSeatbeltPolicy(options.policyDirectory, options.policy);
  return spawn(executable, sandboxLaunchCommand(policyPath, options.command, options.args), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
}
