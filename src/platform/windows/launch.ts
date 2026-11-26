import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SpawnSandboxedOptions } from "../types.ts";
import { buildWindowsWorkloadEnv, winSandboxCredentialsPath, winSandboxExecutablePath } from "./policy.ts";

export async function spawnSandboxed(options: SpawnSandboxedOptions): Promise<ChildProcessWithoutNullStreams> {
  const helper = winSandboxExecutablePath();
  await mkdir(options.policyDirectory, { recursive: true });
  const configPath = join(options.policyDirectory, `win-sandbox-${randomUUID()}.json`);
  const config = {
    command: options.command,
    args: [...options.args],
    cwd: resolve(options.cwd),
    env: buildWindowsWorkloadEnv(options.env),
    writableRoots: options.policy.writableRoots,
    readableRoots: options.policy.readableRoots,
    writableFiles: options.policy.writableFiles ?? [],
    readableFiles: options.policy.readableFiles ?? [],
    allowNetwork: options.policy.allowNetwork,
    credentialsPath: winSandboxCredentialsPath(),
  };
  await writeFile(configPath, JSON.stringify(config), "utf8");

  return spawn(helper, ["--config", configPath, "--delete-config"], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}
