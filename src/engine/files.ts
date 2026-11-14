import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveAuthoringAsset, type ResolvedCase } from "./config.ts";
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
  for (const [destination, source] of Object.entries(files)) {
    const path = resolveAuthoringAsset(loadedCase.dir, source, `case.files["${destination}"]`);
    await copyInto(path, resolve(stagingDir, destination), destination, `files entry "${destination}"`, false);
  }
  await copyInto(stagingDir, workspaceDir, ".", "files", true);
  await rm(stagingDir, { recursive: true, force: true });
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
