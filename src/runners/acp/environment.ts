import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ConfigError, errorMessage } from "../../engine/config.ts";
import { isMissing, isWithin, openRunRoot, resolveWorkspacePath, type RunRoot } from "../../engine/workspace.ts";
import { assertSeatbeltAvailable, type SandboxPolicy } from "../../platform/macos/policy.ts";
import type { AgentConfig } from "./agent.ts";

/** Assemble caller-owned software and copied login state without ambient installations. */
export async function prepareEnvironment(agent: AgentConfig, declaringDir: string, interactive: boolean) {
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
  const directory = await mkdtemp(join(tmpdir(), "ae-acp-"));
  try {
    if (isWithin(deps, await realpath(directory)))
      throw new ConfigError("deps must not contain the temporary command directory");
    const home = join(directory, "home");
    const cwd = join(directory, "workspace");
    const scratch = join(directory, "tmp");
    await Promise.all([home, cwd, scratch].map((path) => mkdir(path, { mode: 0o700 })));
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
    const terminal =
      interactive && process.stdin.isTTY
        ? execFileSync("/usr/bin/tty", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim()
        : undefined;
    const policy: SandboxPolicy = {
      writableRoots: [directory],
      ...(terminal === undefined ? {} : { terminal }),
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
        deps,
      ],
      readableFiles: ["/var"],
      allowNetwork: true,
    };
    const env: NodeJS.ProcessEnv = {
      ...(process.env.TERM === undefined ? {} : { TERM: process.env.TERM }),
      ...agent.env,
      HOME: home,
      TMPDIR: scratch,
      PATH: [...agent.home.path.map((path) => join(home, path)), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
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
      directory,
      cwd,
      env,
      policy,
      async saveLogin(selected: readonly string[]): Promise<void> {
        // Validate every source before modifying the persistent login directory.
        const contents = new Map<string, Buffer>();
        for (const file of selected) contents.set(file, await readRegular(homeRoot, file));
        await persist(contents);
      },
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
      async dispose(): Promise<void> {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
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
