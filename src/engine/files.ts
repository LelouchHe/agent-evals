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
 * Place the case's workspace `files` entries into the prepared workspace. Entries are
 * combined in an otherwise empty staging directory first, so an entry can
 * replace what the fixture provided but never another entry.
 */
export async function placeCaseFiles(
  loadedCase: ResolvedCase,
  stagingDir: string,
  workspaceDir: string,
): Promise<void> {
  const entries = workspaceEntries(loadedCase.config.files);
  if (entries.length === 0) {
    return;
  }
  await stageEntries(entries, loadedCase.dir, stagingDir, "files");
  await copyPlacement(stagingDir, workspaceDir, { label: "files", overwrite: true });
  await rm(stagingDir, { recursive: true, force: true });
}

/** One placement: the declared destination, where it goes under its root, and its source. */
export interface PlacementEntry {
  /** The destination as the author declared it, for messages and reporting. */
  readonly destination: string;
  /** The root-relative path the source is placed at. */
  readonly target: string;
  readonly source: string;
}

/** The case `files` entries that go to the workspace, with normalized relative targets. */
export function workspaceEntries(files: Readonly<Record<string, string>> | undefined): readonly PlacementEntry[] {
  return Object.entries(files ?? {})
    .filter(([destination]) => !isHomeDestination(destination))
    .map(([destination, source]) => ({ destination, target: workspaceTargetPath(destination), source }));
}

/** The case `files` entries that go into HOME, with `~/` stripped from their targets. */
export function homeEntries(files: Readonly<Record<string, string>> | undefined): readonly PlacementEntry[] {
  return Object.entries(files ?? {})
    .filter(([destination]) => isHomeDestination(destination))
    .map(([destination, source]) => ({ destination, target: homePathOf(destination), source }));
}

/** A `~/` destination names HOME; anything else names the workspace. */
export function isHomeDestination(destination: string): boolean {
  return destination.startsWith("~/");
}

/** The HOME-relative path a `~/` destination names; the HOME root itself is the empty path. */
export function homePathOf(destination: string): string {
  return workspaceTargetPath(destination.slice(2));
}

/**
 * Copy placement entries into an empty staging directory: the same traversal and ignore rules
 * as a workspace placement, with each target taken relative to the staging root. Two entries
 * normalized to one path collide there, because staging never overwrites.
 */
export async function stageEntries(
  entries: readonly PlacementEntry[],
  authoringDir: string,
  stagingDir: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(stagingDir, { recursive: true });
  const tree = new IgnoreTree();
  for (const entry of entries) {
    signal?.throwIfAborted();
    const path = resolveAuthoringAsset(authoringDir, entry.source, `${label}["${entry.destination}"]`);
    await copyInto(
      path,
      resolve(stagingDir, entry.target),
      entry.destination,
      `${label} entry "${entry.destination}"`,
      false,
      signal,
      { tree, root: path, segments: [] },
    );
  }
}

/** Files a placement may never create or replace: by declared path and by file identity. */
export interface PlacementProtection {
  /** Target-relative paths, compared as written (login files as declared). */
  readonly paths?: readonly string[];
  /** File identities (`dev:ino`), so an alias in any spelling cannot be written through. */
  readonly identities?: readonly string[];
}

/**
 * Copy a staged placement tree onto its target. `overwrite` decides file-on-file replacement;
 * `protect` names the login state no copy may place over.
 */
export async function copyPlacement(
  stagingDir: string,
  targetDir: string,
  options: {
    readonly label: string;
    readonly overwrite: boolean;
    readonly protect?: PlacementProtection;
    readonly signal?: AbortSignal;
  },
): Promise<void> {
  await copyInto(
    stagingDir,
    targetDir,
    ".",
    options.label,
    options.overwrite,
    options.signal,
    { tree: new IgnoreTree(), root: stagingDir, segments: [] },
    options.protect === undefined ? undefined : new ProtectedPaths(options.protect),
  );
}

/** The identity a filesystem uses for one file, independent of the spelling that reached it. */
export function fileIdentity(info: { readonly dev: bigint; readonly ino: bigint }): string {
  return `${info.dev}:${info.ino}`;
}

/** Target-relative files a placement may never create or replace. */
class ProtectedPaths {
  readonly #paths: readonly string[];
  readonly #identities: ReadonlySet<string>;

  constructor(protection: PlacementProtection) {
    this.#paths = (protection.paths ?? []).map((path) => normalizeRelative(path));
    this.#identities = new Set(protection.identities ?? []);
  }

  /**
   * A protected file at `destination`, or a path beneath one, which cannot be written. The
   * declared spelling is not enough: the filesystem decides whether the target is the login
   * file, so the existing target's identity is compared too. A case-insensitive or otherwise
   * normalising filesystem reports the login file's identity for another spelling.
   */
  async blocks(target: string, destination: string): Promise<boolean> {
    const normalized = normalizeRelative(destination);
    if (this.#paths.some((path) => path === normalized || normalized.startsWith(`${path}/`))) {
      return true;
    }
    if (this.#identities.size === 0) {
      return false;
    }
    try {
      const info = await lstat(target, { bigint: true });
      return this.#identities.has(fileIdentity(info));
    } catch {
      // Nothing exists at the target spelling, so it cannot alias an existing login file.
      return false;
    }
  }
}

function normalizeRelative(path: string): string {
  return workspaceTargetPath(path);
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
/**
 * Classify one authoring entry against the ignore rules. `ignored` is decided before a special
 * file is rejected, so an excluded special file is silently skipped rather than an error.
 */
async function classify(
  source: string,
  destination: string,
  label: string,
  signal: AbortSignal | undefined,
  traversal: Traversal,
): Promise<{ readonly kind: "file" | "directory" | "other" } | { readonly kind: "ignored" }> {
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
  // Classifying first is what lets a directory-only pattern match a directory entry.
  if (await isIgnored(traversal.tree, traversal.root, traversal.segments, kind === "directory")) {
    return { kind: "ignored" };
  }
  return { kind };
}

async function copyInto(
  source: string,
  target: string,
  destination: string,
  label: string,
  overwrite: boolean,
  signal: AbortSignal | undefined,
  traversal: Traversal,
  protect?: ProtectedPaths,
): Promise<void> {
  const classified = await classify(source, destination, label, signal, traversal);
  if (classified.kind === "ignored") {
    return;
  }
  const { kind } = classified;
  if (kind === "other") {
    throw new Error(`${label} source for ${destination} must be a regular file or directory`);
  }
  if (protect !== undefined && (await protect.blocks(target, destination))) {
    throw new Error(`${label} may not replace ${destination}, which is login state`);
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
    await copyInto(
      join(source, name),
      join(target, name),
      join(destination, name),
      label,
      overwrite,
      signal,
      { ...traversal, segments: [...traversal.segments, name] },
      protect,
    );
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
