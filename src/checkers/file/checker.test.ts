import assert from "node:assert/strict";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, type ImplementationParams } from "../../engine/config.ts";
import { parseImplementationParams } from "../../engine/params.ts";
import type { CheckerContext } from "../../engine/registry.ts";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { implementationContext, unusedCheckSandbox } from "../../../tests/helpers/implementation-context.ts";
import { openRunRoot } from "../../engine/workspace.ts";
import { fileChecker } from "./checker.ts";

async function setup(t: Parameters<typeof makeTempDir>[0]) {
  const root = await makeTempDir(t, "ae-file-");
  const workspace = join(root, "workspace");
  const baseline = join(root, "baseline");
  await mkdir(workspace);
  await mkdir(baseline);
  return { root, workspace, baseline };
}

async function context(root: string, workspace: string, baseline: string): Promise<CheckerContext> {
  return {
    workspace: await openRunRoot(workspace),
    baseline: await openRunRoot(baseline),
    runRootDir: root,
    input: "task",
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(5_000),
    checkSandbox: unusedCheckSandbox,
  };
}

async function checkRaw(
  raw: ImplementationParams,
  contextValue: CheckerContext,
): Promise<readonly import("../../engine/registry.ts").CheckResult[]> {
  const params = await parseImplementationParams(fileChecker.params, raw, 'checker "file"');
  const checker = await fileChecker.create(params, implementationContext(process.cwd()));
  return checker.check(contextValue);
}

test("file checker passes existence and regex-search conditions", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "hello.txt"), "Hello, world!\n");

  const results = await checkRaw(
    { path: "hello.txt", exists: true, matches: ["world", "^Hello, world!\\n?$"] },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );

  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((result) => result.status),
    ["pass", "pass", "pass"],
  );
  assert.equal(results[0]?.subject, "hello.txt exists");
  assert.match(results[1]?.subject ?? "", /matches \/world\//);
});

test("regex search is not an implicit full-file match", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "hello.txt"), "prefix Hello, world! suffix\n");

  const results = await checkRaw(
    { path: "hello.txt", matches: ["Hello, world!", "^Hello, world!$"] },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["pass", "fail"],
  );
});

test("file checker reports absent files as failed checks", async (t) => {
  const dirs = await setup(t);

  const results = await checkRaw(
    { path: "missing.txt", exists: true, matches: "anything" },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["fail", "fail"],
  );
  assert.match(results[1]?.reason ?? "", /does not exist/);
});

test("exists false passes for an absent file and fails for a present one", async (t) => {
  const dirs = await setup(t);
  const contextValue = await context(dirs.root, dirs.workspace, dirs.baseline);

  const absent = await checkRaw({ path: "nope.txt", exists: false }, contextValue);
  assert.equal(absent[0]?.status, "pass");

  await writeFile(join(dirs.workspace, "present.txt"), "x");
  const present = await checkRaw({ path: "present.txt", exists: false }, contextValue);
  assert.equal(present[0]?.status, "fail");
});

test("unchanged compares the run file with the initial baseline", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "keep.txt"), "original\n");
  await writeFile(join(dirs.baseline, "keep.txt"), "original\n");
  const contextValue = await context(dirs.root, dirs.workspace, dirs.baseline);

  const same = await checkRaw({ path: "keep.txt", unchanged: true }, contextValue);
  assert.equal(same[0]?.status, "pass");

  await writeFile(join(dirs.workspace, "keep.txt"), "changed\n");
  const changed = await checkRaw({ path: "keep.txt", unchanged: true }, contextValue);
  assert.equal(changed[0]?.status, "fail");
  assert.match(changed[0]?.reason ?? "", /changed/);
});

test("unchanged distinguishes created and deleted files", async (t) => {
  const dirs = await setup(t);
  const contextValue = await context(dirs.root, dirs.workspace, dirs.baseline);

  await writeFile(join(dirs.workspace, "created.txt"), "new\n");
  const created = await checkRaw({ path: "created.txt", unchanged: true }, contextValue);
  assert.equal(created[0]?.status, "fail");
  assert.match(created[0]?.reason ?? "", /created/);

  await rm(join(dirs.workspace, "created.txt"));
  const bothAbsent = await checkRaw({ path: "created.txt", unchanged: true }, contextValue);
  assert.equal(bothAbsent[0]?.status, "pass");

  await writeFile(join(dirs.baseline, "deleted.txt"), "old\n");
  const deleted = await checkRaw({ path: "deleted.txt", unchanged: true }, contextValue);
  assert.equal(deleted[0]?.status, "fail");
  assert.match(deleted[0]?.reason ?? "", /missing/);
});

test("file checker rejects invalid configuration", async () => {
  const parse = (params: ImplementationParams) =>
    parseImplementationParams(fileChecker.params, params, 'checker "file"');
  await assert.rejects(() => parse({ path: "a", matches: "(" }), ConfigError);
  // RE2 has no lookaround; the dialect is enforced at load time.
  await assert.rejects(() => parse({ path: "a", matches: "^(?!x)" }), ConfigError);
  await assert.rejects(() => parse({ path: "a" }), ConfigError);
  await assert.rejects(() => parse({ path: "/etc/passwd", exists: true }), ConfigError);
  await assert.rejects(() => parse({ path: "../outside", exists: true }), ConfigError);
  await assert.rejects(() => parse({ path: "a", exists: "yes" }), ConfigError);
  await assert.rejects(() => parse({ path: "a", includes: "x" }), ConfigError);
  await assert.rejects(() => parse({ path: "a", exists: true, includes: "x" }), ConfigError);
  await assert.rejects(() => parse({ path: "a", unchanged: false }), ConfigError);
  await assert.rejects(() => parse({ path: "a", unchanged: false, exists: true }), ConfigError);
  await assert.rejects(() => parse({ path: "a", matches: [] }), ConfigError);

  const scalar = await parse({ path: "a", matches: "x" });
  assert.deepEqual(scalar.patterns, ["x"]);
  const list = await parse({ path: "a", matches: ["x", "y"] });
  assert.deepEqual(list.patterns, ["x", "y"]);
});

test("file checker reports symlink escapes as check errors", async (t) => {
  const dirs = await setup(t);
  const outside = join(dirs.root, "outside.txt");
  await writeFile(outside, "secret\n");
  await symlink(outside, join(dirs.workspace, "escape.txt"));
  await symlink(join(dirs.root, "missing-target"), join(dirs.workspace, "broken.txt"));
  const contextValue = await context(dirs.root, dirs.workspace, dirs.baseline);

  const escaped = await checkRaw({ path: "escape.txt", exists: true, matches: "secret" }, contextValue);
  assert.deepEqual(
    escaped.map((result) => result.status),
    ["error", "error"],
  );
  assert.match(escaped[0]?.reason ?? "", /outside the run workspace/);

  const broken = await checkRaw({ path: "broken.txt", exists: true }, contextValue);
  assert.equal(broken[0]?.status, "error");
  assert.match(broken[0]?.reason ?? "", /broken symlink/);
});

test("file checker allows symlinks that stay inside the workspace", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "real.txt"), "inside\n");
  await symlink("real.txt", join(dirs.workspace, "link.txt"));

  const results = await checkRaw(
    { path: "link.txt", exists: true, matches: "inside" },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["pass", "pass"],
  );
});

test("file checker refuses to read files over the bounded size", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61));

  const results = await checkRaw(
    { path: "large.txt", matches: "a" },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  assert.equal(results[0]?.status, "error");
  assert.match(results[0]?.reason ?? "", /check limit/);
});
