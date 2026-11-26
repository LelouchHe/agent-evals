import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PlatformBackend } from "../types.ts";
import { spawnSandboxed } from "./launch.ts";
import { assertBwrapAvailable, createSandboxPolicy, SYSTEM_PATH } from "./policy.ts";
import { spawnSupervised } from "./supervise.ts";

async function resolveDeniedExecutables(
  targets: readonly string[],
  pathEntries: readonly string[],
): Promise<readonly string[]> {
  if (targets.length === 0) return [];
  const denied: string[] = [];
  for (const target of targets) {
    for (const dir of pathEntries) {
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

export const linuxBackend: PlatformBackend = {
  systemPath: SYSTEM_PATH,
  caseInsensitivePaths: false,
  assertSandboxAvailable: assertBwrapAvailable,
  createSandboxPolicy,
  resolveDeniedExecutables,
  spawnSupervised,
  spawnSandboxed,
};
