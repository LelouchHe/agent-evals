import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError } from "../../engine/config.ts";
import type { CheckerContext } from "../../engine/registry.ts";
import { createFakePi, makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { judgeChecker, JudgeError } from "./checker.ts";
import { openRunRoot } from "../../engine/workspace.ts";

async function setup(t: Parameters<typeof makeTempDir>[0], fileContent: string | null = "Hello, world!\n") {
  const root = await makeTempDir(t, "ae-judge-");
  const workspace = join(root, "workspace");
  const baseline = join(root, "baseline");
  await mkdir(workspace);
  await mkdir(baseline);
  if (fileContent !== null) {
    await writeFile(join(workspace, "hello.txt"), fileContent);
  }
  return { root, workspace, baseline };
}

async function context(root: string, workspace: string, baseline: string): Promise<CheckerContext> {
  return {
    workspace: await openRunRoot(workspace),
    baseline: await openRunRoot(baseline),
    runRootDir: root,
    authoringDir: root,
    input: "Create hello.txt with exactly the content Hello, world!",
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(10_000),
  };
}

function params(executable: string, rubric: string[] = ["hello.txt exists and contains Hello, world!."]) {
  return {
    model: "test/judge-model",
    thinking: "low",
    file: "hello.txt",
    rubric,
    executable,
  };
}

test("judge passes when every rubric statement passes", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "judge-valid");

  const results = await judgeChecker.create().check(params(fake.executable), await context(dirs.root, dirs.workspace, dirs.baseline));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, "pass");
  assert.equal(results[0]?.checker, "judge");
  assert.equal(results[0]?.subject, "hello.txt exists and contains Hello, world!.");
});

test("judge preserves a valid failing verdict as a failed check", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "judge-fail");

  const results = await judgeChecker.create().check(params(fake.executable), await context(dirs.root, dirs.workspace, dirs.baseline));
  assert.equal(results[0]?.status, "fail");
  assert.match(results[0]?.reason ?? "", /differs/);
});

test("judge accepts a fenced JSON verdict", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "judge-fenced");

  const results = await judgeChecker.create().check(params(fake.executable), await context(dirs.root, dirs.workspace, dirs.baseline));
  assert.equal(results[0]?.status, "pass");
});

test("judge reports malformed verdicts as checker failures, not failed checks", async (t) => {
  const dirs = await setup(t);

  for (const scenario of ["judge-invalid", "judge-count", "judge-type"]) {
    const fake = await createFakePi(t, scenario);
    await assert.rejects(
      async () => judgeChecker.create().check(params(fake.executable), await context(dirs.root, dirs.workspace, dirs.baseline)),
      JudgeError,
      scenario,
    );
  }
});

test("judge invocation failure is a checker failure", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "crash");

  await assert.rejects(
    async () => judgeChecker.create().check(params(fake.executable), await context(dirs.root, dirs.workspace, dirs.baseline)),
    JudgeError,
  );
});

test("judge prompt contains the task, file evidence, and rubric", async (t) => {
  const dirs = await setup(t, "Hello, world!\n");
  const fake = await createFakePi(t, "judge-echo");

  const results = await judgeChecker.create().check(params(fake.executable), await context(dirs.root, dirs.workspace, dirs.baseline));
  const reason = results[0]?.reason ?? "";
  assert.match(reason, /Create hello\.txt/);
  assert.match(reason, /Hello, world!/);
  assert.match(reason, /Rubric statements/);
  assert.match(reason, /hello\.txt exists and contains/);
});

test("judge invocation disables tools and discovered resources", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "judge-args");

  const results = await judgeChecker.create().check(params(fake.executable), await context(dirs.root, dirs.workspace, dirs.baseline));
  const args = results[0]?.reason ?? "";
  assert.match(args, /--no-tools/);
  assert.doesNotMatch(args, /\s--tools\s/);
  assert.match(args, /--no-session/);
  assert.match(args, /--no-skills/);
  assert.match(args, /--no-extensions/);
  assert.match(args, /--no-mcp/);
  assert.match(args, /--no-context-files/);
  assert.match(args, /--model test\/judge-model/);
  assert.match(args, /--thinking low/);
});

test("judge receives an explicit missing-file signal", async (t) => {
  const dirs = await setup(t, null);
  const fake = await createFakePi(t, "judge-echo");

  const results = await judgeChecker.create().check(params(fake.executable), await context(dirs.root, dirs.workspace, dirs.baseline));
  assert.match(results[0]?.reason ?? "", /the file does not exist/);
});

test("judge validates its parameters before launch", async (t) => {
  await setup(t);
  const fake = await createFakePi(t, "judge-valid");
  const validate = async (value: Record<string, unknown>) => judgeChecker.validate(value, process.cwd());

  await assert.rejects(() => validate({ model: "", file: "hello.txt", rubric: ["x"], executable: fake.executable }), ConfigError);
  await assert.rejects(() => validate({ model: "m", file: "hello.txt", rubric: [], executable: fake.executable }), ConfigError);
  await assert.rejects(() => validate({ model: "m", file: "/etc/passwd", rubric: ["x"], executable: fake.executable }), ConfigError);
  await assert.rejects(() => validate({ model: "m", file: "hello.txt", rubric: ["x"], executable: fake.executable, extra: 1 }), ConfigError);
});
