import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, lstatSync, openSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CreateSandboxPolicyOptions, SandboxPolicy } from "../types.ts";

export type { SandboxPolicy };
export const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

const DISTRO_TOP_DIRS = ["/bin", "/sbin", "/lib", "/lib64"] as const;
const NETWORK_ETC_FILES = ["/etc/resolv.conf", "/etc/hosts"] as const;
const PROBE_TRUE_PATHS = ["/usr/bin/true", "/bin/true"] as const;

/** Minimal trusted environment for host-side launcher processes (`bwrap`, `script`). */
export function trustedHostEnv(includeTerm = false): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/sh",
    ...(includeTerm && process.env.TERM !== undefined ? { TERM: process.env.TERM } : {}),
  };
}

let cachedBwrapPath: string | undefined;

export function createSandboxPolicy(options: CreateSandboxPolicyOptions): SandboxPolicy {
  return {
    writableRoots: options.writableRoots,
    readableRoots: options.readableRoots,
    ...(options.readableFiles === undefined ? {} : { readableFiles: options.readableFiles }),
    ...(options.writableFiles === undefined ? {} : { writableFiles: options.writableFiles }),
    ...(options.denyExecutables === undefined ? {} : { denyExecutables: options.denyExecutables }),
    allowNetwork: options.allowNetwork,
  };
}

/** Verify `bwrap` is installed and unprivileged user namespaces work; fail closed otherwise. */
export function assertBwrapAvailable(): void {
  if (process.platform !== "linux") {
    throw new Error("the Linux bubblewrap backend requires linux");
  }
  if (cachedBwrapPath !== undefined) return;
  const bwrap = findBwrap();
  if (bwrap === undefined) {
    throw new Error(
      "the Linux sandbox requires bubblewrap (bwrap), which was not found on PATH; install bubblewrap (e.g. apt-get install bubblewrap)",
    );
  }
  const probeTrue = PROBE_TRUE_PATHS.find((candidate) => safeStat(candidate)?.isFile() === true);
  if (probeTrue === undefined) {
    throw new Error("the Linux sandbox could not find /usr/bin/true or /bin/true for preflight verification");
  }
  const probe = spawnSync(
    bwrap,
    ["--ro-bind", "/", "/", "--unshare-pid", "--die-with-parent", "--new-session", "--", probeTrue],
    { env: trustedHostEnv(), encoding: "utf8", timeout: 5_000 },
  );
  if (probe.error !== undefined || probe.status !== 0) {
    const detail = (probe.stderr || probe.error?.message || `exit status ${String(probe.status)}`).trim();
    throw new Error(
      `bubblewrap (bwrap) cannot create a sandbox on this host (${detail}); ensure unprivileged user namespaces are permitted`,
    );
  }
  cachedBwrapPath = bwrap;
}

export function bwrapExecutablePath(): string {
  assertBwrapAvailable();
  return cachedBwrapPath!;
}

/**
 * Build a minimal cBPF seccomp filter that denies `connect(2)` with `EPERM`, blocking both
 * pathname and abstract `AF_UNIX` sockets (which `--unshare-net` does not isolate) everywhere
 * on the filesystem while keeping ordinary read-only files accessible.
 */
export function buildDenyConnectSeccomp(arch: string = process.arch): Buffer {
  let auditArch: number;
  let sysConnect: number;
  if (arch === "arm64") {
    auditArch = 0xc00000b7; // AUDIT_ARCH_AARCH64
    sysConnect = 203;
  } else if (arch === "x64") {
    auditArch = 0xc000003e; // AUDIT_ARCH_X86_64
    sysConnect = 42;
  } else {
    throw new Error(`unsupported Linux architecture for seccomp network isolation: ${arch}`);
  }
  const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
  const SECCOMP_RET_ALLOW = 0x7fff0000;
  const insn = (code: number, jt: number, jf: number, k: number): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeUInt16LE(code, 0);
    buf.writeUInt8(jt, 2);
    buf.writeUInt8(jf, 3);
    buf.writeUInt32LE(k >>> 0, 4);
    return buf;
  };
  return Buffer.concat([
    insn(0x20, 0, 0, 4), // LD seccomp_data.arch
    insn(0x15, 1, 0, auditArch), // JEQ auditArch -> +1
    insn(0x06, 0, 0, SECCOMP_RET_ERRNO_EPERM), // unknown arch: fail closed
    insn(0x20, 0, 0, 0), // LD seccomp_data.nr
    insn(0x15, 0, 1, sysConnect), // JEQ SYS_connect -> next else +1
    insn(0x06, 0, 0, SECCOMP_RET_ERRNO_EPERM),
    insn(0x06, 0, 0, SECCOMP_RET_ALLOW),
  ]);
}

/** Build the `bwrap` option list (everything before `-- <command>`) implementing `policy`. */
export function buildBwrapOptions(
  policy: SandboxPolicy,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly newSession?: boolean;
    readonly seccompFd?: number;
  } = {},
): string[] {
  const flags: string[] = ["--unshare-pid", "--die-with-parent"];
  if (options.newSession !== false) {
    flags.push("--new-session");
  }
  if (!policy.allowNetwork) {
    flags.push("--unshare-net");
  }

  const roMounted = new Set<string>();
  const addRoBind = (source: string, dest = source): void => {
    const key = `${source}\0${dest}`;
    if (roMounted.has(key)) return;
    roMounted.add(key);
    flags.push("--ro-bind", source, dest);
  };
  const addSymlink = (target: string, dest: string): void => {
    const key = `sym\0${target}\0${dest}`;
    if (roMounted.has(key)) return;
    roMounted.add(key);
    flags.push("--symlink", target, dest);
  };

  if (policy.readAll === true) {
    flags.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc");
  } else {
    addRoBind("/usr");
    for (const dir of DISTRO_TOP_DIRS) {
      const info = safeLstat(dir);
      if (info === undefined) continue;
      if (info.isSymbolicLink()) {
        addSymlink(readlinkSync(dir), dir);
      } else if (info.isDirectory()) {
        addRoBind(dir);
      }
    }
    if (safeLstat("/etc") !== undefined) {
      addRoBind("/etc");
    }
    if (policy.allowNetwork) {
      for (const file of NETWORK_ETC_FILES) {
        const mount = resolveExternalSymlinkTarget(file);
        if (mount !== undefined) {
          addRoBind(mount.source, mount.dest);
        }
      }
    }
    flags.push("--dev", "/dev", "--proc", "/proc");

    for (const root of policy.readableRoots) {
      mountReadablePath(root, addRoBind, addSymlink);
    }
    for (const file of policy.readableFiles ?? []) {
      mountReadablePath(file, addRoBind, addSymlink);
    }
  }

  // Writable mounts come after read-only mounts so they overlay cleanly.
  const rwMounted = new Set<string>();
  const addRwBind = (path: string): void => {
    if (rwMounted.has(path)) return;
    rwMounted.add(path);
    flags.push("--bind", path, path);
  };
  const mountWritablePath = (rawPath: string): void => {
    const resolved = resolve(rawPath);
    const info = safeLstat(resolved);
    if (info === undefined) return;
    if (info.isSymbolicLink()) {
      const real = safeRealpath(resolved);
      if (real === undefined) return;
      addRwBind(real);
      addSymlink(real, resolved);
      return;
    }
    addRwBind(resolved);
    const real = safeRealpath(resolved);
    if (real !== undefined && real !== resolved) addRwBind(real);
  };

  for (const root of policy.writableRoots) {
    mountWritablePath(root);
  }
  for (const file of policy.writableFiles ?? []) {
    mountWritablePath(file);
  }

  // Denied executables come last, masking each real binary with non-executable /dev/null.
  const masked = new Set<string>();
  for (const executable of policy.denyExecutables ?? []) {
    const resolved = resolve(executable);
    const target = safeRealpath(resolved);
    if (target === undefined || masked.has(target)) continue;
    const info = safeStat(target);
    if (info === undefined || !info.isFile()) continue;
    masked.add(target);
    flags.push("--ro-bind", "/dev/null", target);
  }

  if (options.env !== undefined) {
    flags.push("--clearenv");
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined) {
        flags.push("--setenv", key, value);
      }
    }
  }

  if (options.seccompFd !== undefined) {
    flags.push("--seccomp", String(options.seccompFd));
  }

  return flags;
}

/** Build the full `bwrap` argument list implementing `policy` around `command` and `args`. */
export function buildBwrapArgs(policy: SandboxPolicy, command: string, args: readonly string[]): string[] {
  return [...buildBwrapOptions(policy), "--", command, ...args];
}

export interface PreparedBwrapLaunch {
  readonly argsFd: number;
  readonly seccompFd?: number;
  readonly closeFds: () => void;
}

/**
 * Write `bwrap` options (including `--clearenv`/`--setenv` workload env) and optional seccomp
 * BPF program into `policyDirectory` and return open read-only file descriptors for FDs 3 & 4.
 * Host launchers (`bwrap`, `script`) thus never receive workload env vars or secrets on argv.
 */
export async function prepareBwrapLaunch(
  policyDirectory: string,
  policy: SandboxPolicy,
  env: NodeJS.ProcessEnv,
  options: { readonly newSession?: boolean } = {},
): Promise<PreparedBwrapLaunch> {
  const needsSeccomp = !policy.allowNetwork;
  const seccompFd = needsSeccomp ? 4 : undefined;
  const bwrapOptions = buildBwrapOptions(policy, {
    env,
    ...(options.newSession === undefined ? {} : { newSession: options.newSession }),
    ...(seccompFd === undefined ? {} : { seccompFd }),
  });

  const argsPath = join(policyDirectory, "bwrap.args");
  await writeFile(argsPath, bwrapOptions.join("\0") + "\0", { mode: 0o600 });
  const openArgsFd = openSync(argsPath, constants.O_RDONLY);

  let openSeccompFd: number | undefined;
  if (needsSeccomp) {
    try {
      const bpfPath = join(policyDirectory, "bwrap.seccomp");
      await writeFile(bpfPath, buildDenyConnectSeccomp(), { mode: 0o600 });
      openSeccompFd = openSync(bpfPath, constants.O_RDONLY);
    } catch (error) {
      closeSync(openArgsFd);
      throw error;
    }
  }

  let closed = false;
  const closeFds = (): void => {
    if (closed) return;
    closed = true;
    try {
      closeSync(openArgsFd);
    } catch {
      // Already closed.
    }
    if (openSeccompFd !== undefined) {
      try {
        closeSync(openSeccompFd);
      } catch {
        // Already closed.
      }
    }
  };

  return {
    argsFd: openArgsFd,
    ...(openSeccompFd === undefined ? {} : { seccompFd: openSeccompFd }),
    closeFds,
  };
}

/**
 * Walk a symlink chain starting inside `/etc` until the first hop outside `/etc` and `/usr`.
 * Mounting the final resolved target at that first unmounted hop keeps multi-hop resolver
 * chains working inside the read-only `/etc` bind.
 */
export function resolveExternalSymlinkTarget(
  file: string,
  isMounted: (path: string) => boolean = (path) => path.startsWith("/etc/") || path.startsWith("/usr/"),
): { readonly source: string; readonly dest: string } | undefined {
  let current = file;
  let firstUnmounted: string | undefined;
  for (let depth = 0; depth < 16; depth++) {
    const info = safeLstat(current);
    if (info === undefined || !info.isSymbolicLink()) break;
    const next = resolve(dirname(current), readlinkSync(current));
    if (firstUnmounted === undefined && !isMounted(next)) {
      firstUnmounted = next;
    }
    current = next;
  }
  if (firstUnmounted === undefined) return undefined;
  const finalReal = safeRealpath(file);
  if (finalReal === undefined) return undefined;
  return { source: finalReal, dest: firstUnmounted };
}

function mountReadablePath(
  rawPath: string,
  addRoBind: (source: string, dest?: string) => void,
  addSymlink: (target: string, dest: string) => void,
): void {
  const resolved = resolve(rawPath);
  const info = safeLstat(resolved);
  if (info === undefined) return;
  if (info.isSymbolicLink()) {
    const real = safeRealpath(resolved);
    if (real === undefined) return;
    addRoBind(real);
    addSymlink(real, resolved);
    return;
  }
  addRoBind(resolved);
  const real = safeRealpath(resolved);
  if (real !== undefined && real !== resolved) addRoBind(real);
}

function findBwrap(): string | undefined {
  const candidates = [
    "/usr/bin/bwrap",
    "/bin/bwrap",
    ...(process.env.PATH ?? "")
      .split(":")
      .filter((entry) => entry.length > 0 && isAbsolute(entry))
      .map((entry) => join(entry, "bwrap")),
  ];
  for (const candidate of candidates) {
    const real = safeRealpath(candidate);
    if (real === undefined) continue;
    const info = safeStat(real);
    if (info === undefined || !info.isFile()) continue;
    try {
      accessSync(real, constants.X_OK);
      return real;
    } catch {
      // Keep searching.
    }
  }
  return undefined;
}

function safeLstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
