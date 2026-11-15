import { copyFile, lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveAuthoringAsset, type ResolvedCase } from "./config.ts";
import { assertRunRoot, isMissing, type RunRoot } from "./workspace.ts";

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
  await copyInto(stagingDir, workspaceDir, ".", "files", true);
  await rm(stagingDir, { recursive: true, force: true });
}

/**
 * Copy authoring `files` entries into an empty staging directory. Two entries
 * producing the same file are an error, as is a file and a directory at one path.
 */
export async function stageFiles(
  files: Readonly<Record<string, string>>,
  authoringDir: string,
  stagingDir: string,
  label: string,
): Promise<void> {
  for (const [destination, source] of Object.entries(files)) {
    const path = resolveAuthoringAsset(authoringDir, source, `${label}["${destination}"]`);
    await copyInto(path, resolve(stagingDir, destination), destination, `${label} entry "${destination}"`, false);
  }
}

/**
 * Copy a staged tree into the live workspace without following a symlink the agent may have
 * planted. Every ancestor component must be a real directory; anything at a file's destination
 * is unlinked rather than written through, so a symlink or hard link cannot redirect the copy.
 */
export async function placeStagedFiles(stagingDir: string, workspace: RunRoot, label: string): Promise<void> {
  await assertRunRoot(workspace);
  await placeTree(stagingDir, workspace.path, [], label);
}

/**
 * Copy one authoring file or directory tree onto `target`. A file landing where
 * a directory exists, or the reverse, is an error rather than a replacement;
 * `overwrite` decides only file-on-file, which splits fixture replacement from
 * entry-versus-entry overlap.
 */
async function copyInto(
  source: string,
  target: string,
  destination: string,
  label: string,
  overwrite: boolean,
): Promise<void> {
  const info = await lstat(source);
  if (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink()) {
    throw new Error(`${label} source for ${destination} must be a regular file or directory`);
  }
  const kind = info.isDirectory() ? "directory" : "file";
  await expectTarget(target, destination, label, kind, overwrite);
  if (kind === "file") {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    return;
  }
  await mkdir(target, { recursive: true });
  for (const name of await readdir(source)) {
    await copyInto(join(source, name), join(target, name), join(destination, name), label, overwrite);
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

/** Walk the staged tree into the workspace, refusing symlinked ancestors. */
async function placeTree(source: string, root: string, segments: readonly string[], label: string): Promise<void> {
  const info = await lstat(source);
  if (info.isDirectory()) {
    await ensureDirectory(root, segments, label);
    for (const name of await readdir(source)) {
      await placeTree(join(source, name), root, [...segments, name], label);
    }
    return;
  }
  await ensureDirectory(root, segments.slice(0, -1), label);
  await replaceFile(source, join(root, ...segments), segments.join("/"), label);
}

/** Create or verify every directory component without following a symlink. */
async function ensureDirectory(root: string, segments: readonly string[], label: string): Promise<string> {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        await mkdir(current);
        continue;
      }
      throw error;
    }
    const path = segments.slice(0, index + 1).join("/");
    if (info.isSymbolicLink()) {
      throw new Error(`${label} cannot place files through the symlink at ${path}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`${label} needs a directory at ${path}, where a file exists`);
    }
  }
  return current;
}

/** Replace whatever is at a file's destination, so copying never follows a link. */
async function replaceFile(source: string, target: string, destination: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isMissing(error)) {
      info = undefined;
    } else {
      throw error;
    }
  }
  if (info !== undefined) {
    if (info.isDirectory()) {
      throw new Error(`${label} places a file at ${destination}, where a directory exists`);
    }
    await unlink(target);
  }
  await copyFile(source, target);
}
