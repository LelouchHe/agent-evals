import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import {
  MAX_CHECK_BYTES,
  openRunRoot,
  readRunFile,
  resolveWorkspacePath,
  runFileExists,
  WorkspacePathError,
} from "./workspace.ts";

test("workspace paths resolve relative to the run root", async (t) => {
  const path = await makeTempDir(t, "ae-workspace-");
  await mkdir(join(path, "nested"));
  await writeFile(join(path, "nested", "file.txt"), "content");
  const root = await openRunRoot(path);

  const resolved = await resolveWorkspacePath(root, "nested/file.txt");
  assert.equal(resolved, join(await realpath(path), "nested", "file.txt"));
  assert.equal((await readRunFile(root, "nested/file.txt")).toString("utf8"), "content");

  const missing = await resolveWorkspacePath(root, "nested/missing.txt");
  assert.equal(missing, join(await realpath(path), "nested", "missing.txt"));
  assert.equal(await runFileExists(root, "nested/missing.txt"), false);
});

test("workspace paths reject absolute, parent, and NUL paths", async (t) => {
  const path = await makeTempDir(t, "ae-workspace-bad-");
  const root = await openRunRoot(path);
  for (const requested of ["/etc/passwd", "../outside", "nested/../../outside", "", "nul\0byte"]) {
    await assert.rejects(() => resolveWorkspacePath(root, requested), WorkspacePathError, JSON.stringify(requested));
  }
});

test("workspace paths reject symlinks that escape, including ancestors", async (t) => {
  const path = await makeTempDir(t, "ae-workspace-symlink-");
  const outside = await makeTempDir(t, "ae-workspace-outside-");
  await writeFile(join(outside, "secret.txt"), "secret");
  await mkdir(join(path, "inner"));
  const root = await openRunRoot(path);

  await symlink(outside, join(path, "escape-dir"));
  await symlink(join(outside, "secret.txt"), join(path, "escape-file"));
  await symlink(join(outside, "missing.txt"), join(path, "broken-file"));

  await assert.rejects(() => resolveWorkspacePath(root, "escape-dir/secret.txt"), /outside the run workspace/);
  await assert.rejects(() => resolveWorkspacePath(root, "escape-file"), /outside the run workspace/);
  await assert.rejects(() => resolveWorkspacePath(root, "broken-file"), /broken symlink/);
});

test("workspace paths allow symlinks that stay inside", async (t) => {
  const path = await makeTempDir(t, "ae-workspace-inside-");
  await mkdir(join(path, "real"));
  await writeFile(join(path, "real", "file.txt"), "inside");
  await symlink("real", join(path, "link-dir"));
  await symlink(join(path, "real", "file.txt"), join(path, "link-file"));
  const root = await openRunRoot(path);

  assert.equal((await readRunFile(root, "link-dir/file.txt")).toString("utf8"), "inside");
  assert.equal((await readRunFile(root, "link-file")).toString("utf8"), "inside");
});

test("readRunFile bounds file size and rejects directories", async (t) => {
  const path = await makeTempDir(t, "ae-workspace-size-");
  await writeFile(join(path, "large.txt"), Buffer.alloc(MAX_CHECK_BYTES + 1, 0x61));
  await mkdir(join(path, "directory"));
  const root = await openRunRoot(path);

  await assert.rejects(() => readRunFile(root, "large.txt"), /check limit/);
  await assert.rejects(() => readRunFile(root, "directory"), /not a regular file/);
  await assert.rejects(
    () => readRunFile(root, "missing.txt"),
    (error: unknown) => {
      return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    },
  );
});

test("workspace helper does not inspect an unrelated host file through a symlink", async (t) => {
  const path = await makeTempDir(t, "ae-workspace-host-");
  const outside = await makeTempDir(t, "ae-workspace-host-outside-");
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "do not read");
  await symlink(secret, join(path, "leak.txt"));
  const root = await openRunRoot(path);

  await assert.rejects(() => readRunFile(root, "leak.txt"), WorkspacePathError);
  assert.equal(await readFile(secret, "utf8"), "do not read");
});

test("a replaced run root is rejected instead of followed", async (t) => {
  const path = await makeTempDir(t, "ae-workspace-replace-");
  const outside = await makeTempDir(t, "ae-workspace-replace-outside-");
  await writeFile(join(path, "hello.txt"), "inside\n");
  await writeFile(join(outside, "hello.txt"), "outside\n");
  const root = await openRunRoot(path);
  t.after(async () => {
    await rm(`${path}-original`, { recursive: true, force: true });
  });

  await rename(path, `${path}-original`);
  await symlink(outside, path, "dir");

  await assert.rejects(() => resolveWorkspacePath(root, "hello.txt"), /replaced/);
  await assert.rejects(() => readRunFile(root, "hello.txt"), /replaced/);
  await assert.rejects(() => runFileExists(root, "hello.txt"), /replaced/);
});
