import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { fileChecker } from "../src/checkers/file/index.ts";
import { judgeChecker } from "../src/checkers/judge/index.ts";
import { mockChecker } from "../src/checkers/mock/index.ts";
import { shellChecker } from "../src/checkers/shell/index.ts";
import { traceChecker } from "../src/checkers/trace/index.ts";
import { loadCase } from "../src/engine/authoring.ts";
import { addChecker, addRunner, createRegistry } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { noopRunner } from "../src/runners/noop/index.ts";
import { createFakePi, makeTempDir } from "./helpers/fake-pi-control.ts";

async function runNoop(
  t: TestContext,
  declaration: Record<string, unknown>,
  judgeExecutable?: string,
  fixtureFiles: Readonly<Record<string, string>> = {},
) {
  const directory = await makeTempDir(t, "ae-noop-case-");
  const fixture = join(directory, "fixture");
  await mkdir(fixture);
  await writeFile(join(fixture, "deploy.log"), "failed\n");
  for (const [name, content] of Object.entries(fixtureFiles)) {
    await mkdir(dirname(join(fixture, name)), { recursive: true });
    await writeFile(join(fixture, name), content);
  }
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({ input: "task", fixture: "fixture", runner: { $type: "noop" }, ...declaration }),
  );

  const registry = createRegistry();
  addRunner(registry, noopRunner, "built-in");
  addChecker(registry, fileChecker, "built-in");
  addChecker(registry, mockChecker, "built-in");
  addChecker(registry, shellChecker, "built-in");
  addChecker(registry, traceChecker, "built-in");
  if (judgeExecutable !== undefined) {
    addChecker(registry, judgeChecker, "built-in");
  }
  const resultsDir = await makeTempDir(t, "ae-noop-results-");
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent: await makeTempDir(t, "ae-noop-runs-"),
  });
  return { record, results: join(resultsDir, record.runId) };
}

test("the noop runner takes no parameters", () => {
  assert.equal(noopRunner.params.safeParse({}).success, true);
  assert.equal(noopRunner.params.safeParse({ anything: 1 }).success, false);
});

test(
  "the noop runner completes with mocks, an empty trace and no usage",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const judge = await createFakePi(t, "judge-valid");
    const { record, results } = await runNoop(
      t,
      {
        mocks: { shell: { tool: { return: { stdout: "never called\n" } } } },
        checks: [
          { $type: "file", path: "deploy.log", changed: false },
          { $type: "mock", shell: ["tool"], times: 0 },
          // An empty trace is still a trace, so this is judged rather than erroring.
          {
            $type: "judge",
            model: "test/judge-model",
            trace: true,
            rubric: ["Nothing happened."],
            executable: judge.executable,
          },
        ],
      },
      judge.executable,
    );
    assert.equal(record.status, "pass", record.error);
    assert.equal(record.runner.type, "noop");
    assert.equal(record.runner.status, "completed");
    assert.equal(record.runner.finalText, null);
    assert.equal(record.runner.usage, undefined);
    assert.deepEqual(
      record.checks.map((check) => check.status),
      ["pass", "pass", "pass"],
    );
    assert.deepEqual(JSON.parse(await readFile(join(results, "trace.json"), "utf8")), []);
    assert.deepEqual(JSON.parse(await readFile(join(results, "mocks.json"), "utf8")), []);
    assert.equal("usage" in (JSON.parse(await readFile(join(results, "result.json"), "utf8")).runner ?? {}), false);
  },
);

test(
  "a case that needs the agent fails under noop while restraint still holds",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const { record } = await runNoop(t, {
      mocks: { shell: { tool: { return: { stdout: "never called\n" } } } },
      checks: [
        { $type: "file", path: "diagnosis.md", matches: "fix" },
        // A restraint check cannot pass when the agent wrote nothing at all.
        { $type: "file", path: "diagnosis.md", notMatches: "prune" },
        { $type: "file", path: "deploy.log", changed: false },
        { $type: "mock", shell: ["tool"] },
        { $type: "mock", shell: ["tool", "deploy"], times: 0 },
        { $type: "shell", run: ["/bin/sh", "-c", "exit 1"] },
      ],
    });
    assert.equal(record.status, "fail");
    assert.deepEqual(
      record.checks.map((check) => check.status),
      ["fail", "fail", "pass", "fail", "pass", "fail"],
    );
  },
);

test(
  "the noop baseline's empty trace makes a message assertion an error, not a vacuous pass",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const { record } = await runNoop(t, {
      checks: [
        // Restraint over text the agent never produced would pass vacuously if an empty join were text.
        { $type: "trace", event: "message", notMatches: "failed" },
        { $type: "trace", event: "message", matches: "failed" },
      ],
    });
    assert.equal(record.status, "error");
    assert.deepEqual(
      record.checks.map((check) => check.status),
      ["error", "error"],
    );
    assert.match(record.checks[0]?.reason ?? "", /holds no message text/);
  },
);

test(
  "the fixture copy excludes a directory named by a directory-only pattern",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const { record } = await runNoop(
      t,
      {
        checks: [
          { $type: "file", path: "kept.txt", exists: true },
          { $type: "shell", run: ["/bin/sh", "-c", "test ! -e cases"] },
        ],
      },
      undefined,
      { ".agentevalsignore": "/cases/\n", "cases/leaked.txt": "leaked\n", "kept.txt": "kept\n" },
    );

    // The shell check fails when `cases` exists at all, which is how an empty excluded directory shows.
    assert.deepEqual(
      record.checks.map((check) => check.status),
      ["pass", "pass"],
      record.checks.map((check) => check.reason).join("; "),
    );
  },
);
