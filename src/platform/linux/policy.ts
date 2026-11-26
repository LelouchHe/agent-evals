import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CreateSandboxPolicyOptions, SandboxPolicy } from "../types.ts";

export type { SandboxPolicy };
export const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

const DISTRO_TOP_DIRS = ["/bin", "/sbin", "/lib", "/lib64"] as const;
const NETWORK_ETC_FILES = ["/etc/resolv.conf", "/etc/hosts"] as const;
const PROBE_TRUE_PATHS = ["/usr/bin/true", "/bin/true"] as const;

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
    { encoding: "utf8", timeout: 5_000 },
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

/** Build the `bwrap` argument list implementing `policy` around `command` and `args`. */
export function buildBwrapArgs(policy: SandboxPolicy, command: string, args: readonly string[]): string[] {
  const flags: string[] = ["--unshare-pid", "--die-with-parent", "--new-session"];
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

  const remountRo: string[] = [];
  if (policy.readAll === true) {
    flags.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc");
    if (!policy.allowNetwork) {
      // Mask host runtime/temp directories so pathname AF_UNIX sockets in /tmp and /run
      // cannot be reached when network access is denied; explicit readable/writable roots
      // beneath /tmp are re-mounted below, then the tmpfs parents are remounted read-only.
      flags.push("--tmpfs", "/tmp");
      remountRo.push("/tmp");
      if (safeLstat("/run") !== undefined) {
        flags.push("--tmpfs", "/run");
        remountRo.push("/run");
      }
      const varRun = safeLstat("/var/run");
      if (varRun !== undefined && varRun.isDirectory() && !varRun.isSymbolicLink()) {
        flags.push("--tmpfs", "/var/run");
        remountRo.push("/var/run");
      }
      for (const root of policy.readableRoots) {
        mountReadablePath(root, addRoBind, addSymlink);
      }
      for (const file of policy.readableFiles ?? []) {
        mountReadablePath(file, addRoBind, addSymlink);
      }
    }
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
        const info = safeLstat(file);
        if (info === undefined || !info.isSymbolicLink()) continue;
        const real = safeRealpath(file);
        if (real === undefined) continue;
        // Mount the final resolved target at the first symlink hop so multi-hop resolver
        // chains (systemd-resolved, OrbStack, WSL2) resolve inside the read-only /etc bind.
        const firstHop = resolve(dirname(file), readlinkSync(file));
        if (!firstHop.startsWith("/etc/") && !firstHop.startsWith("/usr/")) {
          addRoBind(real, firstHop);
        } else if (!real.startsWith("/etc/") && !real.startsWith("/usr/")) {
          addRoBind(real);
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
  for (const dir of remountRo) {
    flags.push("--remount-ro", dir);
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

  flags.push("--", command, ...args);
  return flags;
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
