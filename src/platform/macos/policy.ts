import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

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
  /** Executables the sandbox may not start, such as the real binary behind a mocked command. */
  readonly denyExecutables?: readonly string[];
  /** Interactive terminal device; allow termios mode changes, not arbitrary ioctl operations. */
  readonly terminal?: string;
  readonly allowNetwork: boolean;
}

/** Add macOS system access and current-terminal handling to caller-owned roots. */
export function createSandboxPolicy(
  options: Pick<SandboxPolicy, "writableRoots" | "readableRoots" | "allowNetwork" | "denyExecutables"> & {
    readonly interactive: boolean;
  },
): SandboxPolicy {
  const terminal =
    options.interactive && process.stdin.isTTY
      ? execFileSync("/usr/bin/tty", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim()
      : undefined;
  return {
    writableRoots: options.writableRoots,
    readableRoots: [
      "/System",
      "/usr",
      "/bin",
      "/sbin",
      "/private/etc",
      "/Library",
      "/dev",
      "/private/var/select",
      "/private/var/db/timezone",
      ...(options.allowNetwork ? ["/private/var/db/mds"] : []),
      ...options.readableRoots,
    ],
    readableFiles: ["/var", "/etc"],
    ...(options.denyExecutables === undefined ? {} : { denyExecutables: options.denyExecutables }),
    allowNetwork: options.allowNetwork,
    ...(terminal === undefined ? {} : { terminal }),
  };
}

/**
 * Render a deny-default macOS Seatbelt profile. Reads are limited to explicit
 * system/toolchain roots and run directories; writes are limited to run state.
 */
export function renderSeatbeltPolicy(policy: SandboxPolicy): string {
  const writable = normalize(policy.writableRoots);
  const readable = normalize([...policy.readableRoots, ...policy.writableRoots]);
  const terminals = policy.terminal === undefined ? [] : normalize([policy.terminal, "/dev/tty"]);
  const files = normalize([...(policy.readableFiles ?? []), ...terminals]);
  const readClauses = [
    '(literal "/")',
    ...readable.map((path) => `(subpath ${quote(path)})`),
    ...files.map((path) => `(literal ${quote(path)})`),
  ];

  const metadata = new Set<string>();
  for (const path of [...readable, ...files]) {
    let current = dirname(path);
    while (current !== "/" && !metadata.has(current)) {
      metadata.add(current);
      current = dirname(current);
    }
    metadata.add("/");
  }

  const denied = normalize(policy.denyExecutables ?? []);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec*)",
    ...(denied.length === 0
      ? []
      : [`(deny process-exec ${denied.map((path) => `(literal ${quote(path)})`).join(" ")})`]),
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    policy.readAll === true ? "(allow file-read*)" : `(allow file-read* ${readClauses.join(" ")})`,
  ];
  if (policy.readAll !== true && metadata.size > 0) {
    lines.push(
      `(allow file-read-metadata ${[...metadata]
        .sort()
        .map((path) => `(literal ${quote(path)})`)
        .join(" ")})`,
    );
  }
  const terminalClauses = terminals.map((path) => `(literal ${quote(path)})`);
  const writeClauses = [
    ...writable.map((path) => `(subpath ${quote(path)})`),
    ...terminalClauses,
    '(literal "/dev/null")',
  ];
  lines.push(`(allow file-write* ${writeClauses.join(" ")})`);
  if (terminals.length > 0) {
    lines.push(
      `(allow file-ioctl (require-all (require-any ${terminalClauses.join(" ")}) (ioctl-command TIOCSETA TIOCSETAW TIOCSETAF)))`,
    );
  }
  if (policy.allowNetwork) {
    lines.push(
      "(allow network-outbound)",
      // System TLS trust evaluation and directory membership for native HTTPS stacks (e.g. Rust/Security.framework).
      '(allow mach-lookup (global-name "com.apple.SecurityServer" "com.apple.trustd.agent" "com.apple.system.opendirectoryd.membership"))',
    );
  }
  return lines.join("\n") + "\n";
}

/** Write a profile outside the evaluated workspace, then return its path. */
export async function writeSeatbeltPolicy(directory: string, policy: SandboxPolicy): Promise<string> {
  const path = join(directory, "sandbox.sb");
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(renderSeatbeltPolicy(policy), "utf8");
  } finally {
    await handle.close();
  }
  return resolve(path);
}

export function assertSeatbeltAvailable(): void {
  if (process.platform !== "darwin") {
    throw new Error("the macOS Seatbelt backend requires darwin");
  }
}

export function sandboxExecutablePath(): string {
  assertSeatbeltAvailable();
  return "/usr/bin/sandbox-exec";
}

export function sandboxLaunchCommand(policyPath: string, command: string, args: readonly string[]): string[] {
  return ["-f", policyPath, "--", command, ...args];
}

function normalize(paths: readonly string[]): string[] {
  const values = new Set<string>();
  for (const path of paths) {
    const resolved = resolve(path);
    values.add(resolved);
    try {
      values.add(realpathSync(resolved));
    } catch {
      // The path may not exist yet; the resolved form still scopes it.
    }
  }
  return [...values].sort();
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
