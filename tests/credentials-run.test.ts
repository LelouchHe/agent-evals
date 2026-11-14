import assert from "node:assert/strict";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { loadCase } from "../src/engine/authoring.ts";
import { ConfigError } from "../src/engine/config.ts";
import { createEnvSource } from "../src/engine/env-source.ts";
import { addChecker, addRunner, createRegistry } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { fileChecker } from "../src/checkers/file/checker.ts";
import { judgeChecker } from "../src/checkers/judge/checker.ts";
import { piRunner } from "../src/runners/pi/runner.ts";
import { runCliProcess } from "./helpers/cli-process.ts";
import { createFakePi, makeTempDir } from "./helpers/fake-pi-control.ts";

async function script(dir: string, name: string, body: string): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

function registry() {
  const value = createRegistry();
  addRunner(value, piRunner, "built-in");
  addChecker(value, fileChecker, "built-in");
  addChecker(value, judgeChecker, "built-in");
  return value;
}

function runCli(
  t: Parameters<typeof makeTempDir>[0],
  args: readonly string[],
  cwd: string,
  tmpdir: string,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return runCliProcess(t, join(import.meta.dirname, "..", "src", "cli.ts"), args, {
    cwd,
    env: { ...process.env, TMPDIR: tmpdir },
  });
}

test("runner and judge share one cached environment value without leaking it", async (t) => {
  const runner = await createFakePi(t, "runner-api-key");
  const judge = await createFakePi(t, "judge-api-key");
  const invocation = await makeTempDir(t, "ae-credentials-run-");
  await script(invocation, "count-key.sh", "printf x >> count\nprintf 'synthetic-runner-key\\n'");
  await script(invocation, "unused-key.sh", "touch unused-ran\nprintf 'unused-key\\n'");
  await writeFile(
    join(invocation, ".env"),
    [
      'OPENCODE_API_KEY="!./count-key.sh"',
      'DEEPSEEK_API_KEY="!./unused-key.sh"',
      "HOST_SECRET=dotenv-secret",
      "PATH=/dotenv/path",
      "HOME=/dotenv/home",
    ].join("\n") + "\n",
  );
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "host-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previous;
  });

  const directory = await makeTempDir(t, "ae-credentials-case-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      checks: [
        {
          $type: "judge",
          model: "opencode-go/test-judge",
          apiKey: "${env:OPENCODE_API_KEY}",
          file: "hello.txt",
          rubric: ["ok"],
          executable: judge.executable,
        },
      ],
      runner: {
        $type: "pi",
        model: "opencode-go/test-model",
        apiKey: "${env:OPENCODE_API_KEY}",
        executable: runner.executable,
      },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-credentials-results-");
  const tempParent = await makeTempDir(t, "ae-credentials-tmp-");

  const record = await runEvaluation({
    case: await loadCase(configPath),
    registry: registry(),
    resultsDir,
    tempParent,
    envSource: createEnvSource(invocation),
  });

  assert.equal(record.status, "pass", record.error);
  assert.equal(record.runner.finalText, "api-key-present");
  assert.equal(record.checks[0]?.reason, "api-key-present");
  assert.equal(record.resolvedConfig.runner.apiKey, "${env:OPENCODE_API_KEY}");
  assert.equal(record.resolvedConfig.checks[0]?.apiKey, "${env:OPENCODE_API_KEY}");
  assert.equal(await readFile(join(invocation, "count"), "utf8"), "x");
  await assert.rejects(() => readFile(join(invocation, "unused-ran")), /ENOENT/);
  const resultText = await readFile(join(resultsDir, record.runId, "result.json"), "utf8");
  assert.doesNotMatch(resultText, /synthetic-runner-key/);
  assert.deepEqual(await readdir(tempParent), []);
});

test("different environment values reach only their own runner and judge processes", async (t) => {
  const runner = await createFakePi(t, "runner-api-key-split");
  const judge = await createFakePi(t, "judge-api-key-split");
  const invocation = await makeTempDir(t, "ae-credentials-split-");
  await script(invocation, "opencode.sh", "printf x >> opencode-count\nprintf 'synthetic-runner-key\\n'");
  await script(invocation, "deepseek.sh", "printf x >> deepseek-count\nprintf 'synthetic-judge-key\\n'");
  await writeFile(
    join(invocation, ".env"),
    ['OPENCODE_API_KEY="!./opencode.sh"', 'DEEPSEEK_API_KEY="!./deepseek.sh"'].join("\n") + "\n",
  );

  const directory = await makeTempDir(t, "ae-credentials-split-case-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      checks: [
        {
          $type: "judge",
          model: "deepseek/test-judge",
          apiKey: "${env:DEEPSEEK_API_KEY}",
          file: "hello.txt",
          rubric: ["ok"],
          executable: judge.executable,
        },
      ],
      runner: {
        $type: "pi",
        model: "opencode-go/test-model",
        apiKey: "${env:OPENCODE_API_KEY}",
        executable: runner.executable,
      },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-credentials-split-results-");
  const tempParent = await makeTempDir(t, "ae-credentials-split-tmp-");

  const record = await runEvaluation({
    case: await loadCase(configPath),
    registry: registry(),
    resultsDir,
    tempParent,
    envSource: createEnvSource(invocation),
  });

  assert.equal(record.status, "pass", record.error);
  assert.equal(record.runner.finalText, "runner:true");
  assert.equal(record.checks[0]?.reason, "judge:true");
  assert.equal(await readFile(join(invocation, "opencode-count"), "utf8"), "x");
  assert.equal(await readFile(join(invocation, "deepseek-count"), "utf8"), "x");
  assert.deepEqual(await readdir(tempParent), []);
});

test("a missing required environment value fails before runtime resources and model start", async (t) => {
  const runner = await createFakePi(t, "runner-api-key");
  const invocation = await makeTempDir(t, "ae-credentials-missing-run-");
  await writeFile(join(invocation, ".env"), "AE_OTHER_KEY=other\n");
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "host-fallback-must-not-be-used";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previous;
  });
  const directory = await makeTempDir(t, "ae-credentials-missing-case-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      checks: [{ $type: "file", path: "hello.txt", exists: true }],
      runner: {
        $type: "pi",
        model: "opencode-go/test-model",
        apiKey: "${env:OPENCODE_API_KEY}",
        executable: runner.executable,
      },
    }),
  );
  await writeFile(join(directory, ".env"), "OPENCODE_API_KEY=case-directory-key\n");
  const resultsDir = await makeTempDir(t, "ae-credentials-missing-results-");
  const tempParent = await makeTempDir(t, "ae-credentials-missing-tmp-");

  const loaded = await loadCase(configPath);
  await assert.rejects(
    () =>
      runEvaluation({
        case: loaded,
        registry: registry(),
        resultsDir,
        tempParent,
        envSource: createEnvSource(invocation),
      }),
    ConfigError,
  );
  assert.deepEqual(await readdir(tempParent), []);
  assert.deepEqual(await readdir(resultsDir), []);
});

test("CLI resolves .env only from the invocation working directory", async (t) => {
  const runner = await createFakePi(t, "runner-api-key");
  const judge = await createFakePi(t, "judge-api-key");
  const caseDir = await makeTempDir(t, "ae-credentials-cli-case-");
  const configPath = join(caseDir, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      checks: [
        {
          $type: "judge",
          model: "opencode-go/test-judge",
          apiKey: "${env:OPENCODE_API_KEY}",
          file: "hello.txt",
          rubric: ["ok"],
          executable: judge.executable,
        },
      ],
      runner: {
        $type: "pi",
        model: "opencode-go/test-model",
        apiKey: "${env:OPENCODE_API_KEY}",
        executable: runner.executable,
      },
    }),
  );
  const invocation = await makeTempDir(t, "ae-credentials-cli-cwd-");
  await script(invocation, "count-key.sh", "printf x >> count\nprintf 'synthetic-runner-key\\n'");
  await writeFile(join(invocation, ".env"), 'OPENCODE_API_KEY="!./count-key.sh"\n');
  const resultsDir = await makeTempDir(t, "ae-credentials-cli-results-");
  const tempParent = await makeTempDir(t, "ae-credentials-cli-tmp-");

  const result = await runCli(t, ["run", configPath, "--results-dir", resultsDir], invocation, tempParent);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /: pass/);
  assert.equal(await readFile(join(invocation, "count"), "utf8"), "x");
  assert.deepEqual(await readdir(tempParent), []);

  await writeFile(join(caseDir, ".env"), "OPENCODE_API_KEY=case-directory-key\n");
  const elsewhere = await makeTempDir(t, "ae-credentials-cli-elsewhere-");
  const missing = await runCli(t, ["run", configPath, "--results-dir", resultsDir], elsewhere, tempParent);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /environment value OPENCODE_API_KEY is unavailable/);
  assert.deepEqual(await readdir(tempParent), []);
});

test("natural apiKey fields receive ordinary values from arbitrary environment names", async (t) => {
  const runner = await createFakePi(t, "runner-custom-api-key");
  const judge = await createFakePi(t, "judge-custom-api-key");
  const invocation = await makeTempDir(t, "ae-credentials-custom-");
  await writeFile(
    join(invocation, ".env"),
    "MY_RUNNER_KEY=synthetic-custom-runner\nMY_JUDGE_KEY=synthetic-custom-judge\n",
  );
  const directory = await makeTempDir(t, "ae-credentials-custom-case-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      checks: [
        {
          $type: "judge",
          model: "test/judge-model",
          apiKey: "${env:MY_JUDGE_KEY}",
          file: "hello.txt",
          rubric: ["ok"],
          executable: judge.executable,
        },
      ],
      runner: {
        $type: "pi",
        model: "test/model",
        apiKey: "${env:MY_RUNNER_KEY}",
        executable: runner.executable,
      },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-credentials-custom-results-");
  const tempParent = await makeTempDir(t, "ae-credentials-custom-tmp-");
  const record = await runEvaluation({
    case: await loadCase(configPath),
    registry: registry(),
    resultsDir,
    tempParent,
    envSource: createEnvSource(invocation),
  });
  assert.equal(record.status, "pass", record.error);
  assert.equal(record.runner.finalText, "custom:true");
  assert.equal(record.checks[0]?.reason, "custom:true");
  assert.equal(record.resolvedConfig.runner.apiKey, "${env:MY_RUNNER_KEY}");
  assert.equal(record.resolvedConfig.checks[0]?.apiKey, "${env:MY_JUDGE_KEY}");
  assert.deepEqual(await readdir(tempParent), []);
});

test("an environment value that resembles a reference is not expanded again", async (t) => {
  const runner = await createFakePi(t, "runner-echo-api-key");
  const invocation = await makeTempDir(t, "ae-credentials-echo-");
  await writeFile(join(invocation, ".env"), "WRAPPED_KEY=${env:OTHER}\nOTHER=second-value\n");
  const directory = await makeTempDir(t, "ae-credentials-echo-case-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      checks: [{ $type: "file", path: "hello.txt", exists: true }],
      runner: {
        $type: "pi",
        model: "opencode-go/test-model",
        apiKey: "${env:WRAPPED_KEY}",
        executable: runner.executable,
      },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-credentials-echo-results-");
  const tempParent = await makeTempDir(t, "ae-credentials-echo-tmp-");
  const record = await runEvaluation({
    case: await loadCase(configPath),
    registry: registry(),
    resultsDir,
    tempParent,
    envSource: createEnvSource(invocation),
  });
  assert.equal(record.status, "pass", record.error);
  assert.equal(record.runner.finalText, "${env:OTHER}");
  assert.deepEqual(await readdir(tempParent), []);
});

test("only the selected case's placeholders are resolved", async (t) => {
  const runner = await createFakePi(t, "runner-api-key-details");
  const invocation = await makeTempDir(t, "ae-credentials-selected-");
  await script(invocation, "selected.sh", "printf x >> selected-count\nprintf 'synthetic-runner-key\n'");
  await script(invocation, "unused.sh", "touch unused-ran\nprintf 'unused-key\n'");
  await writeFile(
    join(invocation, ".env"),
    ['SELECTED_KEY="!./selected.sh"', 'UNUSED_KEY="!./unused.sh"'].join("\n") + "\n",
  );
  const directory = await makeTempDir(t, "ae-credentials-selected-case-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      cases: {
        selected: {
          checks: [{ $type: "file", path: "hello.txt", exists: true }],
          runner: {
            $type: "pi",
            model: "opencode-go/test-model",
            apiKey: "${env:SELECTED_KEY}",
            executable: runner.executable,
          },
        },
        unused: {
          checks: [{ $type: "file", path: "hello.txt", exists: true }],
          runner: {
            $type: "pi",
            model: "opencode-go/test-model",
            apiKey: "${env:UNUSED_KEY}",
            executable: runner.executable,
          },
        },
      },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-credentials-selected-results-");
  const tempParent = await makeTempDir(t, "ae-credentials-selected-tmp-");
  const record = await runEvaluation({
    case: await loadCase(configPath, { caseName: "selected" }),
    registry: registry(),
    resultsDir,
    tempParent,
    envSource: createEnvSource(invocation),
  });
  assert.equal(record.status, "pass", record.error);
  assert.equal(await readFile(join(invocation, "selected-count"), "utf8"), "x");
  await assert.rejects(() => readFile(join(invocation, "unused-ran")), /ENOENT/);
  assert.deepEqual(await readdir(tempParent), []);
});

test("omitting apiKey performs no environment lookup", async (t) => {
  const runner = await createFakePi(t, "success");
  const invocation = await makeTempDir(t, "ae-credentials-none-");
  await script(invocation, "count-key.sh", "printf x >> count\nprintf 'synthetic-unused-key\\n'");
  await writeFile(join(invocation, ".env"), 'OPENCODE_API_KEY="!./count-key.sh"\n');
  const directory = await makeTempDir(t, "ae-credentials-none-case-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: 'Create hello.txt with exactly the content "Hello, world!".',
      checks: [{ $type: "file", path: "hello.txt", exists: true }],
      runner: { $type: "pi", model: "opencode-go/test-model", executable: runner.executable },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-credentials-none-results-");
  const tempParent = await makeTempDir(t, "ae-credentials-none-tmp-");
  const record = await runEvaluation({
    case: await loadCase(configPath),
    registry: registry(),
    resultsDir,
    tempParent,
    envSource: createEnvSource(invocation),
  });
  assert.equal(record.status, "pass", record.error);
  await assert.rejects(() => readFile(join(invocation, "count")), /ENOENT/);
  assert.deepEqual(await readdir(tempParent), []);
});
