import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isSafeProcessGroup } from "./safe-process-group.ts";

/**
 * Sandbox-resident Pi supervisor.
 *
 * Pi runs as this process's child under one Seatbelt sandbox. On Pi exit or a
 * stop signal, the supervisor reads the agent-writable shell-group registry and
 * signals matching groups. Because the supervisor is inside the same sandbox,
 * Seatbelt's `(allow signal (target same-sandbox))` restriction applies: a
 * forged entry can at most target a process in this sandbox, never an unrelated
 * host process. The host evaluator never signals groups from registry data.
 */

const stateDir = process.env.AGENT_EVALS_SHELL_STATE_DIR;
const [command, ...args] = process.argv.slice(2);
if (command === undefined || command.length === 0) {
  process.exit(2);
}

let finished = false;
let names: string[] = [];

function cleanup(): void {
  if (stateDir === undefined) {
    return;
  }
  try {
    names = readdirSync(stateDir);
  } catch {
    return;
  }

  const groups = new Set<number>();
  for (const name of names) {
    if (isSafeProcessGroup(name)) {
      groups.add(Number(name));
    }
  }
  // Freeze first so a process cannot run user code between the two signals.
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGSTOP");
    } catch {
      // Forged external groups and already-dead groups are denied or absent.
    }
  }
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Forged external groups and already-dead groups are denied or absent.
    }
  }
  for (const name of names) {
    try {
      rmSync(join(stateDir, name), { force: true });
    } catch {
      // Ignore cleanup failures; the run root is removed by the engine.
    }
  }
}

function finish(code: number): void {
  if (finished) {
    return;
  }
  finished = true;
  cleanup();
  process.exit(code);
}

const child = spawn(command, args, {
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});

let stopping = false;
function stop(): void {
  if (stopping || finished) {
    return;
  }
  stopping = true;
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may already be gone.
  }
  const force = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may already be gone.
    }
  }, 750);
  force.unref();
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

child.on("exit", (code, signal) => finish(code ?? (signal === null ? 1 : 1)));
child.on("error", () => finish(1));
