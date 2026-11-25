import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { loadCase } from "../src/engine/authoring.ts";
import { createEnvSource } from "../src/engine/env-source.ts";
import { ConfigError } from "../src/engine/config.ts";
import { addChecker, addRunner, createRegistry, type RunnerDefinition } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import type { EvaluationRecord } from "../src/engine/results.ts";
import { fileChecker } from "../src/checkers/file/index.ts";
import { judgeChecker } from "../src/checkers/judge/index.ts";
import { noopRunner } from "../src/runners/noop/index.ts";
import { piRunner } from "../src/runners/pi/index.ts";
import { createFakePi, makeTempDir } from "./helpers/fake-pi-control.ts";
import { z } from "zod";

interface ScenarioOptions {
  readonly runnerExecutable: string;
  readonly judgeExecutable?: string;
  readonly checks?: readonly Record<string, unknown>[];
  readonly fixtureFiles?: Record<string, string>;
  /** Authoring files written beside the case file, keyed by config-relative path. */
  readonly assets?: Record<string, string>;
  readonly files?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly skill?: boolean;
}

async function writeScenario(t: Parameters<typeof makeTempDir>[0], options: ScenarioOptions) {
  const directory = await makeTempDir(t, "ae-scenario-");
  const casePath = join(directory, "case.yml");
  const checks = options.checks ?? [
    { $type: "file", path: "hello.txt", exists: true, matches: "/^Hello, world!\\n?$/" },
    {
      $type: "judge",
      runner: {
        $type: "pi",
        model: "test/judge-model",
        thinking: "low",
        executable: options.judgeExecutable,
      },
      file: "hello.txt",
      rubric: ["hello.txt exists and contains Hello, world!."],
    },
  ];
  if (options.fixtureFiles !== undefined) {
    const fixtureDir = join(directory, "fixture");
    await mkdir(fixtureDir, { recursive: true });
    for (const [name, content] of Object.entries(options.fixtureFiles)) {
      await mkdir(dirname(join(fixtureDir, name)), { recursive: true });
      await writeFile(join(fixtureDir, name), content);
    }
  }
  for (const [name, content] of Object.entries(options.assets ?? {})) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), content);
  }
  await writeFile(
    casePath,
    stringify({
      input: 'Create hello.txt with exactly the content "Hello, world!".',
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.fixtureFiles === undefined ? {} : { fixture: "fixture" }),
      ...(options.files === undefined ? {} : { files: options.files }),
      checks,
      runner: {
        $type: "pi",
        model: "test/model",
        thinking: "low",
        executable: options.runnerExecutable,
        ...(options.skill === true ? { skills: ["skill"] } : {}),
      },
    }),
  );
  if (options.skill === true) {
    await mkdir(join(directory, "skill"));
    await writeFile(
      join(directory, "skill", "SKILL.md"),
      "---\nname: tiny-write\ndescription: Write a file.\n---\n\nWrite it.\n",
    );
  }
  return { directory, casePath };
}

test("runtime baseline is Node.js 24 or newer", () => {
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  assert.ok(major >= 24, `expected Node.js >=24, running ${process.versions.node}`);
});

test("integration: a judge without its own runner declaration runs the case's runner", async (t) => {
  const prompts: string[] = [];
  const stub: RunnerDefinition<{ readonly model: string }> = {
    type: "stub",
    params: z.strictObject({ model: z.string() }),
    create: (params) => ({
      run: async (context) => {
        prompts.push(context.input);
        return {
          finalText: JSON.stringify({ criteria: [{ pass: true, reason: `model ${params.model}` }] }),
          diagnostics: [],
        };
      },
      stop: async () => {},
    }),
  };
  const registry = createRegistry();
  addRunner(registry, stub, "test");
  addChecker(registry, judgeChecker, "built-in");

  const directory = await makeTempDir(t, "ae-judge-inherit-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "Do the task.",
      checks: [{ $type: "judge", file: "report.md", rubric: ["The report names the cause."] }],
      runner: { $type: "stub", model: "stub/model" },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-judge-inherit-results-");
  const tempParent = await makeTempDir(t, "ae-judge-inherit-runs-");
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent,
  });

  assert.equal(record.status, "pass", record.error);
  assert.equal(record.runner.type, "stub");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], "Do the task.");
  assert.match(prompts[1] ?? "", /Rubric statements/);
  assert.equal(record.checks[0]?.reason, "model stub/model");
  assert.deepEqual(await readdir(tempParent), []);
});

test("a judge's declared runner resolves its placeholders once, without expanding the result again", async (t) => {
  const seen: string[] = [];
  const stub: RunnerDefinition<{ readonly apiKey: string }> = {
    type: "stub",
    params: z.strictObject({ apiKey: z.string() }),
    create: (params) => ({
      run: async () => {
        seen.push(params.apiKey);
        return { finalText: '{"criteria":[{"pass":true,"reason":"ok"}]}', diagnostics: [] };
      },
      stop: async () => {},
    }),
  };
  const registry = createRegistry();
  addRunner(registry, stub, "test");
  addChecker(registry, judgeChecker, "built-in");

  const directory = await makeTempDir(t, "ae-judge-substitute-");
  // The value looks like a placeholder itself; substitution never scans its own output again.
  await writeFile(join(directory, ".env"), 'JUDGE_KEY="${TMPDIR}"\n');
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "Do the task.",
      checks: [
        {
          $type: "judge",
          runner: { $type: "stub", apiKey: "${env:JUDGE_KEY}" },
          file: "report.md",
          rubric: ["The report names the cause."],
        },
      ],
      runner: { $type: "stub", apiKey: "case-key" },
    }),
  );
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir: await makeTempDir(t, "ae-judge-substitute-results-"),
    tempParent: await makeTempDir(t, "ae-judge-substitute-runs-"),
    envSource: createEnvSource(directory),
  });

  assert.equal(record.status, "pass", record.error);
  assert.deepEqual(seen, ["case-key", "${TMPDIR}"]);
});

test("a runner a checker declares is reported as that check's error, not the case runner's", async (t) => {
  const stub: RunnerDefinition<{ readonly apiKey: string }> = {
    type: "stub",
    params: z.strictObject({ apiKey: z.string() }),
    create: () => ({
      run: async () => ({ finalText: null, diagnostics: [] }),
      stop: async () => {},
    }),
  };
  const registry = createRegistry();
  addRunner(registry, stub, "test");
  addChecker(registry, judgeChecker, "built-in");

  const casePath = join(await makeTempDir(t, "ae-judge-attribution-"), "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "Do the task.",
      checks: [
        { $type: "judge", file: "report.md", rubric: ["x"] },
        { $type: "judge", runner: { $type: "stub", apiKey: 42 }, file: "report.md", rubric: ["x"] },
      ],
      runner: { $type: "stub", apiKey: "case-key" },
    }),
  );

  const resultsDir = await makeTempDir(t, "ae-judge-attribution-results-");
  const tempParent = await makeTempDir(t, "ae-judge-attribution-runs-");
  const loaded = await loadCase(casePath);
  await assert.rejects(
    () => runEvaluation({ case: loaded, registry, resultsDir, tempParent }),
    (error: unknown) =>
      error instanceof ConfigError &&
      /checks\[1\] \(checker "judge"\): runner "stub" parameter apiKey/.test(error.message),
  );
  assert.deepEqual(await readdir(resultsDir), []);
  assert.deepEqual(await readdir(tempParent), []);
});

function testRegistry() {
  const registry = createRegistry();
  addRunner(registry, piRunner, "built-in");
  addChecker(registry, fileChecker, "built-in");
  addChecker(registry, judgeChecker, "built-in");
  return registry;
}

async function runScenario(
  t: Parameters<typeof makeTempDir>[0],
  options: ScenarioOptions,
  configure?: (request: { signal?: AbortSignal; resultsDir: string; tempParent: string }) => { signal?: AbortSignal },
) {
  const scenario = await writeScenario(t, options);
  const resultsDir = await makeTempDir(t, "ae-results-");
  const tempParent = await makeTempDir(t, "ae-runs-");
  const configured = configure?.({ resultsDir, tempParent }) ?? {};
  const record = await runEvaluation({
    case: await loadCase(scenario.casePath),
    registry: testRegistry(),
    resultsDir,
    tempParent,
    ...(configured.signal === undefined ? {} : { signal: configured.signal }),
  });
  return { scenario, record, resultsDir, tempParent };
}

test("integration: success runs file and judge checks and cleans the run directory", async (t) => {
  const runner = await createFakePi(t, "success");
  const judge = await createFakePi(t, "judge-valid");
  const { scenario, record, resultsDir, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    judgeExecutable: judge.executable,
    fixtureFiles: { "seed.txt": "keep me\n" },
    skill: true,
  });

  // The fixture path is resolved relative to the declaring case file.
  const fixtureScenario = join(scenario.directory, "fixture");

  assert.equal(record.status, "pass", record.error);
  assert.equal(record.runner.status, "completed");
  assert.deepEqual(
    record.checks.map((check) => check.status),
    ["pass", "pass", "pass"],
  );
  assert.equal(record.cleanup.status, "removed");
  assert.deepEqual(await readdir(tempParent), []);
  assert.equal(await readFile(join(fixtureScenario, "seed.txt"), "utf8"), "keep me\n");

  const saved = JSON.parse(await readFile(join(resultsDir, record.runId, "result.json"), "utf8")) as EvaluationRecord;
  assert.equal(saved.status, "pass");
  assert.equal(saved.runId, record.runId);
  // Native Pi reports no usage; the field is omitted rather than zeroed.
  assert.equal(record.runner.usage, undefined);
  assert.equal("usage" in saved.runner, false);
  assert.deepEqual(saved.resolvedConfig.runner, {
    $type: "pi",
    model: "test/model",
    thinking: "low",
    executable: runner.executable,
    skills: ["skill"],
  });
  assert.equal("resolvedExecutable" in saved.resolvedConfig.runner, false);
});

test("integration: changed false uses the engine baseline, which is outside agent access", async (t) => {
  const runner = await createFakePi(t, "probe-baseline");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    fixtureFiles: { "seed.txt": "keep me\n" },
    checks: [
      { $type: "file", path: "seed.txt", changed: false },
      { $type: "file", path: "probe.txt", matches: "/EPERM|EACCES|ENOENT/" },
    ],
  });

  assert.equal(record.status, "pass", record.error);
  assert.deepEqual(
    record.checks.map((check) => check.status),
    ["pass", "pass"],
  );
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: files entries replace fixture files and belong to the baseline", async (t) => {
  const runner = await createFakePi(t, "success");
  const { scenario, record, resultsDir, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    fixtureFiles: { "seed.txt": "from fixture\n" },
    assets: { "override/seed.txt": "from override\n", "skill/SKILL.md": "skill body\n" },
    files: { "seed.txt": "override/seed.txt", ".agents/skills/demo": "skill" },
    checks: [
      { $type: "file", path: "seed.txt", matches: "/^from override\\n$/" },
      { $type: "file", path: "seed.txt", changed: false },
      { $type: "file", path: ".agents/skills/demo/SKILL.md", matches: "/^skill body/" },
    ],
  });

  assert.equal(record.status, "pass", record.error);
  assert.deepEqual(
    record.checks.map((check) => check.status),
    ["pass", "pass", "pass"],
  );
  // The placed files are part of the baseline, so `changed: false` saw the replaced bytes.
  // The source fixture keeps its own bytes.
  assert.equal(await readFile(join(scenario.directory, "fixture", "seed.txt"), "utf8"), "from fixture\n");
  assert.deepEqual(await readdir(tempParent), []);

  const saved = JSON.parse(await readFile(join(resultsDir, record.runId, "result.json"), "utf8")) as EvaluationRecord;
  assert.deepEqual(saved.resolvedConfig.files, {
    "seed.txt": "override/seed.txt",
    ".agents/skills/demo": "skill",
  });
});

test("integration: the fixture copy leaves out what its .agentevalsignore declares", async (t) => {
  const runner = await createFakePi(t, "success");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    fixtureFiles: {
      ".agentevalsignore": "/cases\n\n# the ignore file is metadata, not fixture content\n",
      "kept.txt": "kept\n",
      "cases/hidden.txt": "never placed\n",
    },
    checks: [
      { $type: "file", path: "kept.txt", matches: "/^kept\\n?$/" },
      { $type: "file", path: "cases/hidden.txt", exists: false },
      { $type: "file", path: ".agentevalsignore", exists: false },
    ],
  });

  assert.equal(record.status, "pass", record.error);
  assert.deepEqual(
    record.checks.map((check) => check.status),
    ["pass", "pass", "pass"],
  );
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: two files entries producing one path fail the run before the runner starts", async (t) => {
  const runner = await createFakePi(t, "record-prompt");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    assets: { "a/inner.txt": "first\n", "b/inner.txt": "second\n" },
    files: { outer: "a", "outer/inner.txt": "b/inner.txt" },
    checks: [{ $type: "file", path: "hello.txt", exists: true }],
  });

  assert.equal(record.status, "error");
  assert.match(record.error ?? "", /files entry "outer\/inner\.txt" overwrites outer\/inner\.txt/);
  assert.deepEqual(record.checks, []);
  assert.equal(record.runner.durationMs, 0);
  await assert.rejects(readFile(runner.extraFile), { code: "ENOENT" });
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: a replaced workspace root is rejected instead of reading outside evidence", async (t) => {
  const outside = await makeTempDir(t, "ae-outside-root-");
  await writeFile(join(outside, "hello.txt"), "outside-sentinel\n");
  const runner = await createFakePi(t, "replace-root", outside);
  const judge = await createFakePi(t, "judge-valid");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    judgeExecutable: judge.executable,
    checks: [
      { $type: "file", path: "hello.txt", exists: true },
      { $type: "file", path: "hello.txt", matches: "outside-sentinel" },
      { $type: "file", path: "hello.txt", changed: false },
      {
        $type: "judge",
        runner: { $type: "pi", model: "test/judge-model", executable: judge.executable },
        file: "hello.txt",
        rubric: ["hello.txt exists"],
      },
    ],
  });

  assert.equal(record.status, "error", `checks: ${JSON.stringify(record.checks)}`);
  assert.equal(record.checks.length, 4);
  assert.ok(
    record.checks.every((check) => check.status === "error"),
    JSON.stringify(record.checks),
  );
  assert.match(record.checks.map((check) => check.reason).join(" "), /root|replac|outside/i);
  assert.equal(await readFile(join(outside, "hello.txt"), "utf8"), "outside-sentinel\n");
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: a final provider error is an execution error even with satisfied files", async (t) => {
  const runner = await createFakePi(t, "provider-error");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    fixtureFiles: { "hello.txt": "Hello, world!\n" },
    checks: [{ $type: "file", path: "hello.txt", exists: true }],
  });

  assert.equal(record.status, "error");
  assert.equal(record.runner.status, "error");
  assert.deepEqual(record.checks, []);
  assert.match(record.error ?? "", /401|provider request failed/);
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: a final provider error without satisfied files is also an execution error", async (t) => {
  const runner = await createFakePi(t, "provider-error");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    checks: [{ $type: "file", path: "hello.txt", exists: true }],
  });

  assert.equal(record.status, "error");
  assert.equal(record.runner.status, "error");
  assert.deepEqual(record.checks, []);
  assert.match(record.error ?? "", /401|provider request failed/);
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: the removed unchanged key is rejected before run resources", async (t) => {
  const runner = await createFakePi(t, "success");
  const scenario = await writeScenario(t, {
    runnerExecutable: runner.executable,
    checks: [{ $type: "file", path: "hello.txt", unchanged: true }],
  });
  const resultsDir = await makeTempDir(t, "ae-results-unchanged-");
  const tempParent = await makeTempDir(t, "ae-runs-unchanged-");
  const loadedCase = await loadCase(scenario.casePath);

  await assert.rejects(
    () =>
      runEvaluation({
        case: loadedCase,
        registry: testRegistry(),
        resultsDir,
        tempParent,
      }),
    ConfigError,
  );
  assert.deepEqual(await readdir(tempParent), []);
  assert.deepEqual(await readdir(resultsDir), []);
});

test("integration: a normal failed file check is reported as fail", async (t) => {
  const runner = await createFakePi(t, "no-write");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    checks: [{ $type: "file", path: "hello.txt", exists: true }],
  });

  assert.equal(record.status, "fail");
  assert.equal(record.checks[0]?.status, "fail");
  assert.equal(record.runner.status, "completed");
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: a checker failure is distinct from a failed check", async (t) => {
  const runner = await createFakePi(t, "success");
  const judge = await createFakePi(t, "judge-invalid");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    judgeExecutable: judge.executable,
  });

  assert.equal(record.status, "error");
  assert.equal(record.runner.status, "completed");
  assert.equal(record.checks.find((check) => check.checker === "file")?.status, "pass");
  assert.equal(record.checks.find((check) => check.checker === "judge")?.status, "error");
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: a failed start is recorded and cleaned", async (t) => {
  const runner = await createFakePi(t, "crash");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    checks: [{ $type: "file", path: "hello.txt", exists: true }],
  });

  assert.equal(record.status, "error");
  assert.equal(record.runner.status, "error");
  assert.deepEqual(record.checks, []);
  assert.ok(record.error !== undefined);
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: a startup failure is recorded and cleaned", async (t) => {
  const runner = await createFakePi(t, "startup-crash");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    checks: [{ $type: "file", path: "hello.txt", exists: true }],
  });

  assert.equal(record.status, "error");
  assert.equal(record.runner.status, "error");
  assert.deepEqual(record.checks, []);
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: a runner timeout is bounded and cleaned", async (t) => {
  const runner = await createFakePi(t, "hang");
  const started = performance.now();
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    timeoutMs: 700,
    checks: [{ $type: "file", path: "hello.txt", exists: true }],
  });

  assert.equal(record.status, "timeout");
  assert.equal(record.runner.status, "timeout");
  assert.deepEqual(record.checks, []);
  assert.ok(performance.now() - started < 15_000);
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: external cancellation is recorded and cleaned", async (t) => {
  const runner = await createFakePi(t, "hang");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  t.after(() => clearTimeout(timer));

  const { record, tempParent } = await runScenario(
    t,
    {
      runnerExecutable: runner.executable,
      timeoutMs: 10_000,
      checks: [{ $type: "file", path: "hello.txt", exists: true }],
    },
    () => ({ signal: controller.signal }),
  );

  assert.equal(record.status, "cancelled");
  assert.equal(record.runner.status, "cancelled");
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: invalid configuration is rejected before any run resource", async (t) => {
  const runner = await createFakePi(t, "success");
  const scenario = await writeScenario(t, {
    runnerExecutable: runner.executable,
    checks: [{ $type: "file", path: "hello.txt", matches: "/(/" }],
  });
  const resultsDir = await makeTempDir(t, "ae-results-invalid-");
  const tempParent = await makeTempDir(t, "ae-runs-invalid-");
  const loadedCase = await loadCase(scenario.casePath);

  await assert.rejects(
    () =>
      runEvaluation({
        case: loadedCase,
        registry: testRegistry(),
        resultsDir,
        tempParent,
      }),
    ConfigError,
  );
  assert.deepEqual(await readdir(tempParent), []);
  assert.deepEqual(await readdir(resultsDir), []);
});

test("integration: missing authoring assets fail before launch", async (t) => {
  const runner = await createFakePi(t, "success");
  const scenario = await writeScenario(t, { runnerExecutable: runner.executable, skill: true });
  const loadedCase = await loadCase(scenario.casePath);
  const modified = {
    ...loadedCase,
    config: {
      ...loadedCase.config,
      runner: { ...loadedCase.config.runner, skills: ["missing-skill"] },
    },
  };
  const resultsDir = await makeTempDir(t, "ae-results-missing-");
  const tempParent = await makeTempDir(t, "ae-runs-missing-");

  await assert.rejects(
    () =>
      runEvaluation({
        case: modified,
        registry: testRegistry(),
        resultsDir,
        tempParent,
      }),
    ConfigError,
  );
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: CLI runs from a different cwd and resolves authoring assets", async (t) => {
  const runner = await createFakePi(t, "success");
  const judge = await createFakePi(t, "judge-valid");
  const scenario = await writeScenario(t, {
    runnerExecutable: runner.executable,
    judgeExecutable: judge.executable,
    skill: true,
  });
  const resultsDir = await makeTempDir(t, "ae-cli-results-");
  const tempParent = await makeTempDir(t, "ae-cli-runs-");
  const cwd = await makeTempDir(t, "ae-cli-cwd-");

  const result = await runCli(["run", scenario.casePath, "--results-dir", resultsDir], { cwd, TMPDIR: tempParent });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /run .*: pass/);
  assert.deepEqual(await readdir(tempParent), []);

  const runDirectories = await readdir(resultsDir);
  assert.equal(runDirectories.length, 1);
  const record = JSON.parse(
    await readFile(join(resultsDir, runDirectories[0] ?? "", "result.json"), "utf8"),
  ) as EvaluationRecord;
  assert.equal(record.status, "pass");
  assert.equal(record.case.name, undefined);
  assert.equal(record.case.path, scenario.casePath);
});

test("integration: CLI reports configuration errors with exit code 2", async (t) => {
  const runner = await createFakePi(t, "success");
  const scenario = await writeScenario(t, {
    runnerExecutable: runner.executable,
    checks: [{ $type: "not-a-checker", path: "hello.txt" }],
  });
  const resultsDir = await makeTempDir(t, "ae-cli-invalid-results-");
  const tempParent = await makeTempDir(t, "ae-cli-invalid-runs-");

  const result = await runCli(["run", scenario.casePath, "--results-dir", resultsDir], {
    cwd: scenario.directory,
    TMPDIR: tempParent,
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /configuration error: unknown checker implementation/);
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: FIFO evidence fails promptly and the CLI exits", { timeout: 30_000 }, async (t) => {
  const runner = await createFakePi(t, "fifo");
  const scenario = await writeScenario(t, {
    runnerExecutable: runner.executable,
    checks: [{ $type: "file", path: "hello.txt", matches: "anything" }],
  });
  const resultsDir = await makeTempDir(t, "ae-cli-fifo-results-");
  const tempParent = await makeTempDir(t, "ae-cli-fifo-runs-");

  const result = await runCli(["run", scenario.casePath, "--results-dir", resultsDir], {
    cwd: scenario.directory,
    TMPDIR: tempParent,
    timeoutMs: 10_000,
  });
  assert.equal(result.timedOut, false, "CLI remained blocked on a FIFO");
  assert.equal(result.code, 2, result.stderr);
  const record = await readOnlyResult(resultsDir);
  assert.equal(record.status, "error");
  assert.equal(record.checks[0]?.status, "error");
  assert.match(record.checks[0]?.reason ?? "", /regular file|FIFO|not a regular/);
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: FIFO judge evidence fails promptly and the CLI exits", { timeout: 30_000 }, async (t) => {
  const runner = await createFakePi(t, "fifo");
  const judge = await createFakePi(t, "judge-valid");
  const scenario = await writeScenario(t, {
    runnerExecutable: runner.executable,
    checks: [
      {
        $type: "judge",
        runner: { $type: "pi", model: "test/judge-model", executable: judge.executable },
        file: "hello.txt",
        rubric: ["hello.txt exists"],
      },
    ],
  });
  const resultsDir = await makeTempDir(t, "ae-cli-fifo-judge-results-");
  const tempParent = await makeTempDir(t, "ae-cli-fifo-judge-runs-");

  const result = await runCli(["run", scenario.casePath, "--results-dir", resultsDir], {
    cwd: scenario.directory,
    TMPDIR: tempParent,
    timeoutMs: 10_000,
  });
  assert.equal(result.timedOut, false, "CLI remained blocked on a FIFO");
  assert.equal(result.code, 2, result.stderr);
  const record = await readOnlyResult(resultsDir);
  assert.equal(record.status, "error");
  assert.equal(record.checks[0]?.status, "error");
  assert.match(record.checks[0]?.reason ?? "", /regular file|FIFO|not a regular/);
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: a backtracking pattern is bounded and the CLI exits", { timeout: 30_000 }, async (t) => {
  const runner = await createFakePi(t, "pathological");
  // Catastrophic for a backtracking engine; linear-time on RE2, which must still answer.
  const scenario = await writeScenario(t, {
    runnerExecutable: runner.executable,
    timeoutMs: 500,
    checks: [{ $type: "file", path: "hello.txt", matches: "/(a+)+$/" }],
  });
  const resultsDir = await makeTempDir(t, "ae-cli-regex-results-");
  const tempParent = await makeTempDir(t, "ae-cli-regex-runs-");

  const result = await runCli(["run", scenario.casePath, "--results-dir", resultsDir], {
    cwd: scenario.directory,
    TMPDIR: tempParent,
    timeoutMs: 10_000,
  });
  assert.equal(result.timedOut, false, "CLI remained blocked in regex evaluation");
  // The check ran to a real negative judgment instead of timing out.
  assert.equal(result.code, 1, result.stderr);
  const record = await readOnlyResult(resultsDir);
  assert.equal(record.status, "fail");
  assert.equal(record.checks[0]?.status, "fail");
  assert.deepEqual(await readdir(tempParent), []);
});

test("integration: CLI cancellation interrupts and cleans up", async (t) => {
  const runner = await createFakePi(t, "hang");
  const scenario = await writeScenario(t, {
    runnerExecutable: runner.executable,
    timeoutMs: 10_000,
    checks: [{ $type: "file", path: "hello.txt", exists: true }],
  });
  const resultsDir = await makeTempDir(t, "ae-cli-cancel-results-");
  const tempParent = await makeTempDir(t, "ae-cli-cancel-runs-");

  const child = spawn(process.execPath, ["src/cli.ts", "run", scenario.casePath, "--results-dir", resultsDir], {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: tempParent },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  child.kill("SIGINT");
  const code = await new Promise<number | null>((resolve) => child.on("exit", (value) => resolve(value)));

  assert.equal(code, 2, stderr);
  assert.deepEqual(await readdir(tempParent), []);
  const runDirectories = await readdir(resultsDir);
  const record = JSON.parse(
    await readFile(join(resultsDir, runDirectories[0] ?? "", "result.json"), "utf8"),
  ) as EvaluationRecord;
  assert.equal(record.status, "cancelled");
  assert.equal(record.cleanup.status, "removed");
});

async function readOnlyResult(resultsDir: string): Promise<EvaluationRecord> {
  const runDirectories = await readdir(resultsDir);
  assert.equal(runDirectories.length, 1);
  return JSON.parse(
    await readFile(join(resultsDir, runDirectories[0] ?? "", "result.json"), "utf8"),
  ) as EvaluationRecord;
}

async function runCli(
  args: string[],
  options: { cwd: string; TMPDIR: string; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> {
  const started = performance.now();
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), ...args], {
    cwd: options.cwd,
    env: { ...process.env, TMPDIR: options.TMPDIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs);
  const code = await new Promise<number | null>((resolve) => child.on("exit", (value) => resolve(value)));
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return { code, stdout, stderr, timedOut, durationMs: performance.now() - started };
}

test("integration: a checker that returns results synchronously is judged, not dropped", async (t) => {
  const runner = await createFakePi(t, "success");
  const directory = await makeTempDir(t, "ae-sync-checker-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: 'Create hello.txt with exactly the content "Hello, world!".',
      checks: [{ $type: "sync-pass" }, { $type: "sync-throw" }],
      runner: { $type: "pi", model: "test/model", thinking: "low", executable: runner.executable },
    }),
  );

  // The documented contract is `check(context) -> CheckResult[]`: a checker may answer without a
  // promise, and a synchronous throw is still one check's error rather than the whole run's.
  const registry = createRegistry();
  addRunner(registry, piRunner, "built-in");
  addChecker(
    registry,
    {
      type: "sync-pass",
      params: z.strictObject({}),
      create: () => ({
        check: () => [
          { checker: "sync-pass", subject: "synchronous result", status: "pass" as const, reason: "returned directly" },
        ],
      }),
    },
    "test",
  );
  addChecker(
    registry,
    {
      type: "sync-throw",
      params: z.strictObject({}),
      create: () => ({
        check: () => {
          throw new Error("synchronous failure");
        },
      }),
    },
    "test",
  );

  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir: await makeTempDir(t, "ae-results-"),
    tempParent: await makeTempDir(t, "ae-runs-"),
  });

  assert.equal(record.status, "error");
  assert.deepEqual(
    record.checks.map((check) => [check.checker, check.status]),
    [
      ["sync-pass", "pass"],
      ["sync-throw", "error"],
    ],
  );
  assert.match(record.checks[1]?.reason ?? "", /synchronous failure/);
});

test("integration: a checker that answers after its budget is an error, not a verdict", async (t) => {
  const directory = await makeTempDir(t, "ae-late-checker-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "noop",
      timeoutMs: 20,
      checks: [{ $type: "late-pass" }, { $type: "late-fail" }, { $type: "sentinel" }],
      runner: { $type: "noop" },
    }),
  );

  // The budget is the verdict: a checker that finishes after its abort signal fired has still
  // exceeded it, whatever it claims, and the remaining checks must run regardless.
  const registry = createRegistry();
  addRunner(registry, noopRunner, "built-in");
  addChecker(
    registry,
    {
      type: "late-pass",
      params: z.strictObject({}),
      create: () => ({
        check: ({ signal }: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () =>
              setTimeout(
                () =>
                  resolve([
                    { checker: "late-pass", subject: "late result", status: "pass" as const, reason: "answered late" },
                  ]),
                50,
              ),
            );
          }),
      }),
    },
    "test",
  );
  addChecker(
    registry,
    {
      type: "late-fail",
      params: z.strictObject({}),
      create: () => ({
        check: ({ signal }: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () =>
              setTimeout(
                () =>
                  resolve([
                    { checker: "late-fail", subject: "late result", status: "fail" as const, reason: "answered late" },
                  ]),
                50,
              ),
            );
          }),
      }),
    },
    "test",
  );
  addChecker(
    registry,
    {
      type: "sentinel",
      params: z.strictObject({}),
      create: () => ({
        check: () => [
          {
            checker: "sentinel",
            subject: "sentinel result",
            status: "pass" as const,
            reason: "ran after the late check",
          },
        ],
      }),
    },
    "test",
  );

  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir: await makeTempDir(t, "ae-results-"),
    tempParent: await makeTempDir(t, "ae-runs-"),
  });

  assert.deepEqual(
    record.checks.map((check) => [check.checker, check.status]),
    [
      ["late-pass", "error"],
      ["late-fail", "error"],
      ["sentinel", "pass"],
    ],
  );
  assert.match(record.checks[0]?.reason ?? "", /checker exceeded the 20ms execution timeout/);
});
