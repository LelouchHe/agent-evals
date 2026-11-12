import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createPiProcess, resolvePiExecutable, stopPiSession } from "../src/runners/pi/session.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

test(
  "real Pi RPC bash: the wrapper preserves command output and exit status",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async (t) => {
    let executable: string;
    try {
      executable = await resolvePiExecutable("pi");
    } catch {
      t.skip("Pi is not installed on PATH");
      return;
    }

    const root = await makeTempDir(t, "ae-pi-status-");
    const dirs = {
      workspaceDir: join(root, "workspace"),
      homeDir: join(root, "home"),
      configDir: join(root, "config"),
      scratchDir: join(root, "scratch"),
    };
    await Promise.all(Object.values(dirs).map((path) => mkdir(path)));
    const pi = await createPiProcess({
      executable,
      runRootDir: root,
      thinking: "off",
      dirs,
      skills: [],
      tools: ["bash"],
      allowNetwork: false,
    });
    t.after(() => pi.stop());

    const response = (await pi.command("bash", { command: "printf wrapper-ok; exit 7" }, 15_000)) as {
      output?: unknown;
      exitCode?: unknown;
    };
    assert.equal(response.output, "wrapper-ok");
    assert.equal(response.exitCode, 7);
  },
);

test(
  "real Pi RPC bash: a detached background process is terminated before the command returns",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async (t) => {
    let executable: string;
    try {
      executable = await resolvePiExecutable("pi");
    } catch {
      t.skip("Pi is not installed on PATH");
      return;
    }

    const root = await makeTempDir(t, "ae-pi-bg-");
    const workspaceDir = join(root, "workspace");
    const homeDir = join(root, "home");
    const configDir = join(root, "config");
    const scratchDir = join(root, "scratch");
    await Promise.all([mkdir(workspaceDir), mkdir(homeDir), mkdir(configDir), mkdir(scratchDir)]);

    const pi = await createPiProcess({
      executable,
      runRootDir: root,
      thinking: "off",
      dirs: { workspaceDir, homeDir, configDir, scratchDir },
      skills: [],
      tools: ["bash"],
      allowNetwork: false,
    });

    let backgroundShell = 0;
    t.after(async () => {
      if (backgroundShell > 0) {
        try {
          process.kill(-backgroundShell, "SIGKILL");
        } catch {
          try {
            process.kill(backgroundShell, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      await pi.stop();
    });

    const response = (await pi.command(
      "bash",
      { command: `/bin/sh -c '/bin/sleep 1; printf late > late.txt; /bin/sleep 30' >/dev/null 2>&1 & echo $!` },
      15_000,
    )) as { output?: unknown; exitCode?: unknown; cancelled?: unknown };

    assert.equal(response.exitCode, 0);
    assert.equal(response.cancelled, false);
    backgroundShell = Number(String(response.output).trim());
    assert.ok(
      Number.isSafeInteger(backgroundShell) && backgroundShell > 0,
      `unexpected output: ${String(response.output)}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    assert.equal(
      await stat(join(workspaceDir, "late.txt"))
        .then(() => true)
        .catch(() => false),
      false,
      "background process wrote late.txt after the bash command returned",
    );
    assert.throws(() => process.kill(backgroundShell, 0), `background process ${backgroundShell} is still alive`);
  },
);

test(
  "real Pi RPC bash: stopping the session terminates an active wrapper shell group",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async (t) => {
    let executable: string;
    try {
      executable = await resolvePiExecutable("pi");
    } catch {
      t.skip("Pi is not installed on PATH");
      return;
    }

    const root = await makeTempDir(t, "ae-pi-stop-");
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
    let shellPid = 0;
    t.after(async () => {
      if (shellPid > 0) {
        try {
          process.kill(-shellPid, "SIGKILL");
        } catch {
          try {
            process.kill(shellPid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      await pi.stop();
    });

    const pending = pi.command("bash", { command: `echo $$ > shell.pid; /bin/sleep 30` }, 20_000);
    pending.catch(() => {});

    const pidFile = join(workspaceDir, "shell.pid");
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      try {
        shellPid = Number((await readFile(pidFile, "utf8")).trim());
        if (Number.isSafeInteger(shellPid) && shellPid > 0) {
          break;
        }
      } catch {
        // wait for the wrapper to start the command
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(shellPid > 0, "wrapper did not start the shell command");

    await stopPiSession(pi);
    await pending.catch(() => {});

    const stopDeadline = performance.now() + 5_000;
    while (performance.now() < stopDeadline) {
      try {
        process.kill(shellPid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.throws(() => process.kill(shellPid, 0), `shell process ${shellPid} survived session stop`);
  },
);

test(
  "real Pi RPC bash: early Pi death still leaves tracked shell groups for cleanup",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async (t) => {
    let executable: string;
    try {
      executable = await resolvePiExecutable("pi");
    } catch {
      t.skip("Pi is not installed on PATH");
      return;
    }

    const root = await makeTempDir(t, "ae-pi-early-");
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
    let shellPid = 0;
    t.after(async () => {
      if (shellPid > 0) {
        try {
          process.kill(-shellPid, "SIGKILL");
        } catch {
          try {
            process.kill(shellPid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      await pi.stop();
    });

    const pending = pi.command("bash", { command: `echo $$ > shell.pid; /bin/sleep 30` }, 20_000);
    pending.catch(() => {});

    const pidFile = join(workspaceDir, "shell.pid");
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      try {
        shellPid = Number((await readFile(pidFile, "utf8")).trim());
        if (Number.isSafeInteger(shellPid) && shellPid > 0) {
          break;
        }
      } catch {
        // wait for the wrapper to start the command
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(shellPid > 0, "wrapper did not start the shell command");

    const supervisorPid = pi.pid;
    assert.ok(supervisorPid !== undefined);
    const childPids = execFileSync("/bin/ps", ["-ax", "-o", "pid=,ppid="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((pair) => pair[1] === supervisorPid)
      .map((pair) => pair[0] as number)
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    assert.equal(childPids.length, 1, `expected one Pi child, got ${childPids.join(",")}`);
    process.kill(childPids[0] as number, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await stopPiSession(pi);
    await pending.catch(() => {});

    const stopDeadline = performance.now() + 5_000;
    while (performance.now() < stopDeadline) {
      try {
        process.kill(shellPid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.throws(() => process.kill(shellPid, 0), `shell process ${shellPid} survived early Pi death`);
  },
);
