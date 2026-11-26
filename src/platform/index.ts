import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { linuxBackend } from "./linux/index.ts";
import { macosBackend } from "./macos/index.ts";
import { windowsBackend } from "./windows/index.ts";
import type {
  CreateSandboxPolicyOptions,
  DirectoryIdentity,
  MockEndpoint,
  MockForwarderSpec,
  MockForwarderTemplate,
  PlatformBackend,
  SandboxPolicy,
  ShellLookupHandle,
  SpawnSandboxedOptions,
  SpawnSupervisedOptions,
  SupervisedProcess,
} from "./types.ts";

export type {
  CreateSandboxPolicyOptions,
  DirectoryIdentity,
  MockEndpoint,
  MockForwarderSpec,
  MockForwarderTemplate,
  PlatformBackend,
  SandboxPolicy,
  ShellLookupHandle,
  SpawnSandboxedOptions,
  SpawnSupervisedOptions,
  SupervisedProcess,
};

function unsupportedPlatform(): never {
  throw new Error(`unsupported host platform: ${process.platform}; supported platforms are darwin, linux, and win32`);
}

const unsupportedBackend: PlatformBackend = {
  systemPath: [],
  caseInsensitivePaths: false,
  executableExtensions: [""],
  usesPiShellWrapper: false,
  dirEnv: (dirs) => ({ HOME: dirs.home, TMPDIR: dirs.tmp }),
  checkChildEnv: (env) => ({ PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR }),
  openDirectoryIdentity: async () => unsupportedPlatform(),
  openRegularFileNoFollow: async () => unsupportedPlatform(),
  isExecutableAccessible: async () => false,
  wrapExecutableCommand: (executable, args) => [executable, ...args],
  spawnShellLookup: () => unsupportedPlatform(),
  mockForwarderSpec: () => unsupportedPlatform(),
  listenMockServer: async () => unsupportedPlatform(),
  assertSandboxAvailable: unsupportedPlatform,
  setupSandbox: async () => unsupportedPlatform(),
  createSandboxPolicy: unsupportedPlatform,
  resolveDeniedExecutables: async () => unsupportedPlatform(),
  spawnSupervised: async () => unsupportedPlatform(),
  spawnSandboxed: async () => unsupportedPlatform(),
};

const backend: PlatformBackend =
  process.platform === "darwin"
    ? macosBackend
    : process.platform === "linux"
      ? linuxBackend
      : process.platform === "win32"
        ? windowsBackend
        : unsupportedBackend;

export const isSandboxPlatformSupported =
  process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";
export const SYSTEM_PATH: readonly string[] = backend.systemPath;
export const caseInsensitivePaths: boolean = backend.caseInsensitivePaths;
export const executableExtensions: readonly string[] = backend.executableExtensions;
export const usesPiShellWrapper: boolean = backend.usesPiShellWrapper;

export function defaultTempParent(): string {
  return backend.defaultTempParent?.() ?? tmpdir();
}

export function dirEnv(dirs: { readonly home: string; readonly tmp: string }): Record<string, string> {
  return backend.dirEnv(dirs);
}

export function checkChildEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return backend.checkChildEnv(sourceEnv);
}

export function openDirectoryIdentity(canonicalPath: string): Promise<DirectoryIdentity> {
  return backend.openDirectoryIdentity(canonicalPath);
}

export function openRegularFileNoFollow(absolutePath: string): Promise<FileHandle> {
  return backend.openRegularFileNoFollow(absolutePath);
}

export function isExecutableAccessible(path: string): Promise<boolean> {
  return backend.isExecutableAccessible(path);
}

export function wrapExecutableCommand(executable: string, args: readonly string[]): readonly [string, ...string[]] {
  return backend.wrapExecutableCommand(executable, args);
}

export function spawnShellLookup(command: string, cwd: string): ShellLookupHandle {
  return backend.spawnShellLookup(command, cwd);
}

export function mockForwarderSpec(): MockForwarderSpec {
  return backend.mockForwarderSpec();
}

export function listenMockServer(server: Server, runRootDir: string): Promise<MockEndpoint> {
  return backend.listenMockServer(server, runRootDir);
}

export function assertSandboxAvailable(): void {
  backend.assertSandboxAvailable();
}

export function setupSandbox(options: { readonly teardown: boolean }): Promise<string> {
  return backend.setupSandbox(options);
}

export function createSandboxPolicy(options: CreateSandboxPolicyOptions): SandboxPolicy {
  return backend.createSandboxPolicy(options);
}

export function resolveDeniedExecutables(
  targets: readonly string[],
  pathEntries: readonly string[],
): Promise<readonly string[]> {
  return backend.resolveDeniedExecutables(targets, pathEntries);
}

export function spawnSupervised(options: SpawnSupervisedOptions): Promise<SupervisedProcess> {
  return backend.spawnSupervised(options);
}

export function spawnSandboxed(options: SpawnSandboxedOptions): Promise<ChildProcessWithoutNullStreams> {
  return backend.spawnSandboxed(options);
}
