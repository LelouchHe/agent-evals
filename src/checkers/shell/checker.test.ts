import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileChecker } from "../file/checker.ts";
import { ConfigError, type ImplementationParams } from "../../engine/config.ts";
import { parseImplementationParams } from "../../engine/params.ts";
import type { CheckerContext, CheckResult, CheckSandbox, CheckSandboxOutcome } from "../../engine/registry.ts";
import { openRunRoot } from "../../engine/workspace.ts";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { implementationContext } from "../../../tests/helpers/implementation-context.ts";
import { shellChecker } from "./checker.ts";

function sandbox(outcome: CheckSandboxOutcome): CheckSandbox {
  return { run: () => Promise.resolve(outcome) };
}

async function makeWorkspace(t: TestContext, checkSandbox: CheckSandbox) {
  const root = await makeTempDir(t, "ae-shell-check-");
  const workspaceDir = join(root, "workspace");
  const baselineDir = join(root, "baseline");
  await mkdir(workspaceDir);
  await mkdir(baselineDir);
  return {
    root,
    workspaceDir,
    context: {
      workspace: await openRunRoot(workspaceDir),
      baseline: await openRunRoot(baselineDir),
      runRootDir: root,
      input: "task",
      checkSandbox,
      timeoutMs: 5_000,
      signal: AbortSignal.timeout(5_000),
    } satisfies CheckerContext,
  };
}

async function context(t: TestContext, checkSandbox: CheckSandbox): Promise<CheckerContext> {
  return (await makeWorkspace(t, checkSandbox)).context;
}

async function runFiles(
  authoringDir: string,
  raw: ImplementationParams,
  contextValue: CheckerContext,
): Promise<readonly CheckResult[]> {
  const params = await parseImplementationParams(shellChecker.params, raw, 'checker "shell"');
  return (await shellChecker.create(params, implementationContext(authoringDir))).check(contextValue);
}

async function check(t: TestContext, raw: ImplementationParams, checkSandbox: CheckSandbox) {
  const params = await parseImplementationParams(shellChecker.params, raw, 'checker "shell"');
  return (await shellChecker.create(params, implementationContext(process.cwd()))).check(
    await context(t, checkSandbox),
  );
}

test("the shell checker takes a non-empty program list and rejects other shapes", async () => {
  const parse = (raw: ImplementationParams) => parseImplementationParams(shellChecker.params, raw, 'checker "shell"');
  await assert.rejects(parse({ run: [] }), ConfigError);
  await assert.rejects(parse({ run: [""] }), ConfigError);
  await assert.rejects(parse({ run: ["npm", 1] }), ConfigError);
  await assert.rejects(parse({ run: ["npm", "test"], sandbox: true }), ConfigError);
});

test("exit status 0 passes and another status fails with the output tail", async (t) => {
  assert.deepEqual(await check(t, { run: ["npm", "test"] }, sandbox({ kind: "exited", exitCode: 0, output: "ok\n" })), [
    { checker: "shell", subject: "run npm test", status: "pass", reason: "exit status 0" },
  ]);
  const [failed] = await check(
    t,
    { run: ["npm", "test"] },
    sandbox({ kind: "exited", exitCode: 1, output: "one\ntwo assertions failed\n" }),
  );
  assert.equal(failed?.status, "fail");
  assert.equal(failed?.reason, "exit status 1: one\ntwo assertions failed");
});

test("a long output keeps its end, where the assertion failure is", async (t) => {
  const output = `${"noise\n".repeat(400)}final assertion failed\n`;
  const [failed] = await check(t, { run: ["npm", "test"] }, sandbox({ kind: "exited", exitCode: 1, output }));
  assert.equal(failed?.status, "fail");
  assert.ok((failed?.reason ?? "").endsWith("final assertion failed"), failed?.reason);
  assert.match(failed?.reason ?? "", /^exit status 1: …/);
  assert.ok((failed?.reason.length ?? 0) <= 800, `reason is ${failed?.reason.length} chars`);
});

test("a signal or an unstartable program is an error, not a failed judgment", async (t) => {
  assert.deepEqual(
    await check(t, { run: ["sleep", "60"] }, sandbox({ kind: "signalled", signal: "SIGKILL", output: "" })),
    [{ checker: "shell", subject: "run sleep 60", status: "error", reason: "program died from SIGKILL" }],
  );
  assert.deepEqual(
    await check(
      t,
      { run: ["missing"] },
      sandbox({ kind: "failed", reason: "could not start missing: no executable", output: "" }),
    ),
    [
      {
        checker: "shell",
        subject: "run missing",
        status: "error",
        reason: "could not start missing: no executable",
      },
    ],
  );
});

test("check-time files reject unsafe destinations, sources and overlap at load", async (t) => {
  const authoring = await makeTempDir(t, "ae-shell-files-authoring-");
  await writeFile(join(authoring, "source.txt"), "source\n");

  const parse = (files: Record<string, string>) =>
    parseImplementationParams(shellChecker.params, { run: ["true"], files }, 'checker "shell"');
  for (const destination of ["../escape", "/absolute", "", ".", "./", "C:\\temp\\x", "\\rooted"]) {
    await assert.rejects(parse({ [destination]: "source.txt" }), ConfigError, destination);
  }
  for (const source of ["/absolute.txt", "", "nul\0byte"]) {
    await assert.rejects(parse({ "tests/file.txt": source }), ConfigError, source);
  }
  await assert.rejects(
    parseImplementationParams(shellChecker.params, { run: ["true"], files: {}, other: 1 }, 'checker "shell"'),
    ConfigError,
  );

  // A source is an authoring-relative path, so a parent-relative asset is valid.
  await mkdir(join(authoring, "nested"));
  await writeFile(join(authoring, "nested/source.txt"), "shared\n");
  await parseImplementationParams(
    shellChecker.params,
    { run: ["true"], files: { "tests/file.txt": "../source.txt" } },
    'checker "shell"',
  ).then((params) => shellChecker.create(params, implementationContext(join(authoring, "nested"))));

  const missing = await parseImplementationParams(
    shellChecker.params,
    { run: ["true"], files: { "tests/file.txt": "missing.txt" } },
    'checker "shell"',
  );
  await assert.rejects(
    async () => shellChecker.create(missing, implementationContext(authoring)),
    (error: unknown) => error instanceof ConfigError && /is not accessible/.test(error.message),
  );

  // A FIFO is not a regular file, and staging must not block on it.
  const fifo = join(authoring, "pipe");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  const special = await parseImplementationParams(
    shellChecker.params,
    { run: ["true"], files: { "tests/pipe": "pipe" } },
    'checker "shell"',
  );
  await assert.rejects(
    async () => shellChecker.create(special, implementationContext(authoring)),
    (error: unknown) => error instanceof ConfigError && /must be a regular file or directory/.test(error.message),
  );

  await mkdir(join(authoring, "tree"));
  await writeFile(join(authoring, "tree/inner.txt"), "inner\n");
  await writeFile(join(authoring, "other.txt"), "other\n");
  const overlap = await parseImplementationParams(
    shellChecker.params,
    { run: ["true"], files: { tests: "tree", "tests/inner.txt": "other.txt" } },
    'checker "shell"',
  );
  await assert.rejects(
    async () => shellChecker.create(overlap, implementationContext(authoring)),
    (error: unknown) => error instanceof ConfigError && /overwrites tests\/inner\.txt/.test(error.message),
  );
});

test("check-time files appear only when the check runs and a later check sees them", async (t) => {
  const authoring = await makeTempDir(t, "ae-shell-files-authoring-");
  await mkdir(join(authoring, "checks"));
  await writeFile(join(authoring, "checks/acceptance.test.js"), "acceptance body\n");
  const dirs = await makeWorkspace(t, sandbox({ kind: "exited", exitCode: 0, output: "" }));

  await assert.rejects(readFile(join(dirs.workspaceDir, "tests/acceptance.test.js")));
  const [result] = await runFiles(
    authoring,
    { run: ["node", "tests/acceptance.test.js"], files: { "tests/acceptance.test.js": "checks/acceptance.test.js" } },
    dirs.context,
  );
  assert.equal(result?.status, "pass", result?.reason);
  assert.equal(await readFile(join(dirs.workspaceDir, "tests/acceptance.test.js"), "utf8"), "acceptance body\n");

  const fileParams = await parseImplementationParams(
    fileChecker.params,
    { path: "tests/acceptance.test.js", matches: "^acceptance body\\n?$" },
    'checker "file"',
  );
  const [seen] = await (await fileChecker.create(fileParams, implementationContext(authoring))).check(dirs.context);
  assert.equal(seen?.status, "pass");
});

test("check-time files replace the agent's file and copy directory trees", async (t) => {
  const parent = await makeTempDir(t, "ae-shell-files-parent-");
  const authoring = join(parent, "case");
  await mkdir(join(authoring, "checks"), { recursive: true });
  await writeFile(join(authoring, "checks/acceptance.test.js"), "real body\n");
  await mkdir(join(parent, "shared"));
  await writeFile(join(parent, "shared/support.txt"), "support\n");

  const dirs = await makeWorkspace(t, sandbox({ kind: "exited", exitCode: 0, output: "" }));
  await mkdir(join(dirs.workspaceDir, "tests"));
  await writeFile(join(dirs.workspaceDir, "tests/acceptance.test.js"), "agent's fake\n");
  await mkdir(join(dirs.workspaceDir, "existing"));
  await writeFile(join(dirs.workspaceDir, "existing/keep.txt"), "keep\n");

  const [result] = await runFiles(
    authoring,
    {
      run: ["true"],
      files: {
        tests: "checks",
        "existing/support.txt": "../shared/support.txt",
      },
    },
    dirs.context,
  );
  assert.equal(result?.status, "pass", result?.reason);
  assert.equal(await readFile(join(dirs.workspaceDir, "tests/acceptance.test.js"), "utf8"), "real body\n");
  assert.equal(await readFile(join(dirs.workspaceDir, "existing/keep.txt"), "utf8"), "keep\n");
  assert.equal(await readFile(join(dirs.workspaceDir, "existing/support.txt"), "utf8"), "support\n");
});

test("a leaf symlink is replaced instead of written through", async (t) => {
  const authoring = await makeTempDir(t, "ae-shell-files-authoring-");
  await mkdir(join(authoring, "checks"));
  await writeFile(join(authoring, "checks/acceptance.test.js"), "real body\n");
  const outside = await makeTempDir(t, "ae-shell-files-outside-");
  const outsideFile = join(outside, "authorized_keys");
  await writeFile(outsideFile, "do not touch\n");

  const dirs = await makeWorkspace(t, sandbox({ kind: "exited", exitCode: 0, output: "" }));
  await mkdir(join(dirs.workspaceDir, "tests"));
  await symlink(outsideFile, join(dirs.workspaceDir, "tests/acceptance.test.js"));
  await symlink(join(outside, "missing.txt"), join(dirs.workspaceDir, "tests/broken.test.js"));

  const [result] = await runFiles(
    authoring,
    {
      run: ["true"],
      files: {
        "tests/acceptance.test.js": "checks/acceptance.test.js",
        "tests/broken.test.js": "checks/acceptance.test.js",
      },
    },
    dirs.context,
  );
  assert.equal(result?.status, "pass", result?.reason);
  assert.equal(await readFile(outsideFile, "utf8"), "do not touch\n");
  await assert.rejects(readFile(join(outside, "missing.txt")));
  assert.equal(await readFile(join(dirs.workspaceDir, "tests/acceptance.test.js"), "utf8"), "real body\n");
  assert.equal((await lstat(join(dirs.workspaceDir, "tests/acceptance.test.js"))).isSymbolicLink(), false);
  assert.equal((await lstat(join(dirs.workspaceDir, "tests/broken.test.js"))).isSymbolicLink(), false);
});

test("check-time files refuse to follow an ancestor symlink", async (t) => {
  const authoring = await makeTempDir(t, "ae-shell-files-authoring-");
  await mkdir(join(authoring, "checks"));
  await writeFile(join(authoring, "checks/acceptance.test.js"), "real body\n");

  for (const inside of [false, true]) {
    const dirs = await makeWorkspace(t, sandbox({ kind: "exited", exitCode: 0, output: "" }));
    const outside = await makeTempDir(t, "ae-shell-files-outside-");
    const target = inside ? join(dirs.workspaceDir, "real") : outside;
    if (inside) await mkdir(target);
    await symlink(target, join(dirs.workspaceDir, "tests"));

    const [result] = await runFiles(
      authoring,
      { run: ["true"], files: { "tests/acceptance.test.js": "checks/acceptance.test.js" } },
      dirs.context,
    );
    assert.equal(result?.status, "error");
    assert.match(result?.reason ?? "", /symlink/);
    assert.equal((await lstat(join(dirs.workspaceDir, "tests"))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(target), []);
  }
});

test("a directory where a check-time file goes is an error, not a replacement", async (t) => {
  const authoring = await makeTempDir(t, "ae-shell-files-authoring-");
  await mkdir(join(authoring, "checks"));
  await writeFile(join(authoring, "checks/acceptance.test.js"), "real body\n");
  const dirs = await makeWorkspace(t, sandbox({ kind: "exited", exitCode: 0, output: "" }));
  await mkdir(join(dirs.workspaceDir, "tests/acceptance.test.js"), { recursive: true });

  const [result] = await runFiles(
    authoring,
    { run: ["true"], files: { "tests/acceptance.test.js": "checks/acceptance.test.js" } },
    dirs.context,
  );
  assert.equal(result?.status, "error");
  assert.match(result?.reason ?? "", /where a directory exists/);
  assert.equal((await lstat(join(dirs.workspaceDir, "tests/acceptance.test.js"))).isDirectory(), true);
});
