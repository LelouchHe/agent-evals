import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ConfigError, type ImplementationParams } from "../../engine/config.ts";
import { stageFiles } from "../../engine/files.ts";
import { parseImplementationParams } from "../../engine/params.ts";
import type { CheckerContext, CheckResult, CheckSandbox, CheckSandboxOutcome } from "../../engine/registry.ts";
import { openRunRoot } from "../../engine/workspace.ts";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { implementationContext } from "../../../tests/helpers/implementation-context.ts";
import { shellChecker } from "./checker.ts";

function sandbox(outcome: CheckSandboxOutcome): CheckSandbox {
  return { run: () => Promise.resolve(outcome) };
}

async function makeWorkspace(
  t: TestContext,
  checkSandbox: CheckSandbox,
  signal: AbortSignal = AbortSignal.timeout(5_000),
) {
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
      signal,
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

  await mkdir(join(authoring, "overlap"));
  await writeFile(join(authoring, "overlap/inner.txt"), "inner\n");
  await writeFile(join(authoring, "other.txt"), "other\n");
  const overlap = await parseImplementationParams(
    shellChecker.params,
    { run: ["true"], files: { tests: "overlap", "tests/inner.txt": "other.txt" } },
    'checker "shell"',
  );
  await assert.rejects(
    async () => shellChecker.create(overlap, implementationContext(authoring)),
    (error: unknown) => error instanceof ConfigError && /overwrites tests\/inner\.txt/.test(error.message),
  );
});

test("a symlink to a FIFO inside an authored directory is rejected without blocking", async (t) => {
  const authoring = await makeTempDir(t, "ae-shell-files-authoring-");
  const fifo = join(authoring, "pipe");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  await mkdir(join(authoring, "tree"));
  await writeFile(join(authoring, "tree/real.txt"), "real\n");
  await symlink("../pipe", join(authoring, "tree/fifo-link"));

  const params = await parseImplementationParams(
    shellChecker.params,
    { run: ["true"], files: { tests: "tree" } },
    'checker "shell"',
  );
  const startedAt = Date.now();
  await assert.rejects(
    async () => shellChecker.create(params, implementationContext(authoring)),
    (error: unknown) => error instanceof ConfigError && /must be a regular file or directory/.test(error.message),
  );
  assert.ok(Date.now() - startedAt < 2_000, "validation must not block on a FIFO");
});

test("a symlink to a directory inside an authored directory is rejected", async (t) => {
  const authoring = await makeTempDir(t, "ae-shell-files-authoring-");
  await mkdir(join(authoring, "dir"));
  await writeFile(join(authoring, "dir/secret.txt"), "secret\n");
  await mkdir(join(authoring, "tree"));
  await symlink("../dir", join(authoring, "tree/dir-link"));

  const params = await parseImplementationParams(
    shellChecker.params,
    { run: ["true"], files: { tests: "tree" } },
    'checker "shell"',
  );
  await assert.rejects(
    async () => shellChecker.create(params, implementationContext(authoring)),
    (error: unknown) => error instanceof ConfigError && /must be a regular file or directory/.test(error.message),
  );
});

test("check-time files are handed to the check sandbox, not placed by the checker", async (t) => {
  const authoring = await makeTempDir(t, "ae-shell-files-authoring-");
  await mkdir(join(authoring, "checks"));
  await writeFile(join(authoring, "checks/acceptance.test.js"), "acceptance body\n");
  let handed: Readonly<Record<string, string>> | undefined;
  const dirs = await makeWorkspace(t, {
    run: async (_command, options) => {
      handed = options?.files;
      return { kind: "exited", exitCode: 0, output: "" };
    },
  });

  const files = { "tests/acceptance.test.js": "checks/acceptance.test.js" };
  const [result] = await runFiles(authoring, { run: ["node", "tests/acceptance.test.js"], files }, dirs.context);
  assert.equal(result?.status, "pass", result?.reason);
  assert.deepEqual(handed, files);
  // Staging and placement belong to the engine's check sandbox, whose tests cover them.
  await assert.rejects(readFile(join(dirs.workspaceDir, "tests/acceptance.test.js")));
  assert.deepEqual(
    (await readdir(dirs.root)).filter((name) => name.startsWith("check-files-")),
    [],
  );
});

test("check-time files pass directory trees and parent-relative sources to the sandbox", async (t) => {
  const parent = await makeTempDir(t, "ae-shell-files-parent-");
  const authoring = join(parent, "case");
  await mkdir(join(authoring, "checks"), { recursive: true });
  await writeFile(join(authoring, "checks/acceptance.test.js"), "real body\n");
  await mkdir(join(parent, "shared"));
  await writeFile(join(parent, "shared/support.txt"), "support\n");

  let handed: Readonly<Record<string, string>> | undefined;
  const dirs = await makeWorkspace(t, {
    run: async (_command, options) => {
      handed = options?.files;
      return { kind: "exited", exitCode: 0, output: "" };
    },
  });

  const files = {
    tests: "checks",
    "existing/support.txt": "../shared/support.txt",
  };
  const [result] = await runFiles(authoring, { run: ["true"], files }, dirs.context);
  assert.equal(result?.status, "pass", result?.reason);
  assert.deepEqual(handed, files);
});

test("staging check-time files stops on an aborted signal and leaves nothing behind", async (t) => {
  const authoring = await makeTempDir(t, "ae-shell-files-authoring-");
  await mkdir(join(authoring, "checks"));
  await writeFile(join(authoring, "checks/acceptance.test.js"), "body\n");
  const staging = await makeTempDir(t, "ae-shell-files-staging-");

  await assert.rejects(
    () =>
      stageFiles(
        { "tests/acceptance.test.js": "checks/acceptance.test.js" },
        authoring,
        staging,
        "files",
        AbortSignal.abort(),
      ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.deepEqual(await readdir(staging), []);

  // Abort while an empty directory's first async lstat is pending so directory branches cannot slip past.
  await mkdir(join(authoring, "empty-only"));
  const midController = new AbortController();
  const stagedMid = await makeTempDir(t, "ae-shell-files-mid-");
  const promise = stageFiles({ empty: "empty-only" }, authoring, stagedMid, "files", midController.signal);
  queueMicrotask(() => midController.abort());
  await assert.rejects(
    () => promise,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  await assert.rejects(readdir(join(stagedMid, "empty")));
});

test("an aborted check never reaches the sandbox", async (t) => {
  const authoring = await makeTempDir(t, "ae-shell-files-authoring-");
  await mkdir(join(authoring, "checks"));
  await writeFile(join(authoring, "checks/acceptance.test.js"), "body\n");
  let called = false;
  const dirs = await makeWorkspace(
    t,
    {
      run: async () => {
        called = true;
        return { kind: "exited", exitCode: 0, output: "" };
      },
    },
    AbortSignal.abort(),
  );

  await assert.rejects(
    () =>
      runFiles(
        authoring,
        { run: ["true"], files: { "tests/acceptance.test.js": "checks/acceptance.test.js" } },
        dirs.context,
      ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(called, false, "the sandbox is never reached");
  assert.deepEqual(
    (await readdir(dirs.root)).filter((name) => name.startsWith("check-files-")),
    [],
  );
});
