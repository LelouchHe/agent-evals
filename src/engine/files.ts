import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  ConfigError,
  errorMessage,
  expectRelativePath,
  expectWorkspaceDestination,
  resolveAuthoringAsset,
  workspaceTargetPath,
  type ResolvedCase,
} from "./config.ts";
import { IgnoreTree, isIgnored } from "./ignore.ts";
import { isMissing } from "./workspace.ts";

/**
 * Place the case's `files` entries into the prepared workspace. Entries are
 * combined in an otherwise empty staging directory first, so an entry can
 * replace what the fixture provided but never another entry.
 */
export async function placeCaseFiles(
  loadedCase: ResolvedCase,
  stagingDir: string,
  workspaceDir: string,
): Promise<void> {
  const files = loadedCase.config.files;
  if (files === undefined) {
    return;
  }
  await mkdir(stagingDir);
  await stageFiles(files, loadedCase.dir, stagingDir, "files");
  await copyInto(stagingDir, workspaceDir, ".", "files", true, undefined, {
    tree: new IgnoreTree(),
    root: stagingDir,
    segments: [],
  });
  await rm(stagingDir, { recursive: true, force: true });
}

/**
 * Validate a checker's check-time `files`: workspace destinations and authoring sources, with
 * the same rules as `case.files` destinations plus a non-root destination. Throws `ConfigError`
 * so an extension checker that did no schema validation of its own still gets safe paths.
 */
export function expectCheckFiles(files: Readonly<Record<string, unknown>>): void {
  for (const [destination, source] of Object.entries(files)) {
    expectWorkspaceDestination(destination, `check files destination "${destination}"`);
    if (workspaceTargetPath(destination) === "") {
      throw new ConfigError(
        `check files destination "${destination}" must name a file or directory inside the workspace`,
      );
    }
    if (typeof source !== "string") {
      throw new ConfigError(`check files["${destination}"] must be a string`);
    }
    expectRelativePath(source, `check files["${destination}"]`);
  }
}

/**
 * Validate a checker's files, then stage them for the check sandbox. The destination is created
 * by the caller and is read-only inside the sandbox.
 */
export async function stageCheckFiles(
  files: Readonly<Record<string, string>>,
  authoringDir: string,
  stagingDir: string,
  signal?: AbortSignal,
  label = "check files",
): Promise<void> {
  expectCheckFiles(files);
  await stageFiles(files, authoringDir, stagingDir, label, signal);
}

/**
 * Validate and stage a checker's files once at load, then discard the staging tree. A missing or
 * special source, a nested symlink that is not a regular file, or two entries producing one file
 * is a `ConfigError` before any run directory exists.
 */
export async function validateCheckFiles(
  files: Readonly<Record<string, string>>,
  authoringDir: string,
  label = "check files",
  signal?: AbortSignal,
): Promise<void> {
  if (Object.keys(files).length === 0) return;
  const staging = await mkdtemp(join(tmpdir(), "agent-evals-check-files-"));
  try {
    await stageCheckFiles(files, authoringDir, staging, signal, label);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ConfigError(`${label}: ${errorMessage(error)}`, { cause: error });
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Copy authoring `files` entries into an empty staging directory. Every visited source must be a
 * regular file or directory; a symlink is accepted only when its target is a regular file, so a
 * link to a FIFO, device or directory fails cleanly instead of blocking or escaping. Two entries
 * producing the same file are an error, as is a file and a directory at one path.
 */
export async function stageFiles(
  files: Readonly<Record<string, string>>,
  authoringDir: string,
  stagingDir: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  const tree = new IgnoreTree();
  for (const [destination, source] of Object.entries(files)) {
    signal?.throwIfAborted();
    const path = resolveAuthoringAsset(authoringDir, source, `${label}["${destination}"]`);
    await copyInto(
      path,
      resolve(stagingDir, destination),
      destination,
      `${label} entry "${destination}"`,
      false,
      signal,
      { tree, root: path, segments: [] },
    );
  }
}

/**
 * A `cp` filter that applies `.agentevalsignore` to the fixture copy. It shares the ignore
 * decision with the directory copier below, so both place the same paths.
 */
export function authoringCopyFilter(source: string): (path: string) => Promise<boolean> {
  const tree = new IgnoreTree();
  return async (path) => {
    const segments = relative(source, path)
      .split(sep)
      .filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      return true;
    }
    // `cp` filters receive only a path, so the entry type has to be stat'ed. A symlink is a file
    // here, matching how the directory copier treats one.
    const info = await lstat(path);
    return !(await isIgnored(tree, source, segments, info.isDirectory()));
  };
}

/** Where one copy started and the path segments the current entry sits at. */
interface Traversal {
  readonly tree: IgnoreTree;
  readonly root: string;
  readonly segments: readonly string[];
}

/**
 * Copy one authoring file or directory tree onto `target`. A file landing where
 * a directory exists, or the reverse, is an error rather than a replacement;
 * `overwrite` decides only file-on-file, which splits fixture replacement from
 * entry-versus-entry overlap. Each directory may declare `.agentevalsignore`,
 * which applies as traversal reaches it, so a directly named source is placed.
 */
async function copyInto(
  source: string,
  target: string,
  destination: string,
  label: string,
  overwrite: boolean,
  signal: AbortSignal | undefined,
  traversal: Traversal,
): Promise<void> {
  signal?.throwIfAborted();
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    throw new Error(`${label} source for ${destination} is not accessible: ${errorMessage(error)}`, { cause: error });
  }
  let kind: "file" | "directory" | "other";
  if (info.isSymbolicLink()) {
    // A link is copied as its target's content, and only when that target is a regular file.
    let resolved;
    try {
      resolved = await stat(source);
    } catch (error) {
      throw new Error(`${label} source for ${destination} is not accessible: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    kind = resolved.isFile() ? "file" : "other";
  } else if (info.isDirectory()) {
    kind = "directory";
  } else {
    kind = info.isFile() ? "file" : "other";
  }

  signal?.throwIfAborted();
  // Classifying first is what lets a directory-only pattern match a directory entry, and what
  // keeps an excluded special file silently skipped rather than an error.
  if (await isIgnored(traversal.tree, traversal.root, traversal.segments, kind === "directory")) {
    return;
  }
  if (kind === "other") {
    throw new Error(`${label} source for ${destination} must be a regular file or directory`);
  }
  await expectTarget(target, destination, label, kind, overwrite);
  signal?.throwIfAborted();
  if (kind === "file") {
    await mkdir(dirname(target), { recursive: true });
    signal?.throwIfAborted();
    await copyFile(source, target);
    signal?.throwIfAborted();
    return;
  }
  await mkdir(target, { recursive: true });
  signal?.throwIfAborted();
  const entries = await readdir(source);
  signal?.throwIfAborted();
  for (const name of entries) {
    await copyInto(join(source, name), join(target, name), join(destination, name), label, overwrite, signal, {
      ...traversal,
      segments: [...traversal.segments, name],
    });
  }
}

/** Reject an existing path that cannot receive `kind`, or a file one entry would overwrite. */
async function expectTarget(
  target: string,
  destination: string,
  label: string,
  kind: "file" | "directory",
  overwrite: boolean,
): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  const existing = info.isDirectory() ? "directory" : "file";
  if (existing !== kind) {
    throw new Error(`${label} places a ${kind} at ${destination}, where a ${existing} already exists`);
  }
  if (kind === "file" && !overwrite) {
    throw new Error(`${label} overwrites ${destination}, which another files entry provides`);
  }
}
