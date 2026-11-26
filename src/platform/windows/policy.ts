import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateSandboxPolicyOptions, SandboxPolicy } from "../types.ts";

const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";

export const SYSTEM_PATH: readonly string[] = [
  join(SYSTEM_ROOT, "System32"),
  SYSTEM_ROOT,
  join(SYSTEM_ROOT, "System32", "Wbem"),
  join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0"),
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let resolvedHelperPath: string | undefined;

export function winSandboxExecutablePath(): string {
  if (resolvedHelperPath !== undefined) return resolvedHelperPath;

  const candidates = [
    process.env.AGENT_EVALS_WIN_SANDBOX_BIN,
    join(REPO_ROOT, "native", "win-sandbox", "target", "release", "win-sandbox.exe"),
    join(REPO_ROOT, "native", "win-sandbox", "target", "debug", "win-sandbox.exe"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK);
      resolvedHelperPath = candidate;
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  throw new Error(
    `Windows sandbox helper (win-sandbox.exe) not found; checked: ${candidates.join(", ")}. Set AGENT_EVALS_WIN_SANDBOX_BIN or build native/win-sandbox.`,
  );
}

export function winSandboxCredentialsPath(): string {
  const fromEnv = process.env.AGENT_EVALS_WIN_SANDBOX_CREDENTIALS;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return resolve(fromEnv);
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData === "string" && localAppData.length > 0) {
    return join(localAppData, "agent-evals", "sandbox-users.json");
  }
  throw new Error(
    "Cannot locate Windows sandbox credentials file; run scripts/windows-sandbox-setup.ps1 or set AGENT_EVALS_WIN_SANDBOX_CREDENTIALS.",
  );
}

let probed = false;

export function assertWinSandboxAvailable(): void {
  if (probed) return;
  const helper = winSandboxExecutablePath();
  const credsPath = winSandboxCredentialsPath();
  try {
    execFileSync(helper, ["--probe", credsPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Windows sandbox-user preflight failed (${helper} --probe ${credsPath}): ${detail}. Run scripts/windows-sandbox-setup.ps1 as Administrator.`,
      { cause: error },
    );
  }
  probed = true;
}

export function createSandboxPolicy(options: CreateSandboxPolicyOptions): SandboxPolicy {
  return {
    writableRoots: options.writableRoots.map((p) => resolve(p)),
    readableRoots: options.readableRoots.map((p) => resolve(p)),
    ...(options.readableFiles === undefined ? {} : { readableFiles: options.readableFiles.map((p) => resolve(p)) }),
    ...(options.writableFiles === undefined ? {} : { writableFiles: options.writableFiles.map((p) => resolve(p)) }),
    ...(options.denyExecutables === undefined
      ? {}
      : { denyExecutables: options.denyExecutables.map((p) => resolve(p)) }),
    allowNetwork: options.allowNetwork,
  };
}

export function buildWindowsWorkloadEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const seenLower = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.includes("\0") || key.includes("=") || value.includes("\0")) {
      throw new Error(`invalid environment variable "${key}": NUL bytes and '=' in keys are not allowed`);
    }
    result[key] = value;
    seenLower.add(key.toLowerCase());
  }
  const setDefault = (key: string, value: string): void => {
    if (!seenLower.has(key.toLowerCase())) {
      result[key] = value;
      seenLower.add(key.toLowerCase());
    }
  };
  const systemDrive = process.env.SystemDrive ?? SYSTEM_ROOT.slice(0, 2);
  const userProfile = result.USERPROFILE ?? result.HOME ?? result.TEMP ?? result.TMP ?? SYSTEM_ROOT;
  setDefault("SystemRoot", SYSTEM_ROOT);
  setDefault("WINDIR", SYSTEM_ROOT);
  setDefault("SystemDrive", systemDrive);
  setDefault("ComSpec", join(SYSTEM_ROOT, "System32", "cmd.exe"));
  setDefault("PATHEXT", ".COM;.EXE;.BAT;.CMD");
  setDefault("USERPROFILE", userProfile);
  setDefault("LOCALAPPDATA", join(userProfile, "AppData", "Local"));
  setDefault("APPDATA", join(userProfile, "AppData", "Roaming"));
  setDefault("PATH", SYSTEM_PATH.join(";"));
  return result;
}
