import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { linuxBackend } from "./linux/index.ts";
import { macosBackend } from "./macos/index.ts";
import type {
  CreateSandboxPolicyOptions,
  PlatformBackend,
  SandboxPolicy,
  SpawnSandboxedOptions,
  SpawnSupervisedOptions,
  SupervisedProcess,
} from "./types.ts";

export type {
  CreateSandboxPolicyOptions,
  PlatformBackend,
  SandboxPolicy,
  SpawnSandboxedOptions,
  SpawnSupervisedOptions,
  SupervisedProcess,
};

function unsupportedPlatform(): never {
  throw new Error(`unsupported host platform: ${process.platform}; supported platforms are darwin and linux`);
}

const unsupportedBackend: PlatformBackend = {
  systemPath: [],
  caseInsensitivePaths: false,
  assertSandboxAvailable: unsupportedPlatform,
  createSandboxPolicy: unsupportedPlatform,
  resolveDeniedExecutables: async () => unsupportedPlatform(),
  spawnSupervised: async () => unsupportedPlatform(),
  spawnSandboxed: async () => unsupportedPlatform(),
};

const backend: PlatformBackend =
  process.platform === "darwin" ? macosBackend : process.platform === "linux" ? linuxBackend : unsupportedBackend;

export const isSandboxPlatformSupported = process.platform === "darwin" || process.platform === "linux";
export const SYSTEM_PATH: readonly string[] = backend.systemPath;
export const caseInsensitivePaths: boolean = backend.caseInsensitivePaths;

export function defaultTempParent(): string {
  return backend.defaultTempParent?.() ?? tmpdir();
}

export function assertSandboxAvailable(): void {
  backend.assertSandboxAvailable();
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
