import type { ChildProcess, ChildProcessByStdio, ChildProcessWithoutNullStreams } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import type { Server } from "node:net";
import type { Readable } from "node:stream";

export interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface ShellLookupHandle {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly terminate: () => void;
}

export interface MockForwarderTemplate {
  readonly assetPath: string;
  readonly quote: (value: string) => string;
}

export interface MockForwarderSpec extends MockForwarderTemplate {
  readonly clientPath: string;
  readonly templateName: string;
  readonly targetFileName: (target: string) => string;
  readonly workspaceForwarder?: (target: string) => MockForwarderTemplate;
  readonly resolvePathTargetName: (selfPath: string, forwarderRoot: string) => string | undefined;
}

export interface MockEndpoint {
  readonly socketPath: string;
  readonly expectedNonce?: string;
  readonly cleanup: () => Promise<void>;
}

export interface SandboxPolicy {
  /** Read and write access. */
  readonly writableRoots: readonly string[];
  /** Read-only access. */
  readonly readableRoots: readonly string[];
  /**
   * Read everything the host user can read, as the check sandbox does after the evaluated agent
   * stopped. It replaces `readableRoots` for the read clauses.
   */
  readonly readAll?: boolean;
  /** Read-only single files, such as a launcher script. */
  readonly readableFiles?: readonly string[];
  /** Writable single files or Unix sockets outside `writableRoots`, such as a mock host socket. */
  readonly writableFiles?: readonly string[];
  /** Executables the sandbox may not start, such as the real binary behind a mocked command. */
  readonly denyExecutables?: readonly string[];
  /** Interactive terminal device; allow termios mode changes, not arbitrary ioctl operations. */
  readonly terminal?: string;
  readonly allowNetwork: boolean;
}

export interface CreateSandboxPolicyOptions {
  readonly writableRoots: readonly string[];
  readonly readableRoots: readonly string[];
  readonly readableFiles?: readonly string[];
  readonly writableFiles?: readonly string[];
  readonly denyExecutables?: readonly string[];
  readonly allowNetwork: boolean;
  readonly interactive: boolean;
}

export interface SupervisedProcess {
  readonly child: ChildProcess;
  /** Native workload exit code, not the supervisor's teardown exit. */
  readonly completion: Promise<number>;
  readonly stop: () => Promise<void>;
  /**
   * The workload's private report pipe at FD 5, present only when requested. FD 5 is not a
   * standard stream, so it stays out of the workload's own output; `spawn` closes it for the
   * workload's children, so untrusted descendants cannot write it.
   */
  readonly report?: Readable;
}

export interface SpawnSupervisedOptions {
  readonly policy: SandboxPolicy;
  readonly policyDirectory: string;
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly interactive: boolean;
  /** Add a private report pipe at FD 5 for the workload, exposed as `report`. */
  readonly report?: boolean;
}

export interface SpawnSandboxedOptions {
  readonly policy: SandboxPolicy;
  readonly policyDirectory: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface PlatformBackend {
  readonly systemPath: readonly string[];
  readonly caseInsensitivePaths: boolean;
  readonly executableExtensions: readonly string[];
  readonly usesPiShellWrapper: boolean;
  defaultTempParent?(): string;
  dirEnv(dirs: { readonly home: string; readonly tmp: string }): Record<string, string>;
  checkChildEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  openDirectoryIdentity(canonicalPath: string): Promise<DirectoryIdentity>;
  openRegularFileNoFollow(absolutePath: string): Promise<FileHandle>;
  isExecutableAccessible(path: string): Promise<boolean>;
  wrapExecutableCommand(executable: string, args: readonly string[]): readonly [string, ...string[]];
  spawnShellLookup(command: string, cwd: string): ShellLookupHandle;
  mockForwarderSpec(): MockForwarderSpec;
  listenMockServer(server: Server, runRootDir: string): Promise<MockEndpoint>;
  assertSandboxAvailable(): void;
  createSandboxPolicy(options: CreateSandboxPolicyOptions): SandboxPolicy;
  resolveDeniedExecutables(targets: readonly string[], pathEntries: readonly string[]): Promise<readonly string[]>;
  spawnSupervised(options: SpawnSupervisedOptions): Promise<SupervisedProcess>;
  spawnSandboxed(options: SpawnSandboxedOptions): Promise<ChildProcessWithoutNullStreams>;
}
