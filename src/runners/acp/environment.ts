import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ConfigError, errorMessage, expectPlacementDestination, expectRelativePath } from "../../engine/config.ts";
import { copyPlacement, homePathOf, isHomeDestination, placedPaths, stageEntries } from "../../engine/files.ts";
import type { MockWiring } from "../../engine/registry.ts";
import { isMissing, isWithin, openRunRoot, resolveWorkspacePath, type RunRoot } from "../../engine/workspace.ts";
import {
  assertSandboxAvailable,
  createSandboxPolicy,
  resolveDeniedExecutables,
  SYSTEM_PATH,
} from "../../platform/index.ts";
import type { AgentConfig } from "./agent.ts";

/** Persistent login state: where it lives, which files compose it, and how to obtain it. */
export interface HarnessLogin {
  /** Native program the login helper runs in the terminal. */
  readonly command: readonly [string, ...string[]];
  /** Canonical persistent directory; it may not exist before the first login. */
  readonly dir: string;
  /** HOME-relative files copied into the run and saved back after the sandbox stops. */
  readonly files: readonly string[];
  /** The directory as an opened run root, present only when it exists. */
  readonly root?: RunRoot;
}

/** One resolved agent file: the caller-owned parts of a harness home. */
export interface HarnessHome {
  readonly declaringDir: string;
  readonly environment: Readonly<Record<string, string>>;
  /** `deps`-relative command directories to put on `PATH`. */
  readonly path: readonly string[];
  /** Canonical caller-owned software directory, linked into the run as `deps`. */
  readonly deps: string;
  /** `~/` destinations and their authoring sources, validated but not placed. */
  readonly files: Readonly<Record<string, string>>;
  readonly login?: HarnessLogin;
}

/** Validate the caller-owned software, HOME content and login state without creating run state. */
export async function resolveHarnessHome(agent: AgentConfig, declaringDir: string): Promise<HarnessHome> {
  assertSandboxAvailable();
  let deps: string;
  try {
    deps = (await openRunRoot(resolve(declaringDir, agent.deps))).path;
  } catch (error) {
    throw new ConfigError(`deps must be an accessible directory: ${errorMessage(error)}`);
  }
  const files = agent.files ?? {};
  for (const [destination, source] of Object.entries(files)) {
    expectPlacementDestination(destination, `agent files destination "${destination}"`);
    if (!isHomeDestination(destination)) {
      throw new ConfigError(`agent files destination "${destination}" must start with "~/"`);
    }
    expectRelativePath(source, `agent files["${destination}"]`);
    if (homePathOf(destination) === "") {
      throw new ConfigError(`agent files destination "${destination}" must name a path inside HOME, not HOME itself`);
    }
  }

  let login: HarnessLogin | undefined;
  if (agent.login !== undefined) {
    let directory: string;
    try {
      directory = await canonicalPath(resolve(declaringDir, agent.login.dir));
    } catch (error) {
      throw new ConfigError(`login.dir must be a directory: ${errorMessage(error)}`);
    }
    let loginRoot: RunRoot | undefined;
    try {
      loginRoot = await openRunRoot(directory);
    } catch (error) {
      // Only a missing directory is valid for first login, not ENOTDIR.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new ConfigError(`login.dir must be a directory: ${errorMessage(error)}`);
      }
    }
    if (isWithin(deps, directory) || isWithin(directory, deps)) {
      throw new ConfigError("deps and login.dir must be separate, non-overlapping directories");
    }
    login = {
      command: agent.login.command,
      dir: directory,
      files: agent.login.files,
      ...(loginRoot === undefined ? {} : { root: loginRoot }),
    };
  }

  // Every agent placement is read now, so a missing source or a directory whose contents name a
  // login file is a configuration error before any run resource exists, not a failed run.
  const entries = Object.entries(files).map(([destination, source]) => ({
    destination,
    target: homePathOf(destination),
    source,
  }));
  let placed: readonly string[];
  try {
    placed = await placedPaths(entries, declaringDir, "agent files");
  } catch (error) {
    throw new ConfigError(`agent files: ${errorMessage(error)}`, { cause: error });
  }
  for (const file of login?.files ?? []) {
    const collision = placed.find((target) => target === file || target.startsWith(`${file}/`));
    if (collision !== undefined) {
      throw new ConfigError(`agent files place ${collision}, which collides with login file ${file}`);
    }
  }

  return {
    declaringDir,
    environment: agent.environment,
    path: agent.path,
    deps,
    files,
    ...(login === undefined ? {} : { login }),
  };
}

export interface HarnessHomeDirs {
  /** The run HOME, already created by the engine. */
  readonly home: string;
  readonly runRootDir: string;
  /** Engine-private directory for placement staging; unreadable to the agent. */
  readonly engineDir: string;
}

/**
 * Assemble the caller-owned HOME content in the run directory: link `deps` at the run root,
 * copy the agent file's `files`, then copy the declared login state. The returned paths are
 * login files the case may not touch.
 */
export async function prepareHarnessHome(
  source: HarnessHome,
  dirs: HarnessHomeDirs,
  signal?: AbortSignal,
): Promise<{
  readonly homeRoot: RunRoot;
  readonly protectedPaths: readonly string[];
  readonly copyBack: () => Promise<void>;
}> {
  const homeRoot = await openRunRoot(dirs.home);
  if (isWithin(source.deps, homeRoot.path)) {
    throw new ConfigError("deps must not contain the temporary run directory");
  }
  // One directory symlink: the caller's software, referenced in place. The target must be the
  // canonical path so the sandbox authorizes traversal through the link.
  await symlink(source.deps, join(dirs.runRootDir, "deps"), "dir");

  const placements = Object.entries(source.files).map(([destination, file]) => ({
    destination,
    target: homePathOf(destination),
    source: file,
  }));
  if (placements.length > 0) {
    const staging = join(dirs.engineDir, "files-agent");
    try {
      await stageEntries(placements, source.declaringDir, staging, "agent files", signal);
      await copyPlacement(staging, homeRoot.path, { label: "agent files", overwrite: false, signal });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  const originals = new Map<string, Buffer>();
  const login = source.login;
  if (login?.root !== undefined) {
    for (const file of login.files) {
      const destination = await resolveWorkspacePath(homeRoot, file);
      let data: Buffer;
      try {
        data = await readRegular(login.root, file);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      try {
        await lstat(destination);
        throw new ConfigError(`agent files and login contain the same file: ${file}`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, data, { mode: 0o600, flag: "wx" });
      originals.set(file, data);
    }
  }

  const copyBack = async (): Promise<void> => {
    const changed = new Map<string, Buffer>();
    for (const [file, before] of originals) {
      try {
        const after = await readRegular(homeRoot, file);
        if (!before.equals(after)) changed.set(file, after);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    if (changed.size > 0) await persistLogin(login, changed);
  };

  return { homeRoot, protectedPaths: login?.files ?? [], copyBack };
}

/**
 * The process environment and sandbox policy for one harness run: `PATH` goes through the
 * run-root `deps` link, writes stay in the run's writable directories, and `engine/` is absent
 * from every readable root.
 */
export async function harnessEnvironment(
  source: HarnessHome,
  dirs: {
    readonly home: string;
    readonly workspace: string;
    readonly tmp: string;
    readonly runRootDir: string;
  },
  options: { readonly interactive: boolean; readonly mocks?: MockWiring },
): Promise<{ readonly env: NodeJS.ProcessEnv; readonly policy: ReturnType<typeof createSandboxPolicy> }> {
  const mocks = options.mocks;
  const depsLink = join(dirs.runRootDir, "deps");
  const pathEntries = [...source.path.map((path) => join(depsLink, path)), ...SYSTEM_PATH];
  const policy = createSandboxPolicy({
    writableRoots: [dirs.home, dirs.workspace, dirs.tmp],
    // A mocked command's forwarder is readable and executable, never writable.
    readableRoots: mocks === undefined ? [depsLink] : [depsLink, mocks.forwarderDir, ...(mocks.readableRoots ?? [])],
    ...(mocks === undefined ? {} : { writableFiles: [mocks.socketPath] }),
    denyExecutables: mocks === undefined ? [] : await resolveDeniedExecutables(mocks.denyTargets, pathEntries),
    allowNetwork: true,
    interactive: options.interactive,
  });
  const env: NodeJS.ProcessEnv = {
    ...source.environment,
    ...(process.env.TERM === undefined ? {} : { TERM: process.env.TERM }),
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    PATH: [...(mocks === undefined ? [] : [mocks.forwarderDir]), ...pathEntries].join(":"),
  };
  return { env, policy };
}

/** Save declared login files after a successful native login. */
export async function saveLogin(source: HarnessHome, homeRoot: RunRoot, selected: readonly string[]): Promise<void> {
  const contents = new Map<string, Buffer>();
  for (const file of selected) {
    try {
      contents.set(file, await readRegular(homeRoot, file));
    } catch (error) {
      // A declared file the harness did not create on this first login is simply absent.
      if (!isMissing(error)) throw error;
    }
  }
  await persistLogin(source.login, contents);
}

async function persistLogin(login: HarnessLogin | undefined, selected: ReadonlyMap<string, Buffer>): Promise<void> {
  if (login === undefined) throw new ConfigError("login requires a login declaration");
  await mkdir(login.dir, { recursive: true, mode: 0o700 });
  const targetRoot = await openRunRoot(login.dir);
  for (const [file, data] of selected) {
    const target = await resolveWorkspacePath(targetRoot, file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(target), `.agent-evals-${randomUUID()}`);
    try {
      await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Canonicalize existing ancestors too, without creating a first-login directory. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

async function readRegular(root: RunRoot, file: string): Promise<Buffer> {
  const path = await resolveWorkspacePath(root, file);
  // NONBLOCK avoids opening a FIFO being substituted for a credential file.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new ConfigError(`login path is not a regular file: ${file}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
