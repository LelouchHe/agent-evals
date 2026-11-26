import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateSandboxPolicyOptions, SandboxPolicy } from "../types.ts";

const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";

const PROGRAM_FILES = process.env.ProgramFiles ?? "C:\\Program Files";

export const SYSTEM_PATH: readonly string[] = [
  join(SYSTEM_ROOT, "System32"),
  SYSTEM_ROOT,
  join(SYSTEM_ROOT, "System32", "Wbem"),
  join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0"),
  join(PROGRAM_FILES, "PowerShell", "7"),
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

export function defaultTempParent(): string {
  const fromEnv = process.env.AGENT_EVALS_WIN_RUNS_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return resolve(fromEnv);
  return join(process.env.ProgramData ?? "C:\\ProgramData", "agent-evals", "runs");
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
  setDefault("ProgramFiles", PROGRAM_FILES);
  if (process.env["ProgramFiles(x86)"] !== undefined && process.env["ProgramFiles(x86)"].length > 0) {
    setDefault("ProgramFiles(x86)", process.env["ProgramFiles(x86)"]);
  }
  setDefault("ProgramData", process.env.ProgramData ?? join(systemDrive, "ProgramData"));
  setDefault("ComSpec", join(SYSTEM_ROOT, "System32", "cmd.exe"));
  setDefault("PATHEXT", ".COM;.EXE;.BAT;.CMD");
  setDefault("USERPROFILE", userProfile);
  setDefault("LOCALAPPDATA", join(userProfile, "AppData", "Local"));
  setDefault("APPDATA", join(userProfile, "AppData", "Roaming"));
  setDefault("PATH", SYSTEM_PATH.join(";"));
  return result;
}

/**
 * Resolve a bare program name against the workload's PATH (including `.exe`/`.cmd`/`.bat`)
 * and wrap `.cmd`/`.bat` shims with `cmd.exe /d /c` because Win32 `CreateProcessAsUserW`
 * cannot execute batch files directly.
 */
export function resolveWindowsCommand(
  program: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): { readonly command: string; readonly args: readonly string[] } {
  const comSpec = env.ComSpec ?? join(SYSTEM_ROOT, "System32", "cmd.exe");
  const isRegular = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  let resolved = program;
  if (!program.includes("\\") && !program.includes("/")) {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
    const pathVal = pathKey === undefined ? "" : (env[pathKey] ?? "");
    const exts = /\.[a-z0-9]+$/iu.test(program) ? [""] : [".exe", ".cmd", ".bat", ".com", ""];
    outer: for (const dir of pathVal.split(delimiter)) {
      if (dir.length === 0) continue;
      for (const ext of exts) {
        const candidate = join(dir, `${program}${ext}`);
        if (isRegular(candidate)) {
          resolved = candidate;
          break outer;
        }
      }
    }
  }
  if (/\.(?:cmd|bat)$/iu.test(resolved)) {
    return { command: comSpec, args: ["/d", "/c", resolved, ...args] };
  }
  return { command: resolved, args };
}
