import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { posixPlatformHelpers } from "../posix-helpers.ts";
import type { PlatformBackend } from "../types.ts";
import { spawnSandboxed } from "./launch.ts";
import { assertSeatbeltAvailable, createSandboxPolicy, SYSTEM_PATH } from "./policy.ts";
import { spawnSupervised } from "./supervise.ts";

/**
 * Resolve the real binaries behind PATH targets whose rules never pass. Besides the PATH
 * directories, the active Xcode developer directory is included because `/usr/bin/make` and
 * `/usr/bin/git` are macOS shims that exec the toolchain's own copy.
 */
async function resolveDeniedExecutables(
  targets: readonly string[],
  pathEntries: readonly string[],
): Promise<readonly string[]> {
  if (targets.length === 0) return [];
  const developerDir = await activeDeveloperDir();
  const dirs = developerDir === undefined ? pathEntries : [...pathEntries, join(developerDir, "usr", "bin")];
  const denied: string[] = [];
  for (const target of targets) {
    for (const dir of dirs) {
      const candidate = join(dir, target);
      try {
        if ((await stat(candidate)).isFile()) denied.push(candidate, await realpath(candidate));
      } catch {
        // Not installed here.
      }
    }
  }
  return denied;
}

async function activeDeveloperDir(): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("/usr/bin/xcode-select", ["-p"]);
    const path = stdout.trim();
    return path.length === 0 ? undefined : path;
  } catch {
    return undefined;
  }
}

export const macosBackend: PlatformBackend = {
  ...posixPlatformHelpers,
  systemPath: SYSTEM_PATH,
  caseInsensitivePaths: true,
  assertSandboxAvailable: assertSeatbeltAvailable,
  createSandboxPolicy,
  resolveDeniedExecutables,
  spawnSupervised,
  spawnSandboxed,
};
