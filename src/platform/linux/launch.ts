import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SpawnSandboxedOptions } from "../types.ts";
import { bwrapExecutablePath, prepareBwrapLaunch, trustedHostEnv } from "./policy.ts";

/**
 * Launch a command inside a bubblewrap sandbox as its own process group.
 * `--unshare-pid --die-with-parent` ensures the kernel reaps every descendant on exit,
 * while `--args` passes the workload environment via FD 3 instead of host env/argv.
 */
export async function spawnSandboxed(options: SpawnSandboxedOptions): Promise<ChildProcessWithoutNullStreams> {
  const executable = bwrapExecutablePath();
  const launch = await prepareBwrapLaunch(options.policyDirectory, options.policy, options.env);
  try {
    const stdio: Array<"pipe" | "ignore" | number> = ["pipe", "pipe", "pipe", launch.argsFd];
    if (launch.seccompFd !== undefined) stdio.push(launch.seccompFd);
    return spawn(executable, ["--args", "3", "--", options.command, ...options.args], {
      cwd: options.cwd,
      env: trustedHostEnv(),
      stdio,
      detached: true,
    }) as ChildProcessWithoutNullStreams;
  } finally {
    launch.closeFds();
  }
}
