import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sandboxExecutablePath, sandboxLaunchCommand } from "./policy.ts";

export interface SandboxSpawnOptions {
  readonly policyPath: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Launch a command inside the Seatbelt sandbox as its own process group.
 * The process group lets the owner terminate the harness and its children.
 */
export function spawnSandboxed(options: SandboxSpawnOptions): ChildProcessWithoutNullStreams {
  return spawn(sandboxExecutablePath(), sandboxLaunchCommand(options.policyPath, options.command, options.args), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
}
