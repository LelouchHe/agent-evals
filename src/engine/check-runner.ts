import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * In-sandbox check-program launcher.
 *
 * Places any staged check files into the workspace, starts the author's program with exactly
 * `PATH`, `HOME` and `TMPDIR`, and reports the placement failure or the program's exact wait
 * status over the host's private report pipe at FD 5 (never inherited by the untrusted child).
 * Placement runs here, inside the sandbox, so Seatbelt's write policy contains it.
 */

type Outcome =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "signalled"; readonly signal: string }
  | { readonly kind: "failed"; readonly reason: string };

const [stagingDir, program, ...args] = process.argv.slice(2);
const REPORT_PIPE = process.env.AGENT_EVALS_REPORT_PIPE;
let settled = false;

function report(outcome: Outcome): void {
  if (settled) return;
  settled = true;
  const line = JSON.stringify(outcome) + "\n";
  try {
    if (typeof REPORT_PIPE === "string" && REPORT_PIPE.length > 0) {
      const fd = openSync(REPORT_PIPE, "w");
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
    } else {
      writeSync(5, line);
    }
  } catch {
    // Host closed the report pipe (for example on timeout or cancellation).
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
  );
}

/** Place the staged tree into the workspace without following any symlink the agent planted. */
async function placeStaged(staging: string, workspace: string): Promise<void> {
  await placeNode(staging, workspace, []);
}

async function placeNode(source: string, root: string, segments: readonly string[]): Promise<void> {
  const info = await lstat(source);
  if (info.isDirectory()) {
    await ensureDirectory(root, segments);
    for (const name of await readdir(source)) {
      await placeNode(join(source, name), root, [...segments, name]);
    }
    return;
  }
  await ensureDirectory(root, segments.slice(0, -1));
  await replaceFile(source, join(root, ...segments), segments.join("/"));
}

/** Create or verify every directory component without following a symlink. */
async function ensureDirectory(root: string, segments: readonly string[]): Promise<void> {
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
      throw new Error(`cannot place files through the symlink at ${path}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`needs a directory at ${path}, where a file exists`);
    }
  }
}

/** Replace whatever is at a file's destination, so copying never follows a link. */
async function replaceFile(source: string, target: string, destination: string): Promise<void> {
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
      throw new Error(`places a file at ${destination}, where a directory exists`);
    }
    await unlink(target);
  }
  await copyFile(source, target);
}

async function main(): Promise<void> {
  if (stagingDir !== undefined && stagingDir !== "-") {
    try {
      await placeStaged(stagingDir, process.cwd());
    } catch (error) {
      report({ kind: "failed", reason: `could not place files: ${errorMessage(error)}` });
      return;
    }
  }
  if (program === undefined) {
    report({ kind: "failed", reason: "the check named no program" });
    return;
  }
  try {
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    };
    if (process.platform === "win32") {
      for (const key of [
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
      ]) {
        if (process.env[key] !== undefined) childEnv[key] = process.env[key];
      }
    }
    const child = spawn(program, args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    child.on("error", (error) => {
      report({ kind: "failed", reason: `could not start ${program}: ${errorCode(error)}` });
    });
    child.on("close", (code, signal) => {
      report(signal === null ? { kind: "exited", exitCode: code ?? 1 } : { kind: "signalled", signal });
    });
  } catch (error) {
    report({ kind: "failed", reason: `could not start ${program}: ${errorCode(error)}` });
  }
}

void main();
