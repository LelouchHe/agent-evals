import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { buildBwrapArgs, bwrapExecutablePath } from "./policy.ts";

test("bwrap policy enables PID cleanup and unshares network when denied", () => {
  const args = buildBwrapArgs(
    {
      writableRoots: [],
      readableRoots: [],
      readAll: true,
      allowNetwork: false,
    },
    "/bin/true",
    [],
  );
  assert.ok(args.includes("--unshare-pid"));
  assert.ok(args.includes("--die-with-parent"));
  assert.ok(args.includes("--unshare-net"));
  assert.deepEqual(args.slice(-2), ["--", "/bin/true"]);
});

test("bwrap policy omits --unshare-net when network is allowed", () => {
  const args = buildBwrapArgs(
    {
      writableRoots: [],
      readableRoots: [],
      readAll: true,
      allowNetwork: true,
    },
    "/bin/true",
    ["--flag"],
  );
  assert.ok(!args.includes("--unshare-net"));
  assert.deepEqual(args.slice(-3), ["--", "/bin/true", "--flag"]);
});

test(
  "real bwrap allows workspace reads and writes, blocks escapes, and masks denied executables",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await makeTempDir(t, "ae-bwrap-");
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, "allowed.txt"), "allowed\n");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(workspace, "escape.txt"));

    const run = (command: string, args: string[], denyExecutables?: readonly string[]) =>
      spawnSync(
        bwrapExecutablePath(),
        buildBwrapArgs(
          {
            writableRoots: [workspace],
            readableRoots: [],
            ...(denyExecutables === undefined ? {} : { denyExecutables }),
            allowNetwork: false,
          },
          command,
          args,
        ),
        { encoding: "utf8", timeout: 15_000 },
      );

    const allowedRead = run("/bin/cat", [join(workspace, "allowed.txt")]);
    assert.equal(allowedRead.status, 0, allowedRead.stderr);
    assert.equal(allowedRead.stdout, "allowed\n");

    const deniedRead = run("/bin/cat", [join(outside, "secret.txt")]);
    assert.notEqual(deniedRead.status, 0);

    const deniedSymlink = run("/bin/cat", [join(workspace, "escape.txt")]);
    assert.notEqual(deniedSymlink.status, 0);

    const allowedWrite = run("/bin/sh", ["-c", `printf written > ${shellQuote(join(workspace, "new.txt"))}`]);
    assert.equal(allowedWrite.status, 0, allowedWrite.stderr);
    assert.equal(await readFile(join(workspace, "new.txt"), "utf8"), "written");

    const deniedWrite = run("/bin/sh", ["-c", `printf escaped > ${shellQuote(join(outside, "new.txt"))}`]);
    assert.notEqual(deniedWrite.status, 0);

    const deniedExe = run("/bin/sh", ["-c", "/usr/bin/true"], ["/usr/bin/true"]);
    assert.notEqual(deniedExe.status, 0);
  },
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
