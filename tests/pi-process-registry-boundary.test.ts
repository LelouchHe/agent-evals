import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createPiProcess, resolvePiExecutable, stopPiSession } from "../src/runners/pi/session.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

async function waitDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test(
  "real Pi RPC bash cannot make the evaluator signal an unrelated external process group",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async (t) => {
    let executable: string;
    try {
      executable = await resolvePiExecutable("pi");
    } catch {
      t.skip("Pi is not installed on PATH");
      return;
    }

    const victim: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const victimPid = victim.pid;
    assert.ok(victimPid !== undefined && victimPid > 1);
    const victimExit = new Promise<void>((resolve) => victim.once("exit", () => resolve()));
    t.after(async () => {
      try {
        process.kill(-victimPid, "SIGKILL");
      } catch {
        try {
          process.kill(victimPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await victimExit;
    });

    const root = await makeTempDir(t, "ae-pi-registry-");
    const workspaceDir = join(root, "workspace");
    const homeDir = join(root, "home");
    const configDir = join(root, "config");
    const scratchDir = join(root, "scratch");
    await Promise.all([mkdir(workspaceDir), mkdir(homeDir), mkdir(configDir), mkdir(scratchDir)]);

    const config = {
      executable,
      runRootDir: root,
      thinking: "off" as const,
      dirs: { workspaceDir, homeDir, configDir, scratchDir },
      skills: [],
      tools: ["bash"],
      allowNetwork: false,
    };
    const pi = await createPiProcess(config);
    let ownedShell = 0;
    t.after(async () => {
      if (ownedShell > 0) {
        try {
          process.kill(-ownedShell, "SIGKILL");
        } catch {
          try {
            process.kill(ownedShell, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      await pi.stop();
    });

    const pending = pi.command(
      "bash",
      {
        command: `state="$AGENT_EVALS_SHELL_STATE_DIR"; printf forged > "$state/${victimPid}"; echo $$ > shell.pid; /bin/sleep 30`,
      },
      20_000,
    );
    pending.catch(() => {});

    const forgePath = join(scratchDir, "shell-groups", String(victimPid));
    const shellPath = join(workspaceDir, "shell.pid");
    const startDeadline = performance.now() + 5_000;
    while (performance.now() < startDeadline) {
      try {
        ownedShell = Number((await readFile(shellPath, "utf8")).trim());
        if (Number.isSafeInteger(ownedShell) && ownedShell > 1 && (await stat(forgePath)).isFile()) {
          break;
        }
      } catch {
        // wait for the sandboxed bash command to start
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ownedShell > 1, "sandboxed shell did not start");
    assert.equal((await stat(forgePath)).isFile(), true);
    assert.equal(await waitDead(victimPid, 50), false, "synthetic victim should be alive before stop");

    await stopPiSession(pi);
    await pending.catch(() => {});
    await waitDead(victimPid, 200);
    assert.equal(
      await waitDead(victimPid, 50),
      false,
      "forged registry entry caused the host to signal an external group",
    );
    assert.equal(await waitDead(ownedShell, 5_000), true, "owned sandbox shell survived teardown");
  },
);
