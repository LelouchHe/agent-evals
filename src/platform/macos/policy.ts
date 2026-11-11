import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
export interface SandboxPolicy {
  /** Read and write access. */
  readonly writableRoots: readonly string[];
  /** Read-only access. */
  readonly readableRoots: readonly string[];
  /** Read-only single files, such as a launcher script. */
  readonly readableFiles?: readonly string[];
  readonly allowNetwork: boolean;
}

/**
 * Render a deny-default macOS Seatbelt profile. Reads are limited to explicit
 * system/toolchain roots and run directories; writes are limited to run state.
 */
export function renderSeatbeltPolicy(policy: SandboxPolicy): string {
  const writable = normalize(policy.writableRoots);
  const readable = normalize([...policy.readableRoots, ...policy.writableRoots]);
  const files = normalize(policy.readableFiles ?? []);
  const readClauses = ['(literal "/")', ...readable.map((path) => `(subpath ${quote(path)})`), ...files.map((path) => `(literal ${quote(path)})`)];

  const metadata = new Set<string>();
  for (const path of [...readable, ...files]) {
    let current = dirname(path);
    while (current !== "/" && !metadata.has(current)) {
      metadata.add(current);
      current = dirname(current);
    }
    metadata.add("/");
  }

  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    `(allow file-read* ${readClauses.join(" ")})`,
  ];
  if (metadata.size > 0) {
    lines.push(`(allow file-read-metadata ${[...metadata].sort().map((path) => `(literal ${quote(path)})`).join(" ")})`);
  }
  const writeClauses = [...writable.map((path) => `(subpath ${quote(path)})`), '(literal "/dev/null")'];
  lines.push(`(allow file-write* ${writeClauses.join(" ")})`);
  if (policy.allowNetwork) {
    lines.push("(allow network-outbound)");
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
