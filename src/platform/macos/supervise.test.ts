import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { spawnSupervised, type SupervisedProcess } from "./supervise.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("supervisor test condition did not become true");
}

for (const trigger of ["success", "failure", "stop"] as const) {
  test(
    `sandbox-wide supervisor ${trigger} preserves outcomes and isolates other processes`,
    { skip: process.platform !== "darwin" },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "ae-supervise-"));
      const supervisors: SupervisedProcess[] = [];
      const pids: number[] = [];
      const controls: { outside?: ChildProcess } = {};
      t.after(async () => {
        try {
          for (const process of supervisors) await process.stop();
        } finally {
          // These PID files are written by our fixed synthetic workload, not by
          // evaluated code. Verify the command before fallback host-side cleanup.
          for (const role of ["background", "orphan", "session"]) {
            try {
              const pid = Number(await readFile(join(root, role), "utf8"));
              if (Number.isSafeInteger(pid) && pid > 1 && alive(pid)) {
                const command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
                  encoding: "utf8",
                }).trim();
                if (command === "/bin/sleep 65471") process.kill(pid, "SIGKILL");
              }
            } catch {
              /* Missing or already reaped. */
            }
          }
          controls.outside?.kill("SIGKILL");
          await until(
            () =>
              pids.every((pid) => !alive(pid)) && (controls.outside?.pid === undefined || !alive(controls.outside.pid)),
          );
          await rm(root, { recursive: true, force: true });
        }
      });
      const aDir = join(root, "a");
      const bDir = join(root, "b");
      await Promise.all([mkdir(aDir), mkdir(bDir)]);
      const policy = {
        writableRoots: [root],
        readableRoots: ["/System", "/usr", "/bin", "/sbin", "/dev", "/private/etc"],
        allowNetwork: false,
      };
      const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ROOT: root };
      const outside = spawn("/bin/sleep", ["65472"], { stdio: "ignore" });
      controls.outside = outside;
      const b = await spawnSupervised({
        policy,
        policyDirectory: bDir,
        command: ["/bin/sleep", "65473"],
        cwd: root,
        env,
        interactive: false,
      });
      supervisors.push(b);
      const workload = join(root, "workload.sh");
      await writeFile(
        workload,
        `trap '' TERM INT
/bin/sleep 65471 &
printf '%s' "$!" > "$ROOT/background"
/bin/sh -c 'nohup /bin/sleep 65471 >/dev/null 2>&1 & printf "%s" "$!" > "$ROOT/orphan"'
/usr/bin/perl -MPOSIX -e 'fork and exit; setsid(); open(my $f, ">", "$ENV{ROOT}/session") or die $!; print $f "$$"; close($f); exec "/bin/sleep", "65471";'
while [ ! -f "$ROOT/session" ]; do /bin/sleep 0.01; done
printf ready
read line
exit ${trigger === "failure" ? 7 : 0}
`,
      );
      const a = await spawnSupervised({
        policy,
        policyDirectory: aDir,
        command: ["/bin/sh", workload],
        cwd: root,
        env,
        interactive: false,
      });
      supervisors.push(a);
      let output = "";
      a.child.stdout!.on("data", (data: Buffer) => {
        output += data.toString();
      });
      await until(() => output === "ready");
      for (const role of ["background", "orphan", "session"])
        pids.push(Number(await readFile(join(root, role), "utf8")));
      assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && alive(pid)));
      const session = pids[2]!;
      const group = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(session)], { encoding: "utf8" });
      assert.equal(Number(group.trim()), session, "escape case must really be in a new session/group");
      if (trigger === "stop") {
        await a.stop();
        await assert.rejects(a.completion, /without a workload completion/);
      } else {
        a.child.stdin!.end("finish\n");
        assert.equal(await a.completion, trigger === "success" ? 0 : 7);
      }
      await until(() => pids.every((pid) => !alive(pid)));
      assert.ok(outside.pid !== undefined && alive(outside.pid), "host control was killed");
      assert.ok(b.child.pid !== undefined && alive(b.child.pid), "independent sandbox control was killed");
    },
  );
}
