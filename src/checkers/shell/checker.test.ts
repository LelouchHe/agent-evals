import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ConfigError, type ImplementationParams } from "../../engine/config.ts";
import { parseImplementationParams } from "../../engine/params.ts";
import type { CheckerContext, CheckSandbox, CheckSandboxOutcome } from "../../engine/registry.ts";
import { openRunRoot } from "../../engine/workspace.ts";
import { makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { implementationContext } from "../../../tests/helpers/implementation-context.ts";
import { shellChecker } from "./checker.ts";

function sandbox(outcome: CheckSandboxOutcome): CheckSandbox {
  return { run: () => Promise.resolve(outcome) };
}

async function context(t: TestContext, checkSandbox: CheckSandbox): Promise<CheckerContext> {
  const root = await makeTempDir(t, "ae-shell-check-");
  const workspace = join(root, "workspace");
  const baseline = join(root, "baseline");
  await mkdir(workspace);
  await mkdir(baseline);
  return {
    workspace: await openRunRoot(workspace),
    baseline: await openRunRoot(baseline),
    runRootDir: root,
    input: "task",
    checkSandbox,
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(5_000),
  };
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
