import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SpawnSandboxedOptions } from "../types.ts";
import { buildBwrapArgs, bwrapExecutablePath } from "./policy.ts";

/**
 * Launch a command inside a bubblewrap sandbox as its own process group.
 * `--unshare-pid --die-with-parent` ensures the kernel reaps every descendant on exit.
 */
export async function spawnSandboxed(options: SpawnSandboxedOptions): Promise<ChildProcessWithoutNullStreams> {
  const executable = bwrapExecutablePath();
  return spawn(executable, buildBwrapArgs(options.policy, options.command, options.args), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
}
