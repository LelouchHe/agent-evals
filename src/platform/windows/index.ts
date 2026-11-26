import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, constants, lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DirectoryIdentity,
  MockEndpoint,
  MockForwarderSpec,
  PlatformBackend,
  ShellLookupHandle,
} from "../types.ts";
import { spawnSandboxed } from "./launch.ts";
import { assertWinSandboxAvailable, createSandboxPolicy, defaultTempParent, SYSTEM_PATH } from "./policy.ts";
import { spawnSupervised } from "./supervise.ts";

const WINDOWS_CHECK_CHILD_ENV_KEYS = [
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
] as const;

async function resolveDeniedExecutables(
  targets: readonly string[],
  pathEntries: readonly string[],
): Promise<readonly string[]> {
  if (targets.length === 0) return [];
  const denied: string[] = [];
  for (const target of targets) {
    for (const dir of pathEntries) {
      for (const ext of ["", ".exe", ".cmd", ".bat"]) {
        const candidate = join(dir, `${target}${ext}`);
        try {
          if ((await stat(candidate)).isFile()) denied.push(candidate, await realpath(candidate));
        } catch {
          // Not installed here.
        }
      }
    }
  }
  return denied;
}

export const windowsBackend: PlatformBackend = {
  systemPath: SYSTEM_PATH,
  caseInsensitivePaths: true,
  executableExtensions: ["", ".exe", ".cmd", ".bat"],
  usesPiShellWrapper: false,
  defaultTempParent,

  dirEnv(dirs: { readonly home: string; readonly tmp: string }): Record<string, string> {
    return {
      HOME: dirs.home,
      USERPROFILE: dirs.home,
      TMPDIR: dirs.tmp,
      TMP: dirs.tmp,
      TEMP: dirs.tmp,
    };
  },

  checkChildEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: sourceEnv.PATH,
      HOME: sourceEnv.HOME,
      TMPDIR: sourceEnv.TMPDIR,
    };
    for (const key of WINDOWS_CHECK_CHILD_ENV_KEYS) {
      if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
    }
    return env;
  },

  async openDirectoryIdentity(canonicalPath: string): Promise<DirectoryIdentity> {
    const stats = await lstat(canonicalPath, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw Object.assign(new Error(`not a directory: ${canonicalPath}`), { code: "ENOTDIR" });
    }
    return { dev: stats.dev, ino: stats.ino };
  },

  async openRegularFileNoFollow(absolutePath: string): Promise<FileHandle> {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw Object.assign(new Error(`not a regular file: ${absolutePath}`), { code: "ELOOP" });
    }
    return open(absolutePath, constants.O_RDONLY);
  },

  async isExecutableAccessible(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },

  wrapExecutableCommand(executable: string, args: readonly string[]): readonly [string, ...string[]] {
    if (/\.(?:[cm]?js|[cm]?ts)$/iu.test(executable)) {
      return [process.execPath, executable, ...args];
    }
    if (/\.(?:cmd|bat)$/iu.test(executable)) {
      return [process.env.ComSpec ?? "cmd.exe", "/d", "/c", executable, ...args];
    }
    return [executable, ...args];
  },

  spawnShellLookup(command: string, cwd: string): ShellLookupHandle {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", `"${command}"`], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    return {
      child,
      terminate() {
        if (child.pid !== undefined) {
          try {
            // Run taskkill /T /F synchronously while the shell parent still exists so
            // grandchildren (e.g. node.exe under cmd.exe) are terminated before cmd.exe exits.
            execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
              timeout: 2_000,
            });
          } catch {
            // Already exited or taskkill unavailable; fall back to direct kill below.
          }
          try {
            child.kill();
          } catch {
            // Already exited.
          }
        }
      },
    };
  },

  mockForwarderSpec(): MockForwarderSpec {
    const cmdAsset = fileURLToPath(new URL("./forwarder.cmd", import.meta.url));
    const ps1Asset = fileURLToPath(new URL("./forwarder.ps1", import.meta.url));
    const shAsset = fileURLToPath(new URL("./forwarder.sh", import.meta.url));
    const quoteCmd = (value: string): string => `"${value.replaceAll('"', '""').replaceAll("%", "%%")}"`;
    const quotePs1 = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const quoteSh = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    return {
      assetPath: cmdAsset,
      clientPath: fileURLToPath(new URL("./forwarder-client.mjs", import.meta.url)),
      templateName: "forward.cmd",
      quote: quoteCmd,
      targetFileName: (target: string) => `${target}.cmd`,
      extraPathForwarders: [
        {
          assetPath: shAsset,
          quote: quoteSh,
          templateName: "forward.sh",
          targetFileName: (target: string) => target,
        },
      ],
      workspaceForwarder: (target: string) =>
        target.toLowerCase().endsWith(".ps1")
          ? { assetPath: ps1Asset, quote: quotePs1 }
          : { assetPath: cmdAsset, quote: quoteCmd },
      resolvePathTargetName: (selfPath: string, forwarderRoot: string) => {
        if (dirname(selfPath).toLowerCase() !== forwarderRoot.toLowerCase()) return undefined;
        const raw = basename(selfPath);
        return raw.toLowerCase().endsWith(".cmd") ? raw.slice(0, -4) : raw;
      },
    };
  },

  async listenMockServer(server: Server): Promise<MockEndpoint> {
    const expectedNonce = randomBytes(16).toString("hex");
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo | null;
        if (address === null) {
          reject(new Error("mock loopback server did not bind a port"));
        } else {
          resolve(address.port);
        }
      });
    });
    return {
      socketPath: `tcp://127.0.0.1:${port}/${expectedNonce}`,
      expectedNonce,
      cleanup: async () => {},
    };
  },

  assertSandboxAvailable: assertWinSandboxAvailable,
  async setupSandbox({ teardown }): Promise<string> {
    const setupScript = fileURLToPath(new URL("./setup.ps1", import.meta.url));
    const scriptArgs = [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      setupScript,
      ...(teardown ? ["-Teardown"] : []),
    ];
    const runShell = (shell: string): Promise<number> =>
      new Promise<number>((resolveCode, reject) => {
        const child = spawn(shell, scriptArgs, { stdio: "inherit", windowsHide: false });
        child.once("error", reject);
        child.once("close", (code) => resolveCode(code ?? 1));
      });
    let code: number;
    try {
      code = await runShell("pwsh.exe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        code = await runShell("powershell.exe");
      } else {
        throw error;
      }
    }
    if (code !== 0) {
      throw new Error(
        `Windows sandbox ${teardown ? "teardown" : "setup"} failed with exit code ${code} (run from an Administrator prompt)`,
      );
    }
    return "";
  },
  createSandboxPolicy,
  resolveDeniedExecutables,
  spawnSupervised,
  spawnSandboxed,
};
