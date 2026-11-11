import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigError, errorMessage } from "./config.ts";

/** Largest file a check will read. Checks stay bounded and predictable. */
export const MAX_CHECK_BYTES = 1024 * 1024;

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/**
 * Resolve a run-relative path without allowing it to leave the workspace.
 * Symlinks are resolved (including ancestor symlinks) and rejected when they
 * escape. A broken symlink is rejected rather than treated as a missing file.
 */
export async function resolveWorkspacePath(rootDir: string, requestedPath: string): Promise<string> {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new WorkspacePathError("path must be a non-empty string");
  }
  if (requestedPath.includes("\0")) {
    throw new WorkspacePathError("path contains a NUL byte");
  }
  if (isAbsolute(requestedPath)) {
    throw new WorkspacePathError(`path must be relative to the run workspace: ${requestedPath}`);
  }
  const segments = requestedPath.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    throw new WorkspacePathError(`path must not contain "..": ${requestedPath}`);
  }

  const root = await realpath(rootDir);
  const target = resolve(root, requestedPath);
  if (!isWithin(root, target)) {
    throw new WorkspacePathError(`path escapes the run workspace: ${requestedPath}`);
  }

  let probe = target;
  const missing: string[] = [];
  while (true) {
    try {
      const resolvedProbe = await realpath(probe);
      const resolvedTarget = missing.length === 0 ? resolvedProbe : join(resolvedProbe, ...missing);
      if (!isWithin(root, resolvedTarget)) {
        throw new WorkspacePathError(`path resolves outside the run workspace through a symlink: ${requestedPath}`);
      }
      return resolvedTarget;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      // Distinguish a genuinely missing component from a broken symlink, which
      // realpath also reports as ENOENT but must not be silently treated as absent.
      let entry;
      try {
        entry = await lstat(probe);
      } catch {
        entry = undefined;
      }
      if (entry !== undefined) {
        throw new WorkspacePathError(`path contains a broken symlink: ${requestedPath}`);
      }
      if (probe === root) {
        throw new WorkspacePathError(`path escapes the run workspace: ${requestedPath}`);
      }
      missing.unshift(basename(probe));
      probe = dirname(probe);
    }
  }
}

export async function readRunFile(rootDir: string, requestedPath: string): Promise<Buffer> {
  const resolved = await resolveWorkspacePath(rootDir, requestedPath);
  let handle;
  try {
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) {
      throw error;
    }
    throw new WorkspacePathError(`could not open ${requestedPath}: ${errorMessage(error)}`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new WorkspacePathError(`not a regular file: ${requestedPath}`);
    }
    if (stats.size > MAX_CHECK_BYTES) {
      throw new WorkspacePathError(
        `file exceeds the ${MAX_CHECK_BYTES}-byte check limit: ${requestedPath} (${stats.size} bytes)`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** True when the run-relative file exists and is a regular file. */
export async function runFileExists(rootDir: string, requestedPath: string): Promise<boolean> {
  const resolved = await resolveWorkspacePath(rootDir, requestedPath);
  try {
    const stats = await lstat(resolved);
    return stats.isFile();
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

export function requireConfigurationPath(declaringDir: string, relativePath: string, label: string): string {
  if (relativePath.startsWith("/") || relativePath.includes("\0")) {
    throw new ConfigError(`${label} must be a relative path`);
  }
  return resolve(declaringDir, relativePath);
}

export function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(".." + sep) && path !== ".." && !path.startsWith(sep));
}

export function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
  );
}
