import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { renderSeatbeltPolicy, sandboxExecutablePath, writeSeatbeltPolicy } from "./policy.ts";

const systemRoots = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/private/etc",
  "/Library",
  "/dev",
  "/private/var/select",
  "/private/var/db/timezone",
];

test("Seatbelt policy renders deny-default, scoped reads, writes, and network", () => {
  const policy = renderSeatbeltPolicy({
    writableRoots: ['/tmp/with "quote"'],
    readableRoots: ["/usr"],
    readableFiles: ["/opt/launcher"],
    allowNetwork: true,
  });
  assert.match(policy, /^\(version 1\)\n\(deny default\)/);
  assert.match(policy, /\(allow file-write\* \(subpath "\/tmp\/with \\"quote\\""\)/);
  assert.match(policy, /\(allow file-read\* .*\(subpath "\/usr"\)/);
  assert.match(policy, /\(literal "\/opt\/launcher"\)/);
  assert.match(policy, /\(allow file-read-metadata/);
  assert.match(policy, /\(allow network-outbound\)/);
  assert.doesNotMatch(policy, /\(allow default\)/);
});

test("Seatbelt policy omits network when not requested", () => {
  const policy = renderSeatbeltPolicy({ writableRoots: ["/tmp/ws"], readableRoots: [], allowNetwork: false });
  assert.doesNotMatch(policy, /network-outbound/);
});

test(
  "real Seatbelt allows workspace reads and writes and denies escapes",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await makeTempDir(t, "ae-sandbox-");
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, "allowed.txt"), "allowed\n");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(workspace, "escape.txt"));

    const policyPath = await writeSeatbeltPolicy(workspace, {
      writableRoots: [workspace],
      readableRoots: systemRoots,
      allowNetwork: false,
    });

    const run = (command: string, args: string[]) =>
      spawnSync(sandboxExecutablePath(), ["-f", policyPath, "--", command, ...args], {
        encoding: "utf8",
        timeout: 15_000,
      });

    const allowedRead = run("/bin/cat", [join(workspace, "allowed.txt")]);
    assert.equal(allowedRead.status, 0, allowedRead.stderr);
    assert.equal(allowedRead.stdout, "allowed\n");

    const deniedRead = run("/bin/cat", [join(outside, "secret.txt")]);
    assert.notEqual(deniedRead.status, 0);
    assert.match(deniedRead.stderr, /Operation not permitted/);

    const deniedSymlink = run("/bin/cat", [join(workspace, "escape.txt")]);
    assert.notEqual(deniedSymlink.status, 0);
    assert.match(deniedSymlink.stderr, /Operation not permitted/);

    const allowedWrite = run("/bin/sh", ["-c", `printf written > ${shellQuote(join(workspace, "new.txt"))}`]);
    assert.equal(allowedWrite.status, 0, allowedWrite.stderr);
    assert.equal(await readFile(join(workspace, "new.txt"), "utf8"), "written");

    const deniedWrite = run("/bin/sh", ["-c", `printf escaped > ${shellQuote(join(outside, "new.txt"))}`]);
    assert.notEqual(deniedWrite.status, 0);
    assert.match(deniedWrite.stderr, /Operation not permitted/);
  },
);

test("real Seatbelt runs Node with scoped filesystem access", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await makeTempDir(t, "ae-sandbox-node-");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret\n");
  const node = execFileSync(
    process.execPath,
    ["-e", "console.log(require('node:fs').realpathSync(process.execPath))"],
    {
      encoding: "utf8",
    },
  ).trim();
  const nodeDirectory = dirname(node);

  const policyPath = await writeSeatbeltPolicy(workspace, {
    writableRoots: [workspace],
    readableRoots: [...systemRoots, nodeDirectory, dirname(nodeDirectory)],
    allowNetwork: false,
  });

  const script = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(join(workspace, "from-node.txt"))}, 'ok');`,
    "let denied = false;",
    `try { fs.readFileSync(${JSON.stringify(join(outside, "secret.txt"))}); } catch (error) { denied = error.code === 'EPERM'; }`,
    "if (!denied) { process.exit(3); }",
    "console.log('node sandbox ok');",
  ].join(" ");

  const result = spawnSync(sandboxExecutablePath(), ["-f", policyPath, "--", node, "-e", script], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node sandbox ok/);
  assert.equal(await readFile(join(workspace, "from-node.txt"), "utf8"), "ok");
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
