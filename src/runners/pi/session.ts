import { access, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ConfigError, errorMessage } from "../../engine/config.ts";
import { spawnSandboxed } from "../../platform/macos/launch.ts";
import { writeSeatbeltPolicy, type SandboxPolicy } from "../../platform/macos/policy.ts";
import { PiProcess, PiRpcError } from "./rpc.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface PiSessionDirs {
  readonly workspaceDir: string;
  readonly homeDir: string;
  readonly configDir: string;
  readonly scratchDir: string;
}

export interface PiSessionConfig {
  readonly executable: string;
  /** Omit only for model-free probes; normal runner and judge sessions require it. */
  readonly model?: string;
  readonly thinking: ThinkingLevel;
  readonly dirs: PiSessionDirs;
  /** Absolute skill paths, already staged inside the isolated config area. */
  readonly skills: readonly string[];
  /** Built-in tools exposed to Pi, or null to disable every tool. */
  readonly tools: readonly string[] | null;
  readonly envPassthrough: readonly string[];
  readonly allowNetwork: boolean;
}

export interface PiInvocationResult {
  readonly finalText: string | null;
  readonly diagnostics: readonly string[];
}

export class PiSessionError extends Error {
  readonly diagnostics: readonly string[];

  constructor(message: string, diagnostics: readonly string[] = []) {
    super(message);
    this.name = "PiSessionError";
    this.diagnostics = diagnostics;
  }
}

/** Resolve the configured executable through PATH and canonicalize it. */
export async function resolvePiExecutable(executable: string): Promise<string> {
  if (executable.length === 0) {
    throw new ConfigError("pi executable must be a non-empty string");
  }
  const candidate = executable.includes("/") ? resolve(executable) : await findOnPath(executable);
  if (candidate === undefined) {
    throw new ConfigError(`pi executable not found on PATH: ${executable}`);
  }
  try {
    return await realpath(candidate);
  } catch (error) {
    throw new ConfigError(`pi executable is not accessible: ${candidate}: ${errorMessage(error)}`);
  }
}

/** Validate that every forwarded environment variable is present. */
export function validateEnvPassthrough(names: readonly string[]): void {
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ConfigError(`envPassthrough contains an invalid variable name: ${name}`);
    }
    if (process.env[name] === undefined) {
      throw new ConfigError(`envPassthrough requires ${name} to be set in the invoking environment`);
    }
  }
}

/**
 * Run one isolated Pi RPC invocation. The Pi process and its descendants are
 * always stopped before this function returns or throws.
 */
export async function invokePi(
  config: PiSessionConfig,
  message: string,
  options: {
    timeoutMs: number;
    signal: AbortSignal;
    /** Lets the owner request process termination, for example on an engine timeout. */
    onProcess?: (stop: () => Promise<void>) => void;
  },
): Promise<PiInvocationResult> {
  if (options.signal.aborted) {
    throw new PiSessionError("Pi invocation was aborted before launch");
  }
  const process = await createPiProcess(config);
  const settled = process.waitForEvent("agent_settled", options.timeoutMs, options.signal);
  // A startup failure can reject this waiter before it is awaited below.
  settled.catch(() => {});
  options.onProcess?.(() => process.stop());
  try {
    const response = (await process.command("prompt", { message })) as { disposition?: unknown } | undefined;
    const disposition = response?.disposition;
    if (disposition !== "started") {
      throw new PiSessionError(`Pi did not start a run for the prompt (disposition: ${String(disposition)})`, diagnosticsOf(process));
    }
    const event = await settled;
    if (event.aborted === true) {
      throw new PiSessionError("Pi reported that the run was aborted", diagnosticsOf(process));
    }
    const data = (await process.command("get_last_assistant_text")) as { text?: unknown } | undefined;
    const finalText = typeof data?.text === "string" ? data.text : null;
    return { finalText, diagnostics: diagnosticsOf(process) };
  } catch (error) {
    if (error instanceof PiSessionError) {
      throw error;
    }
    if (error instanceof PiRpcError) {
      throw new PiSessionError(error.message, error.diagnostics);
    }
    throw new PiSessionError(errorMessage(error), diagnosticsOf(process));
  } finally {
    await process.stop();
  }
}

/** Prepare isolated state and start an RPC process without prompting it. */
export async function createPiProcess(config: PiSessionConfig): Promise<PiProcess> {
  const executable = await resolvePiExecutable(config.executable);
  await mkdir(config.dirs.homeDir, { recursive: true, mode: 0o700 });
  await mkdir(config.dirs.scratchDir, { recursive: true, mode: 0o700 });
  await mkdir(config.dirs.configDir, { recursive: true, mode: 0o700 });
  await writeIsolatedSettings(config.dirs.configDir);

  const policy = await buildPolicy(executable, config);
  const policyPath = await writeSeatbeltPolicy(config.dirs.scratchDir, policy);
  const args = buildPiArgs(config);
  const env = buildEnvironment(config);
  return new PiProcess({
    spawn: () =>
      spawnSandboxed({
        policyPath,
        command: executable,
        args,
        cwd: config.dirs.workspaceDir,
        env,
      }),
  });
}

export async function buildPolicy(executable: string, config: PiSessionConfig): Promise<SandboxPolicy> {
  const nodeExecutable = await realpath(process.execPath);
  const nodeDirectory = dirname(nodeExecutable);
  const readableRoots = new Set<string>([
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/private/etc",
    "/Library",
    "/dev",
    "/private/var/select",
    "/private/var/db/timezone",
    nodeDirectory,
  ]);
  if (basename(nodeDirectory) === "bin") {
    readableRoots.add(dirname(nodeDirectory));
  }

  // A managed Pi launcher lives in <root>/bin and reads <root>/install.
  const executableDirectory = dirname(executable);
  readableRoots.add(executableDirectory);
  const installRoot = join(dirname(executableDirectory), "install");
  if (await isDirectory(installRoot)) {
    readableRoots.add(installRoot);
  }
  const nodeModulesRoot = findAncestor(executable, "node_modules");
  if (nodeModulesRoot !== undefined) {
    readableRoots.add(nodeModulesRoot);
  }

  return {
    writableRoots: [config.dirs.workspaceDir, config.dirs.homeDir, config.dirs.configDir, config.dirs.scratchDir],
    readableRoots: [...readableRoots],
    readableFiles: [executable],
    allowNetwork: config.allowNetwork,
  };
}

function buildPiArgs(config: PiSessionConfig): string[] {
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-skills",
    ...config.skills.flatMap((skill) => ["--skill", skill]),
    "--no-extensions",
    "--no-mcp",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    config.tools === null ? "--no-tools" : "--tools",
    ...(config.tools === null ? [] : [config.tools.join(",")]),
    ...(config.model === undefined ? [] : ["--model", config.model]),
    "--thinking",
    config.thinking,
  ];
  return args;
}

function buildEnvironment(config: PiSessionConfig): NodeJS.ProcessEnv {
  const nodeDirectory = dirname(process.execPath);
  const env: NodeJS.ProcessEnv = {
    PATH: [nodeDirectory, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: config.dirs.homeDir,
    TMPDIR: config.dirs.scratchDir,
    TMP: config.dirs.scratchDir,
    TEMP: config.dirs.scratchDir,
    PI_CODING_AGENT_DIR: config.dirs.configDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    LANG: "en_US.UTF-8",
  };
  for (const name of config.envPassthrough) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

async function writeIsolatedSettings(configDir: string): Promise<void> {
  const settings = {
    quietStartup: true,
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    retry: { enabled: false },
  };
  await writeFile(join(configDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

async function findOnPath(name: string): Promise<string | undefined> {
  const path = process.env.PATH ?? "";
  for (const directory of path.split(":")) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function findAncestor(path: string, name: string): string | undefined {
  let current = dirname(path);
  for (let depth = 0; depth < 12; depth += 1) {
    if (basename(current) === name) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

function diagnosticsOf(process: PiProcess): string[] {
  const diagnostics = [...process.protocolErrors, ...process.errorEvents];
  if (process.stderrTail.trim().length > 0) {
    diagnostics.push(`stderr: ${process.stderrTail.trim().slice(-4_000)}`);
  }
  return diagnostics;
}
