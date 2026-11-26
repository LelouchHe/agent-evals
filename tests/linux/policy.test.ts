import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../helpers/fake-pi-control.ts";
import {
  buildBwrapArgs,
  buildBwrapOptions,
  bwrapExecutablePath,
  prepareBwrapLaunch,
  resolveExternalSymlinkTarget,
} from "../../src/platform/linux/policy.ts";

test("buildBwrapOptions rejects embedded NUL bytes without leaking values", () => {
  assert.throws(
    () =>
      buildBwrapOptions(
        { writableRoots: [], readableRoots: [], readAll: true, allowNetwork: false },
        { env: { SECRET_TOKEN: "top-secret\0--bind" } },
      ),
    (error: unknown) =>
      error instanceof Error &&
      /SECRET_TOKEN/.test(error.message) &&
      /NUL/.test(error.message) &&
      !error.message.includes("top-secret"),
  );
});

test("prepareBwrapLaunch unlinks backing files before returning so no credentials remain on disk", async (t) => {
  const dir = await makeTempDir(t, "ae-bwrap-unlinked-");
  const launch = await prepareBwrapLaunch(
    dir,
    { writableRoots: [], readableRoots: [], readAll: true, allowNetwork: false },
    { SYNTHETIC_SECRET: "must-not-stay-on-disk" },
  );
  try {
    assert.deepEqual(await readdir(dir), []);
  } finally {
    launch.closeFds();
  }
  assert.deepEqual(await readdir(dir), []);
});

test(
  "resolveExternalSymlinkTarget handles multi-hop chains starting inside mounted directories",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await makeTempDir(t, "ae-resolv-hops-");
    const etcDir = join(root, "etc");
    const runDir = join(root, "run");
    const optDir = join(root, "opt");
    await Promise.all([mkdir(etcDir), mkdir(runDir), mkdir(optDir)]);
    const finalTarget = join(optDir, "resolv.conf");
    const unmountedHop = join(runDir, "stub-resolv.conf");
    const mountedHop = join(etcDir, "resolv-alias.conf");
    const entry = join(etcDir, "resolv.conf");
    await writeFile(finalTarget, "nameserver 1.1.1.1\n");
    await symlink(finalTarget, unmountedHop);
    await symlink(unmountedHop, mountedHop);
    await symlink(mountedHop, entry);

    const resolved = resolveExternalSymlinkTarget(entry, (path) => path.startsWith(`${etcDir}/`));
    assert.deepEqual(resolved, { source: await realpath(finalTarget), dest: unmountedHop });
  },
);

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
  assert.ok(args.includes("--new-session"));
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
