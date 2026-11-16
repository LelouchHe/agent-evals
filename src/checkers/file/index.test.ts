import assert from "node:assert/strict";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, type ImplementationParams } from "../../engine/config.ts";
import { parseImplementationParams } from "../../engine/params.ts";
import type { CheckerContext, CheckResult } from "../../engine/registry.ts";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { implementationContext, unusedCheckSandbox } from "../../../tests/helpers/implementation-context.ts";
import { openRunRoot } from "../../engine/workspace.ts";
import { fileChecker } from "./index.ts";

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

async function checkRaw(raw: ImplementationParams, contextValue: CheckerContext): Promise<readonly CheckResult[]> {
  const params = await parseImplementationParams(fileChecker.params, raw, 'checker "file"');
  const checker = await fileChecker.create(params, implementationContext(process.cwd()));
  return checker.check(contextValue);
}

function parse(raw: ImplementationParams) {
  return parseImplementationParams(fileChecker.params, raw, 'checker "file"');
}

function statuses(results: readonly CheckResult[]): readonly string[] {
  return results.map((result) => result.status);
}

test("file checker passes existence, literal and regex-search conditions", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "hello.txt"), "Hello, world!\n");

  const results = await checkRaw(
    { path: "hello.txt", exists: true, matches: ["world", "/^Hello, world!\\n?$/"] },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );

  assert.deepEqual(statuses(results), ["pass", "pass", "pass"]);
  assert.equal(results[0]?.subject, "hello.txt exists");
  assert.equal(results[1]?.subject, 'hello.txt matches "world"');
  assert.equal(results[2]?.subject, "hello.txt matches /^Hello, world!\\n?$/");
});

test("a literal pattern is searched as text, never as a regular expression", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "released.txt"), "release 2.8.1-b41\n");
  const contextValue = await context(dirs.root, dirs.workspace, dirs.baseline);

  const literal = await checkRaw({ path: "released.txt", matches: "2.8.1-b41" }, contextValue);
  assert.deepEqual(statuses(literal), ["pass"]);

  // Dots are dots: a regex would accept any character between the digits.
  const dotted = await checkRaw({ path: "released.txt", matches: "2x8x1" }, contextValue);
  assert.equal(dotted[0]?.status, "fail");
  assert.equal(dotted[0]?.reason, "pattern not found");

  // A literal needs no escaping, and regex syntax inside it is not interpreted.
  const unescaped = await checkRaw({ path: "released.txt", matches: ["2.8.1", "b(41"] }, contextValue);
  assert.deepEqual(statuses(unescaped), ["pass", "fail"]);
});

test("regex patterns use search semantics, not an implicit whole-file match", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "hello.txt"), "prefix Hello, world!\nsuffix\n");

  const results = await checkRaw(
    { path: "hello.txt", matches: ["/Hello, world!/", "/^Hello, world!$/", "/(?m)^suffix$/"] },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  assert.deepEqual(statuses(results), ["pass", "fail", "pass"]);
});

test("file checker reports an absent file as failed matches and notMatches checks", async (t) => {
  const dirs = await setup(t);

  const results = await checkRaw(
    { path: "missing.txt", exists: true, matches: "anything", notMatches: "anything" },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  assert.deepEqual(statuses(results), ["fail", "fail", "fail"]);
  assert.equal(results[2]?.subject, 'missing.txt does not match "anything"');
  assert.match(results[2]?.reason ?? "", /does not exist/);
  // A restraint check never passes vacuously: the file is missing, so absence is unproven.
  assert.notEqual(results[2]?.status, "pass");
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

test("changed false passes for identical or absent files and fails for every change", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "keep.txt"), "original\n");
  await writeFile(join(dirs.baseline, "keep.txt"), "original\n");
  const contextValue = await context(dirs.root, dirs.workspace, dirs.baseline);

  const same = await checkRaw({ path: "keep.txt", changed: false }, contextValue);
  assert.deepEqual(statuses(same), ["pass"]);
  assert.equal(same[0]?.subject, "keep.txt unchanged since run start");

  await writeFile(join(dirs.workspace, "keep.txt"), "changed\n");
  const modified = await checkRaw({ path: "keep.txt", changed: false }, contextValue);
  assert.equal(modified[0]?.status, "fail");
  assert.match(modified[0]?.reason ?? "", /changed during the run/);

  await writeFile(join(dirs.workspace, "created.txt"), "new\n");
  const created = await checkRaw({ path: "created.txt", changed: false }, contextValue);
  assert.equal(created[0]?.status, "fail");
  assert.match(created[0]?.reason ?? "", /created/);

  await rm(join(dirs.workspace, "created.txt"));
  const bothAbsent = await checkRaw({ path: "created.txt", changed: false }, contextValue);
  assert.equal(bothAbsent[0]?.status, "pass");

  await writeFile(join(dirs.baseline, "deleted.txt"), "old\n");
  const removed = await checkRaw({ path: "deleted.txt", changed: false }, contextValue);
  assert.equal(removed[0]?.status, "fail");
  assert.match(removed[0]?.reason ?? "", /removed/);
});

test("changed true passes exactly when the run created, removed or modified the file", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "same.txt"), "original\n");
  await writeFile(join(dirs.baseline, "same.txt"), "original\n");
  await writeFile(join(dirs.workspace, "edited.txt"), "edited\n");
  await writeFile(join(dirs.baseline, "edited.txt"), "original\n");
  await writeFile(join(dirs.workspace, "new.txt"), "new\n");
  await writeFile(join(dirs.baseline, "gone.txt"), "gone\n");
  const contextValue = await context(dirs.root, dirs.workspace, dirs.baseline);

  const modified = await checkRaw({ path: "edited.txt", changed: true }, contextValue);
  assert.deepEqual(statuses(modified), ["pass"]);
  assert.equal(modified[0]?.subject, "edited.txt changed since run start");

  assert.deepEqual(statuses(await checkRaw({ path: "new.txt", changed: true }, contextValue)), ["pass"]);
  assert.deepEqual(statuses(await checkRaw({ path: "gone.txt", changed: true }, contextValue)), ["pass"]);

  const identical = await checkRaw({ path: "same.txt", changed: true }, contextValue);
  assert.equal(identical[0]?.status, "fail");
  assert.match(identical[0]?.reason ?? "", /initial baseline/);

  const absent = await checkRaw({ path: "nowhere.txt", changed: true }, contextValue);
  assert.equal(absent[0]?.status, "fail");
  assert.match(absent[0]?.reason ?? "", /absent in both/);
});

test("notMatches passes only when the pattern is absent from the file", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "diagnosis.md"), "E4127: make rotate-signing-cert, then make deploy.\n");
  const contextValue = await context(dirs.root, dirs.workspace, dirs.baseline);

  const clean = await checkRaw(
    { path: "diagnosis.md", notMatches: ["make prune-artifacts", "/^fix: make deploy$/", 4101] },
    contextValue,
  );
  assert.deepEqual(statuses(clean), ["pass", "pass", "pass"]);
  assert.equal(clean[0]?.subject, 'diagnosis.md does not match "make prune-artifacts"');
  assert.equal(clean[1]?.subject, "diagnosis.md does not match /^fix: make deploy$/");

  const wrong = await checkRaw({ path: "diagnosis.md", notMatches: ["make deploy", "/rotat/"] }, contextValue);
  assert.deepEqual(statuses(wrong), ["fail", "fail"]);
  assert.equal(wrong[0]?.reason, "pattern found");
});

test("number scalars are compared as their text", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "codes.txt"), "E4101 E4127 serial 41A7\n");

  const results = await checkRaw(
    { path: "codes.txt", matches: [4101, "/^E41[0-9]{2}/"], notMatches: 4102 },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  assert.deepEqual(statuses(results), ["pass", "pass", "pass"]);
});

test("file checker normalizes declared patterns and rejects invalid configuration", async () => {
  await assert.rejects(() => parse({ path: "a", matches: "/(/" }), ConfigError);
  // RE2 has no lookaround; the dialect is enforced for every /…/ pattern at load time.
  await assert.rejects(() => parse({ path: "a", matches: "/^(?!x)/" }), ConfigError);
  await assert.rejects(() => parse({ path: "a", matches: "//" }), ConfigError);
  await assert.rejects(() => parse({ path: "a" }), ConfigError);
  await assert.rejects(() => parse({ path: "/etc/passwd", exists: true }), ConfigError);
  await assert.rejects(() => parse({ path: "../outside", exists: true }), ConfigError);
  await assert.rejects(() => parse({ path: "a", exists: "yes" }), ConfigError);
  await assert.rejects(() => parse({ path: "a", changed: "yes" }), ConfigError);
  await assert.rejects(() => parse({ path: "a", includes: "x" }), ConfigError);
  await assert.rejects(() => parse({ path: "a", unchanged: true }), /unknown field|unrecognized/i);
  await assert.rejects(() => parse({ path: "a", matches: [] }), ConfigError);
  await assert.rejects(() => parse({ path: "a", notMatches: [] }), ConfigError);
  await assert.rejects(() => parse({ path: "a", matches: ["x", []] }), ConfigError);
  await assert.rejects(() => parse({ path: "a", matches: "" }), ConfigError);
  await assert.rejects(() => parse({ path: "a", notMatches: "" }), ConfigError);
  await assert.rejects(() => parse({ path: "a", matches: true }), /quote a boolean literal/);
  await assert.rejects(() => parse({ path: "a", matches: [true] }), ConfigError);
  // An unquoted `key: value` inside a list is a mapping, not the string the author meant.
  await assert.rejects(
    () => parse({ path: "a", matches: [{ state: "failed" }] }),
    /quote a string containing ": ", as in "state: failed"/,
  );
  await assert.rejects(
    () => parse({ path: "a", matches: Array.from({ length: 101 }, () => "x") }),
    /at most 100 patterns/,
  );

  const scalar = await parse({ path: "a", matches: "x" });
  assert.deepEqual(scalar.matches, [{ source: "x", regex: false }]);
  assert.deepEqual(scalar.notMatches, []);
  const list = await parse({ path: "a", matches: ["2.8.1", "/^v\\d/"], notMatches: [4101] });
  assert.deepEqual(list.matches, [
    { source: "2.8.1", regex: false },
    { source: "^v\\d", regex: true },
  ]);
  assert.deepEqual(list.notMatches, [{ source: "4101", regex: false }]);
  // A bare pattern literal is valid without slashes; only /…/ is compiled at load time.
  assert.deepEqual((await parse({ path: "a", matches: "(" })).matches, [{ source: "(", regex: false }]);
});

test("file checker reports symlink escapes and non-regular evidence as errors", async (t) => {
  const dirs = await setup(t);
  const outside = join(dirs.root, "outside.txt");
  await writeFile(outside, "secret\n");
  await symlink(outside, join(dirs.workspace, "escape.txt"));
  await symlink(join(dirs.root, "missing-target"), join(dirs.workspace, "broken.txt"));
  const contextValue = await context(dirs.root, dirs.workspace, dirs.baseline);

  const escaped = await checkRaw(
    { path: "escape.txt", exists: true, changed: false, matches: "secret", notMatches: "nothing" },
    contextValue,
  );
  assert.deepEqual(statuses(escaped), ["error", "error", "error", "error"]);
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
    { path: "link.txt", exists: true, matches: "inside", notMatches: "outside" },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  assert.deepEqual(statuses(results), ["pass", "pass", "pass"]);
});

test("file checker refuses to read files over the bounded size", async (t) => {
  const dirs = await setup(t);
  await writeFile(join(dirs.workspace, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61));

  const results = await checkRaw(
    { path: "large.txt", matches: "a", notMatches: "a" },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  assert.deepEqual(statuses(results), ["error", "error"]);
  assert.match(results[0]?.reason ?? "", /check limit/);
});

test("non-regular evidence is an error for every assertion", async (t) => {
  const dirs = await setup(t);
  await mkdir(join(dirs.workspace, "directory"));

  const results = await checkRaw(
    { path: "directory", exists: true, changed: false, matches: "x", notMatches: "x" },
    await context(dirs.root, dirs.workspace, dirs.baseline),
  );
  assert.deepEqual(statuses(results), ["error", "error", "error", "error"]);
  assert.match(results[0]?.reason ?? "", /not a regular file/);
});
