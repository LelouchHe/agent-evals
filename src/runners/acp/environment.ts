import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ConfigError, errorMessage } from "../../engine/config.ts";
import type { MockWiring } from "../../engine/registry.ts";
import { isMissing, isWithin, openRunRoot, resolveWorkspacePath, type RunRoot } from "../../engine/workspace.ts";
import { assertSeatbeltAvailable, createSandboxPolicy, SYSTEM_PATH } from "../../platform/macos/policy.ts";
import type { AgentConfig } from "./agent.ts";

export interface HarnessHome {
  readonly environment: Readonly<Record<string, string>>;
  readonly path: readonly string[];
  readonly deps: string;
  /** Canonical persistent login directory; it may not exist before the first login. */
  readonly login?: string;
  readonly loginRoot?: RunRoot;
}

/** Validate the caller-owned software and login directories without creating run state. */
export async function resolveHome(agent: AgentConfig, declaringDir: string): Promise<HarnessHome> {
  assertSeatbeltAvailable();
  let deps: string;
  try {
    deps = (await openRunRoot(resolve(declaringDir, agent.home.deps))).path;
  } catch (error) {
    throw new ConfigError(`home.deps must be an accessible directory: ${errorMessage(error)}`);
  }
  let login: string | undefined;
  let loginRoot: RunRoot | undefined;
  if (agent.home.login !== undefined) {
    try {
      login = await canonicalPath(resolve(declaringDir, agent.home.login));
      loginRoot = await openRunRoot(login);
    } catch (error) {
      // Only a missing directory is valid for first login, not ENOTDIR.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new ConfigError(`home.login must be a directory: ${errorMessage(error)}`);
      }
    }
  }
  if (login !== undefined && (isWithin(deps, login) || isWithin(login, deps))) {
    throw new ConfigError("deps and login must be separate, non-overlapping directories");
  }
  return {
    environment: agent.environment,
    path: agent.home.path,
    deps,
    ...(login === undefined ? {} : { login }),
    ...(loginRoot === undefined ? {} : { loginRoot }),
  };
}

/**
 * Assemble caller-owned software and copied login state into empty run
 * directories, without ambient installations. The caller owns and removes them.
 */
export async function assembleEnvironment(
  source: HarnessHome,
  dirs: { readonly home: string; readonly workspace: string; readonly scratch: string },
  options: { readonly interactive: boolean; readonly mocks?: MockWiring },
) {
  const { deps, login, loginRoot } = source;
  const { home } = dirs;
  const mocks = options.mocks;
  if (isWithin(deps, await realpath(home))) throw new ConfigError("deps must not contain the temporary run directory");
  await mirror(deps, home);
  const homeRoot = await openRunRoot(home);
  const originals = new Map<string, Buffer>();
  if (loginRoot !== undefined) {
    for (const file of await files(loginRoot.path)) {
      const destination = join(home, file);
      try {
        await lstat(destination);
        throw new ConfigError(`deps and login contain the same file: ${file}`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const data = await readRegular(loginRoot, file);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, data, { mode: 0o600, flag: "wx" });
      originals.set(file, data);
    }
  }
  const pathEntries = [...source.path.map((path) => join(home, path)), ...SYSTEM_PATH];
  const policy = createSandboxPolicy({
    writableRoots: [home, dirs.workspace, dirs.scratch],
    // A mocked command's forwarder is readable and executable, never writable.
    readableRoots: mocks === undefined ? [deps] : [deps, mocks.forwarderDir],
    denyExecutables:
      mocks === undefined ? [] : await deniedBinaries(mocks.denyTargets, pathEntries, await activeDeveloperDir()),
    allowNetwork: true,
    interactive: options.interactive,
  });
  const env: NodeJS.ProcessEnv = {
    ...source.environment,
    ...(process.env.TERM === undefined ? {} : { TERM: process.env.TERM }),
    HOME: home,
    TMPDIR: dirs.scratch,
    PATH: [...(mocks === undefined ? [] : [mocks.forwarderDir]), ...pathEntries].join(":"),
  };
  const persist = async (selected: ReadonlyMap<string, Buffer>): Promise<void> => {
    if (login === undefined) throw new ConfigError("login requires home.login");
    await mkdir(login, { recursive: true, mode: 0o700 });
    const targetRoot = await openRunRoot(login);
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
  };
  return {
    env,
    policy,
    async saveLogin(selected: readonly string[]): Promise<void> {
      // Validate every source before modifying the persistent login directory.
      const contents = new Map<string, Buffer>();
      for (const file of selected) contents.set(file, await readRegular(homeRoot, file));
      await persist(contents);
    },
    /** Call only after the sandbox has stopped. */
    async copyBack(): Promise<void> {
      const changed = new Map<string, Buffer>();
      for (const [file, before] of originals) {
        try {
          const after = await readRegular(homeRoot, file);
          if (!before.equals(after)) changed.set(file, after);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      if (changed.size > 0) await persist(changed);
    },
  };
}

/**
 * The real binaries behind PATH targets whose rules never pass. Besides the first PATH match,
 * the active developer directory is included because `/usr/bin/make` and `/usr/bin/git` are
 * shims that start the toolchain's own copy.
 */
export async function deniedBinaries(
  targets: readonly string[],
  pathEntries: readonly string[],
  developerDir: string | undefined,
): Promise<readonly string[]> {
  const denied: string[] = [];
  for (const target of targets) {
    const candidates = [
      ...pathEntries.map((entry) => join(entry, target)),
      ...(developerDir === undefined ? [] : [join(developerDir, "usr", "bin", target)]),
    ];
    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isFile()) denied.push(candidate, await realpath(candidate));
      } catch {
        // Not installed here.
      }
    }
  }
  return denied;
}

/** The directory the platform shims start tools from, when a developer directory is selected. */
async function activeDeveloperDir(): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("/usr/bin/xcode-select", ["-p"]);
    const path = stdout.trim();
    return path.length === 0 ? undefined : path;
  } catch {
    return undefined;
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

async function mirror(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      await mirror(from, to);
    } else if (entry.isFile() || (entry.isSymbolicLink() && (await stat(from)).isFile())) {
      await symlink(from, to);
    } else {
      throw new ConfigError(`deps contains a non-file entry: ${from}`);
    }
  }
}

async function files(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await files(join(directory, entry.name), relative)));
    else if (entry.isFile()) result.push(relative);
    else throw new ConfigError(`login contains a non-regular file: ${relative}`);
  }
  return result;
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
