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

test(
  "Linux no-network seccomp denies AF_UNIX datagram socket creation with EPERM",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ae-linux-seccomp-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const supervised = await spawnSupervised({
      policy: { writableRoots: [root], readableRoots: [], readAll: true, allowNetwork: false },
      policyDirectory: root,
      command: [
        "/usr/bin/perl",
        "-MSocket",
        "-e",
        'socket(my $s, PF_UNIX, SOCK_DGRAM, 0) and exit 2; $!{EPERM} or die "unexpected: $!"; print "EPERM\n"; exit 0;',
      ],
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      interactive: false,
    });
    t.after(() => supervised.stop());
    let out = "";
    supervised.child.stdout!.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    assert.equal(await supervised.completion, 0);
    assert.equal(out.trim(), "EPERM");
  },
);

test(
  "Linux interactive supervisor allocates a private PTY where /dev/tty and input work",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ae-linux-pty-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const driver = join(root, "pty-driver.mjs");
    const marker = join(root, "got-input.txt");
    const superviseModule = new URL("./supervise.ts", import.meta.url).href;
    await writeFile(
      driver,
      `import { spawnSupervised } from ${JSON.stringify(superviseModule)};
const proc = await spawnSupervised({
  policy: { writableRoots: [${JSON.stringify(root)}], readableRoots: [], readAll: true, allowNetwork: false },
  policyDirectory: ${JSON.stringify(root)},
  command: [
    "/bin/sh",
    "-c",
    'exec 3<>/dev/tty || exit 11; printf "tty-ready\\n" >&3; IFS= read -r line; printf "%s" "$line" > ' + ${JSON.stringify(marker)},
  ],
  cwd: ${JSON.stringify(root)},
  env: { PATH: "/usr/bin:/bin" },
  interactive: true,
});
process.exit(await proc.completion);
`,
    );
    // Run the driver itself attached to a PTY via util-linux `script` so stdin.isTTY is true.
    const child = spawn("/usr/bin/script", ["-q", "-e", "-f", "-c", `${process.execPath} ${driver}`, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("tty-ready")) {
        child.stdin.write("confirm-pty\n");
      }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    assert.equal(code, 0, out);
    assert.equal((await readFile(marker, "utf8")).trim(), "confirm-pty");
  },
);
