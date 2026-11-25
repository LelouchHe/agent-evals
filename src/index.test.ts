import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../tests/helpers/fake-pi-control.ts";
import { openRunRoot } from "./engine/workspace.ts";
import {
  ConfigError,
  MAX_CHECK_BYTES,
  WorkspacePathError,
  compileMockArgs,
  expectMockArgs,
  expectMockTarget,
  isMissing,
  mockTargetIdentity,
  patternListSchema,
  readRunFile,
  readRunTree,
  runPathExists,
  searches,
} from "./index.ts";

/** A checker extension sees only this entry; the file checker's evidence path must be usable from it. */
test("the package entry exposes the evidence access a file-like checker needs", async (t) => {
  const root = await makeTempDir(t, "ae-public-");
  await mkdir(join(root, "vault"));
  await writeFile(join(root, "vault", "state.md"), "state\n");
  await symlink("vault", join(root, "link"));
  const runRoot = await openRunRoot(root);

  assert.equal((await readRunFile(runRoot, "vault/state.md")).toString("utf8"), "state\n");
  assert.equal(await runPathExists(runRoot, "vault"), true);
  assert.equal(await runPathExists(runRoot, "missing"), false);
  assert.deepEqual(Object.fromEntries((await readRunTree(runRoot, "vault"))!), {
    "": { kind: "directory" },
    "state.md": { kind: "file", size: 6 },
  });
  // The named node is the link; its target is not followed.
  assert.deepEqual([...(await readRunTree(runRoot, "link"))!], [["", { kind: "symlink" }]]);

  assert.equal(searches("^state", "state\n"), true);
  assert.deepEqual(
    patternListSchema.parse(["literal", "/a.c/"]).map((pattern) => pattern.regex),
    [false, true],
  );

  assert.equal(MAX_CHECK_BYTES, 1024 * 1024);
  await assert.rejects(() => readRunFile(runRoot, "vault"), WorkspacePathError);
  assert.equal(isMissing(Object.assign(new Error("missing"), { code: "ENOENT" })), true);
  assert.equal(typeof ConfigError, "function");
});

/** A mock-style checker reads the declared grammar and the recorded calls; both are public. */
test("the package entry exposes the mock argument grammar and matcher", () => {
  const matches = compileMockArgs(expectMockArgs(["push", "/a.c/"], "test"));

  assert.equal(matches(["push", "abc"]), true);
  assert.equal(matches(["pull", "abc"]), false);
  assert.equal(matches(["push"]), false);

  // A bare command name and a workspace path are different targets, and both spellings of one
  // workspace path are the same target.
  assert.equal(mockTargetIdentity("./scripts/x"), mockTargetIdentity("scripts/x"));
  assert.notEqual(mockTargetIdentity("x"), mockTargetIdentity("./x"));
  assert.equal(expectMockTarget("x", "test"), "x");
  assert.throws(() => expectMockTarget("dir/", "test"), ConfigError);
});
