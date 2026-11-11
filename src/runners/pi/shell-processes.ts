import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TERM_WAIT_MS = 400;
const KILL_WAIT_MS = 1_500;
const POLL_MS = 25;

const activeCleanups = new Map<string, Promise<void>>();

/**
 * Terminate shell process groups registered by the Pi shell wrapper. This
 * covers detached background jobs whose parent shell has already exited, and
 * groups left behind when Pi itself exits during a command. Concurrent requests
 * for the same state directory share one cleanup.
 */
export function stopTrackedShellProcesses(stateDir: string): Promise<void> {
  const existing = activeCleanups.get(stateDir);
  if (existing !== undefined) {
    return existing;
  }
  const cleanup = runCleanup(stateDir).finally(() => {
    activeCleanups.delete(stateDir);
  });
  activeCleanups.set(stateDir, cleanup);
  return cleanup;
}

async function runCleanup(stateDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch {
    return;
  }

  const groups = new Set<number>();
  for (const name of names) {
    const parsed = Number(name);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      groups.add(parsed);
    }
  }
  if (groups.size === 0) {
    return;
  }

  for (const pgid of groups) {
    signalGroup(pgid, "SIGTERM");
  }
  await waitForQuiescence(groups, TERM_WAIT_MS);

  const remaining = new Set<number>();
  for (const pgid of groups) {
    if (await hasLiveProcess(pgid)) {
      remaining.add(pgid);
    }
  }
  for (const pgid of remaining) {
    signalGroup(pgid, "SIGKILL");
  }
  await waitForQuiescence(remaining, KILL_WAIT_MS);

  const survivors: number[] = [];
  for (const pgid of remaining) {
    if (await hasLiveProcess(pgid)) {
      survivors.push(pgid);
    }
  }
  if (survivors.length > 0) {
    throw new Error(`could not terminate tracked shell process group(s): ${survivors.join(", ")}`);
  }

  for (const pgid of groups) {
    await rm(join(stateDir, String(pgid)), { force: true });
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is already gone.
  }
}

async function hasLiveProcess(pgid: number): Promise<boolean> {
  try {
    const result = await execFileAsync("/bin/ps", ["-o", "stat=", "-g", String(pgid)], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 32 * 1024,
    });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line.length > 0 && !line.startsWith("Z"));
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    // `ps` exits 1 when the process group has no members. Any other failure is
    // uncertain, so treat the group as live and fail closed.
    return code !== 1;
  }
}

async function waitForQuiescence(groups: ReadonlySet<number>, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    let live = false;
    for (const pgid of groups) {
      if (await hasLiveProcess(pgid)) {
        live = true;
        break;
      }
    }
    if (!live) {
      return;
    }
    await delay(POLL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
