import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PlatformBackend } from "../types.ts";
import { spawnSandboxed } from "./launch.ts";
import { assertWinSandboxAvailable, createSandboxPolicy, SYSTEM_PATH } from "./policy.ts";
import { spawnSupervised } from "./supervise.ts";

async function resolveDeniedExecutables(
  targets: readonly string[],
  pathEntries: readonly string[],
): Promise<readonly string[]> {
  if (targets.length === 0) return [];
  const denied: string[] = [];
  for (const target of targets) {
    for (const dir of pathEntries) {
      for (const ext of ["", ".exe", ".cmd", ".bat"]) {
        const candidate = join(dir, `${target}${ext}`);
        try {
          if ((await stat(candidate)).isFile()) denied.push(candidate, await realpath(candidate));
        } catch {
          // Not installed here.
        }
      }
    }
  }
  return denied;
}

export const windowsBackend: PlatformBackend = {
  systemPath: SYSTEM_PATH,
  caseInsensitivePaths: true,
  assertSandboxAvailable: assertWinSandboxAvailable,
  createSandboxPolicy,
  resolveDeniedExecutables,
  spawnSupervised,
  spawnSandboxed,
};
