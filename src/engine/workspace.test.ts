import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import {
  MAX_CHECK_BYTES,
  readRunFile,
  resolveWorkspacePath,
  runFileExists,
  WorkspacePathError,
} from "./workspace.ts";

test("workspace paths resolve relative to the run root", async (t) => {
  const root = await makeTempDir(t, "ae-workspace-");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "file.txt"), "content");

  const resolved = await resolveWorkspacePath(root, "nested/file.txt");
  assert.equal(resolved, join(await realpath(root), "nested", "file.txt"));
  assert.equal((await readRunFile(root, "nested/file.txt")).toString("utf8"), "content");

  const missing = await resolveWorkspacePath(root, "nested/missing.txt");
  assert.equal(missing, join(await realpath(root), "nested", "missing.txt"));
  assert.equal(await runFileExists(root, "nested/missing.txt"), false);
});

test("workspace paths reject absolute, parent, and NUL paths", async (t) => {
  const root = await makeTempDir(t, "ae-workspace-bad-");
  for (const path of ["/etc/passwd", "../outside", "nested/../../outside", "", "nul\0byte"]) {
    await assert.rejects(() => resolveWorkspacePath(root, path), WorkspacePathError, JSON.stringify(path));
  }
});

test("workspace paths reject symlinks that escape, including ancestors", async (t) => {
  const root = await makeTempDir(t, "ae-workspace-symlink-");
  const outside = await makeTempDir(t, "ae-workspace-outside-");
  await writeFile(join(outside, "secret.txt"), "secret");
  await mkdir(join(root, "inner"));

  await symlink(outside, join(root, "escape-dir"));
  await symlink(join(outside, "secret.txt"), join(root, "escape-file"));
  await symlink(join(outside, "missing.txt"), join(root, "broken-file"));

  await assert.rejects(() => resolveWorkspacePath(root, "escape-dir/secret.txt"), /outside the run workspace/);
  await assert.rejects(() => resolveWorkspacePath(root, "escape-file"), /outside the run workspace/);
  await assert.rejects(() => resolveWorkspacePath(root, "broken-file"), /broken symlink/);
});

test("workspace paths allow symlinks that stay inside", async (t) => {
  const root = await makeTempDir(t, "ae-workspace-inside-");
  await mkdir(join(root, "real"));
  await writeFile(join(root, "real", "file.txt"), "inside");
  await symlink("real", join(root, "link-dir"));
  await symlink(join(root, "real", "file.txt"), join(root, "link-file"));

  assert.equal((await readRunFile(root, "link-dir/file.txt")).toString("utf8"), "inside");
  assert.equal((await readRunFile(root, "link-file")).toString("utf8"), "inside");
});

test("readRunFile bounds file size and rejects directories", async (t) => {
  const root = await makeTempDir(t, "ae-workspace-size-");
  await writeFile(join(root, "large.txt"), Buffer.alloc(MAX_CHECK_BYTES + 1, 0x61));
  await mkdir(join(root, "directory"));

  await assert.rejects(() => readRunFile(root, "large.txt"), /check limit/);
  await assert.rejects(() => readRunFile(root, "directory"), /not a regular file/);
  await assert.rejects(() => readRunFile(root, "missing.txt"), (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  });
});

test("workspace helper does not inspect an unrelated host file through a symlink", async (t) => {
  const root = await makeTempDir(t, "ae-workspace-host-");
  const outside = await makeTempDir(t, "ae-workspace-host-outside-");
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "do not read");
  await symlink(secret, join(root, "leak.txt"));

  await assert.rejects(() => readRunFile(root, "leak.txt"), WorkspacePathError);
  assert.equal(await readFile(secret, "utf8"), "do not read");
});
