import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
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
 * An opened run directory. The recorded device/inode pair lets later operations
 * reject replacement of the directory path instead of trusting a new target.
 */
export interface RunRoot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export async function openRunRoot(path: string): Promise<RunRoot> {
  const canonical = await realpath(path);
  let handle;
  try {
    handle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new WorkspacePathError(`could not open run directory ${path}: ${errorMessage(error)}`);
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isDirectory()) {
      throw new WorkspacePathError(`run path is not a directory: ${path}`);
    }
    return { path: canonical, dev: stats.dev, ino: stats.ino };
  } finally {
    await handle.close();
  }
}

/**
 * Verify the directory path still refers to the prepared directory. A path
 * replaced by a symlink or a different directory is rejected.
 */
export async function assertRunRoot(root: RunRoot): Promise<void> {
  let entry;
  try {
    entry = await lstat(root.path, { bigint: true });
  } catch (error) {
    throw new WorkspacePathError(`run directory is no longer accessible: ${root.path}: ${errorMessage(error)}`);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory() || entry.dev !== root.dev || entry.ino !== root.ino) {
    throw new WorkspacePathError(`run directory was replaced after preparation: ${root.path}`);
  }

  let handle;
  try {
    handle = await open(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new WorkspacePathError(`run directory can no longer be opened safely: ${root.path}: ${errorMessage(error)}`);
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isDirectory() || stats.dev !== root.dev || stats.ino !== root.ino) {
      throw new WorkspacePathError(`run directory was replaced while opening it: ${root.path}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Resolve a run-relative path without allowing it to leave the prepared run
 * root. The root identity is verified first, and symlinks (including ancestor
 * symlinks) are rejected when they escape. A broken symlink is rejected rather
 * than treated as a missing file.
 */
export async function resolveWorkspacePath(root: RunRoot, requestedPath: string): Promise<string> {
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
  await assertRunRoot(root);

  const target = resolve(root.path, requestedPath);
  if (!isWithin(root.path, target)) {
    throw new WorkspacePathError(`path escapes the run workspace: ${requestedPath}`);
  }

  let probe = target;
  const missing: string[] = [];
  while (true) {
    try {
      const resolvedProbe = await realpath(probe);
      const resolvedTarget = missing.length === 0 ? resolvedProbe : join(resolvedProbe, ...missing);
      if (!isWithin(root.path, resolvedTarget)) {
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
      if (probe === root.path) {
        throw new WorkspacePathError(`path escapes the run workspace: ${requestedPath}`);
      }
      missing.unshift(basename(probe));
      probe = dirname(probe);
    }
  }
}

/**
 * Read a regular run file. Non-regular evidence is rejected without opening it,
 * so a FIFO or device cannot block the engine or checks.
 */
export async function readRunFile(root: RunRoot, requestedPath: string): Promise<Buffer> {
  const resolved = await resolveWorkspacePath(root, requestedPath);
  let entry;
  try {
    entry = await lstat(resolved);
  } catch (error) {
    if (isMissing(error)) {
      throw error;
    }
    throw new WorkspacePathError(`could not inspect ${requestedPath}: ${errorMessage(error)}`);
  }
  if (!entry.isFile()) {
    throw new WorkspacePathError(`not a regular file: ${requestedPath}`);
  }
  return readBoundedFile(resolved, requestedPath);
}

/** The kind of one node in a run tree. Non-regular entries are recorded, never opened. */
export type RunEntryKind = "file" | "directory" | "symlink" | "other";

/** One node of a run tree. `size` is the byte size of a regular file within the check limit. */
export interface RunTreeEntry {
  readonly kind: RunEntryKind;
  readonly size?: number;
}

/**
 * A run path's contents keyed by path relative to it, with `""` for the path itself.
 * Symlinks and special files are recorded by kind and never followed, so a link the
 * agent wrote is visible as a change instead of hiding the evidence behind an error.
 */
export type RunTree = ReadonlyMap<string, RunTreeEntry>;

/**
 * Snapshot a run path for comparison. `undefined` means the path itself does not
 * exist; an existing path is one entry per node beneath it, listed and opened
 * without following links.
 */
export async function readRunTree(root: RunRoot, requestedPath: string): Promise<RunTree | undefined> {
  const resolved = await resolveWorkspacePath(root, requestedPath);
  let entry;
  try {
    // Inspect the named node itself rather than its canonical target: a directory replaced by
    // an in-root link must read as a link, or a twin tree would make the comparison pass.
    entry = await lstat(resolve(root.path, requestedPath));
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw new WorkspacePathError(`could not inspect ${requestedPath}: ${errorMessage(error)}`);
  }
  if (entry.isSymbolicLink()) {
    return new Map([["", { kind: "symlink" }]]);
  }

  const entries = new Map<string, RunTreeEntry>();
  const visit = async (absolute: string, relative: string, stats: Stats) => {
    if (stats.isSymbolicLink()) {
      entries.set(relative, { kind: "symlink" });
      return;
    }
    if (stats.isDirectory()) {
      entries.set(relative, { kind: "directory" });
      let names: string[];
      try {
        names = await readdir(absolute);
      } catch (error) {
        throw new WorkspacePathError(`could not list ${requestedPath}: ${errorMessage(error)}`);
      }
      for (const name of [...names].sort()) {
        const child = join(absolute, name);
        const childRelative = relative === "" ? name : `${relative}/${name}`;
        let childStats;
        try {
          childStats = await lstat(child);
        } catch (error) {
          throw new WorkspacePathError(`could not inspect ${childRelative}: ${errorMessage(error)}`);
        }
        await visit(child, childRelative, childStats);
      }
      return;
    }
    if (stats.isFile()) {
      if (stats.size > MAX_CHECK_BYTES) {
        throw new WorkspacePathError(
          `file exceeds the ${MAX_CHECK_BYTES}-byte check limit: ${relative || requestedPath} (${stats.size} bytes)`,
        );
      }
      entries.set(relative, { kind: "file", size: stats.size });
      return;
    }
    entries.set(relative, { kind: "other" });
  };
  await visit(resolved, "", entry);
  return entries;
}

/** Read one regular file with the size ceiling and the same no-follow open as `readRunFile`. */
async function readBoundedFile(absolute: string, requestedPath: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
    // Read at most one byte past the ceiling: a file that grows between the size check and the
    // read would otherwise let readFile allocate without a bound.
    const buffer = Buffer.allocUnsafe(MAX_CHECK_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CHECK_BYTES) {
      throw new WorkspacePathError(`file exceeds the ${MAX_CHECK_BYTES}-byte check limit: ${requestedPath}`);
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** True when the run-relative path is a regular file or a directory; special files are errors. */
export async function runPathExists(root: RunRoot, requestedPath: string): Promise<boolean> {
  const resolved = await resolveWorkspacePath(root, requestedPath);
  try {
    const stats = await lstat(resolved);
    if (stats.isFile() || stats.isDirectory()) {
      return true;
    }
    throw new WorkspacePathError(`not a regular file or directory: ${requestedPath}`);
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
