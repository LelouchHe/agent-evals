import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { SupervisedProcess } from "../types.ts";
import { spawnSupervised } from "./supervise.ts";

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
    `Linux bwrap supervisor ${trigger} reaps descendants and isolates other processes`,
    { skip: process.platform !== "linux" },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "ae-linux-supervise-"));
      const supervisors: SupervisedProcess[] = [];
      const controls: { outside?: ChildProcess } = {};
      t.after(async () => {
        try {
          for (const proc of supervisors) await proc.stop();
        } finally {
          controls.outside?.kill("SIGKILL");
          await until(() => controls.outside?.pid === undefined || !alive(controls.outside.pid));
          await rm(root, { recursive: true, force: true });
        }
      });

      const aDir = join(root, "a");
      const bDir = join(root, "b");
      await Promise.all([mkdir(aDir), mkdir(bDir)]);
      const policy = {
        writableRoots: [root],
        readableRoots: [],
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

      const marker = join(root, "orphan-ran");
      const workload = join(root, "workload.sh");
      await writeFile(
        workload,
        `trap '' TERM INT
(sleep 0.4; printf escaped > "$ROOT/orphan-ran") >/dev/null 2>&1 &
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

      if (trigger === "stop") {
        await a.stop();
        await assert.rejects(a.completion, /without a workload completion/);
      } else {
        a.child.stdin!.end("finish\n");
        assert.equal(await a.completion, trigger === "success" ? 0 : 7);
      }

      // Wait longer than the background child's sleep to confirm the PID namespace killed it.
      await delay(600);
      await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
      assert.ok(outside.pid !== undefined && alive(outside.pid), "host control was killed");
      assert.ok(b.child.pid !== undefined && alive(b.child.pid), "independent sandbox control was killed");
    },
  );
}
