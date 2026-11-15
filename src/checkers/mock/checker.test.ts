import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ConfigError, type ImplementationParams } from "../../engine/config.ts";
import { parseImplementationParams } from "../../engine/params.ts";
import type { CheckerContext, MockRecord } from "../../engine/registry.ts";
import { openRunRoot } from "../../engine/workspace.ts";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { unusedCheckSandbox } from "../../../tests/helpers/implementation-context.ts";
import { mockChecker } from "./checker.ts";

function implementationContext(mockTargets?: readonly string[]) {
  return {
    authoringDir: process.cwd(),
    values: {
      env: { require: (name: string) => Promise.reject(new Error(`no environment value ${name}`)) },
      run: { HOME: "/run/home", TMPDIR: "/run/tmp" },
    },
    ...(mockTargets === undefined ? {} : { mockTargets }),
  };
}

async function context(t: TestContext, records?: readonly MockRecord[]): Promise<CheckerContext> {
  const root = await makeTempDir(t, "ae-mock-check-");
  const workspace = join(root, "workspace");
  const baseline = join(root, "baseline");
  await mkdir(workspace);
  await mkdir(baseline);
  return {
    workspace: await openRunRoot(workspace),
    baseline: await openRunRoot(baseline),
    runRootDir: root,
    input: "task",
    ...(records === undefined ? {} : { mockRecords: records }),
    checkSandbox: unusedCheckSandbox,
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(5_000),
  };
}

async function run(
  t: TestContext,
  raw: ImplementationParams,
  targets: readonly string[] | undefined,
  records?: readonly MockRecord[],
) {
  const params = await parseImplementationParams(mockChecker.params, raw, 'checker "mock"');
  const checker = await mockChecker.create(params, implementationContext(targets));
  return checker.check(await context(t, records));
}

async function statuses(
  t: TestContext,
  raw: ImplementationParams,
  targets: readonly string[] | undefined,
  records?: readonly MockRecord[],
) {
  return (await run(t, raw, targets, records)).map((result) => result.status);
}

function record(target: string, ...arguments_: string[]): MockRecord {
  return { target, arguments: arguments_ };
}

test("the mock checker rejects unknown, malformed and regex-shaped parameters", async () => {
  const parse = (raw: ImplementationParams) => parseImplementationParams(mockChecker.params, raw, 'checker "mock"');
  await assert.rejects(parse({ shell: [] }), ConfigError);
  await assert.rejects(parse({ shell: ["git"], count: 1 }), ConfigError);
  await assert.rejects(parse({ shell: ["git"], times: -1 }), ConfigError);
  await assert.rejects(parse({ shell: ["git"], times: 1.5 }), ConfigError);
  // Position 0 names one target, so it cannot be a pattern.
  await assert.rejects(parse({ shell: ["/git|svn/"] }), ConfigError);
  // It must also have a declared target's shape, not something identity would normalise away.
  for (const target of ["/scripts/x", "scripts/x/", "../scripts/x", "./scripts/../x"]) {
    await assert.rejects(parse({ shell: [target] }), ConfigError, target);
  }
  // The rest keeps the mock rule's argument grammar.
  await assert.rejects(parse({ shell: ["git", "push", { "-f": true }, "later"] }), ConfigError);
});

test("the mock checker refuses an undeclared target or a case without mocks at load time", async () => {
  await assert.rejects(
    async () =>
      mockChecker.create(await mockChecker.params.parseAsync({ shell: ["git"] }), implementationContext(["make"])),
    (error: unknown) =>
      error instanceof ConfigError &&
      /"git" is not a declared mocks\.shell target \(declared: make\)/.test(error.message),
  );
  await assert.rejects(
    async () => mockChecker.create(await mockChecker.params.parseAsync({ shell: ["git"] }), implementationContext()),
    (error: unknown) => error instanceof ConfigError && /needs a case that declares mocks/.test(error.message),
  );
});

test("a check names a workspace target by either spelling, but never blends a PATH command with a script", async (t) => {
  for (const declared of ["./scripts/x", "scripts/x"] as const) {
    const records = [record(declared, "alpha")];
    assert.deepEqual(await statuses(t, { shell: ["scripts/x", "alpha"] }, [declared], records), ["pass"]);
    assert.deepEqual(await statuses(t, { shell: ["./scripts/x", "alpha"] }, [declared], records), ["pass"]);
  }
  // A bare name is a PATH command; a leading `./` is a workspace script.
  await assert.rejects(
    async () =>
      mockChecker.create(await mockChecker.params.parseAsync({ shell: ["./x"] }), implementationContext(["x"])),
    ConfigError,
  );
  await assert.rejects(
    async () =>
      mockChecker.create(await mockChecker.params.parseAsync({ shell: ["x"] }), implementationContext(["./x"])),
    ConfigError,
  );
});

test("the default count is at least one matching call, and times is exact", async (t) => {
  assert.deepEqual(await statuses(t, { shell: ["git"] }, ["git"], []), ["fail"]);
  assert.deepEqual(await statuses(t, { shell: ["git"] }, ["git"], [record("git", "status")]), ["pass"]);
  assert.deepEqual(await statuses(t, { shell: ["git"] }, ["git"], [record("git"), record("git")]), ["pass"]);

  assert.deepEqual(await statuses(t, { shell: ["git"], times: 0 }, ["git"], []), ["pass"]);
  assert.deepEqual(await statuses(t, { shell: ["git"], times: 0 }, ["git"], [record("git", "push")]), ["fail"]);

  assert.deepEqual(await statuses(t, { shell: ["git"], times: 2 }, ["git"], [record("git")]), ["fail"]);
  assert.deepEqual(await statuses(t, { shell: ["git"], times: 2 }, ["git"], [record("git"), record("git")]), ["pass"]);
});

test("the argument grammar matches a positional prefix, an option map and RE2 tokens", async (t) => {
  const check = { shell: ["git", "push", { "/-f|--force/": true }] };
  assert.deepEqual(await statuses(t, check, ["git"], [record("git", "push", "--force")]), ["pass"]);
  assert.deepEqual(await statuses(t, check, ["git"], [record("git", "push", "-f")]), ["pass"]);
  // Whole-token matching: a longer option is a different token.
  assert.deepEqual(await statuses(t, check, ["git"], [record("git", "push", "--force-with-lease")]), ["fail"]);
  // The positional prefix is required in order.
  assert.deepEqual(await statuses(t, check, ["git"], [record("git", "--force", "push")]), ["fail"]);
  // A value option accepts both spellings.
  assert.deepEqual(
    await statuses(t, { shell: ["gh", { "--repo": "foo/bar" }] }, ["gh"], [record("gh", "pr", "--repo=foo/bar")]),
    ["pass"],
  );
});

test("records of other targets and other arguments do not count", async (t) => {
  const records = [record("git", "pull"), record("make", "deploy")];
  assert.deepEqual(await statuses(t, { shell: ["git", "push"] }, ["git", "make"], records), ["fail"]);
  // The failure names the count and the matching calls' arguments.
  const [result] = await run(t, { shell: ["git", "push"], times: 2 }, ["git"], [record("git", "push", "-f")]);
  assert.equal(result?.status, "fail");
  assert.match(result?.reason ?? "", /expected exactly 2 calls, found 1 call: \["push","-f"\]/);
  assert.equal(result?.subject, "git push");
});
