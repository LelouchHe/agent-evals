import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, constants, open, rm, type FileHandle } from "node:fs/promises";
import type { Server } from "node:net";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { DirectoryIdentity, MockEndpoint, MockForwarderSpec, ShellLookupHandle } from "./types.ts";

export const posixPlatformHelpers = {
  executableExtensions: [""] as readonly string[],
  usesPiShellWrapper: true,

  dirEnv(dirs: { readonly home: string; readonly tmp: string }): Record<string, string> {
    return { HOME: dirs.home, TMPDIR: dirs.tmp };
  },

  checkChildEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      PATH: sourceEnv.PATH,
      HOME: sourceEnv.HOME,
      TMPDIR: sourceEnv.TMPDIR,
    };
  },

  async openDirectoryIdentity(canonicalPath: string): Promise<DirectoryIdentity> {
    const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isDirectory()) {
        throw Object.assign(new Error(`not a directory: ${canonicalPath}`), { code: "ENOTDIR" });
      }
      return { dev: stats.dev, ino: stats.ino };
    } finally {
      await handle.close();
    }
  },

  async openRegularFileNoFollow(absolutePath: string): Promise<FileHandle> {
    return open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  },

  async isExecutableAccessible(path: string): Promise<boolean> {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },

  wrapExecutableCommand(executable: string, args: readonly string[]): readonly [string, ...string[]] {
    return [executable, ...args];
  },

  spawnShellLookup(command: string, cwd: string): ShellLookupHandle {
    // Spawn in its own process group so abort/timeout kills the shell and any direct child
    // regardless of whether `/bin/sh` exec-optimizes simple commands (dash vs bash).
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    return {
      child,
      terminate() {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already exited.
          }
        }
      },
    };
  },

  mockForwarderSpec(): MockForwarderSpec {
    return {
      assetPath: fileURLToPath(new URL("./posix-forwarder.sh", import.meta.url)),
      clientPath: fileURLToPath(new URL("./posix-forwarder-client.mjs", import.meta.url)),
      templateName: "forward",
      quote: (value: string) => `'${value.replaceAll("'", "'\\''")}'`,
      targetFileName: (target: string) => target,
      resolvePathTargetName: (selfPath: string, forwarderRoot: string) =>
        dirname(selfPath) === forwarderRoot ? basename(selfPath) : undefined,
    };
  },

  async listenMockServer(server: Server, runRootDir: string): Promise<MockEndpoint> {
    // A Unix socket path is limited to about 100 bytes, so it cannot live under the run root.
    const socketPath = join(tmpdir(), `${basename(runRootDir)}.sock`);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return {
      socketPath,
      cleanup: async () => {
        await rm(socketPath, { force: true });
      },
    };
  },
};

export type PosixPlatformHelpers = typeof posixPlatformHelpers;
export type { ChildProcessWithoutNullStreams };
