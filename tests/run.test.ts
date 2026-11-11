import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { ConfigError, loadCandidate, loadCase } from "../src/engine/config.ts";
import { addChecker, addRunner, createRegistry } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import type { EvaluationRecord } from "../src/engine/results.ts";
import { fileChecker } from "../src/checkers/file/checker.ts";
import { judgeChecker } from "../src/checkers/judge/checker.ts";
import { piRunner } from "../src/runners/pi/runner.ts";
import { createFakePi, makeTempDir } from "./helpers/fake-pi-control.ts";

interface ScenarioOptions {
  readonly runnerExecutable: string;
  readonly judgeExecutable?: string;
  readonly checks?: readonly Record<string, unknown>[];
  readonly fixtureFiles?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly skill?: boolean;
}

async function writeScenario(t: Parameters<typeof makeTempDir>[0], options: ScenarioOptions) {
  const directory = await makeTempDir(t, "ae-scenario-");
  const casePath = join(directory, "case.yml");
  const candidatePath = join(directory, "candidate.yml");
  const checks = options.checks ?? [
    { $type: "file", path: "hello.txt", exists: true, matches: "^Hello, world!\\n?$" },
    {
      $type: "judge",
      model: "test/judge-model",
      thinking: "low",
      file: "hello.txt",
      rubric: ["hello.txt exists and contains Hello, world!."],
      executable: options.judgeExecutable,
    },
  ];
  if (options.fixtureFiles !== undefined) {
    const fixtureDir = join(directory, "fixture");
    await mkdir(fixtureDir, { recursive: true });
    for (const [name, content] of Object.entries(options.fixtureFiles)) {
      await writeFile(join(fixtureDir, name), content);
    }
  }
  await writeFile(
    casePath,
    stringify({
      input: "Create hello.txt with exactly the content \"Hello, world!\".",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.fixtureFiles === undefined ? {} : { fixture: "fixture" }),
      checks,
    }),
  );
  if (options.skill === true) {
    await mkdir(join(directory, "skill"));
    await writeFile(join(directory, "skill", "SKILL.md"), "---\nname: tiny-write\ndescription: Write a file.\n---\n\nWrite it.\n");
  }
  await writeFile(
    candidatePath,
    stringify({
      name: "integration",
      runner: {
        $type: "pi",
        model: "test/model",
        thinking: "low",
        executable: options.runnerExecutable,
        ...(options.skill === true ? { skills: ["skill"] } : {}),
      },
    }),
  );
  return { directory, casePath, candidatePath };
}

test("runtime baseline is Node.js 24 or newer", () => {
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  assert.ok(major >= 24, `expected Node.js >=24, running ${process.versions.node}`);
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
    candidate: await loadCandidate(scenario.candidatePath),
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
  assert.deepEqual(record.checks.map((check) => check.status), ["pass", "pass", "pass"]);
  assert.equal(record.cleanup.status, "removed");
  assert.deepEqual(await readdir(tempParent), []);
  assert.equal(await readFile(join(fixtureScenario, "seed.txt"), "utf8"), "keep me\n");

  const saved = JSON.parse(await readFile(join(resultsDir, record.runId, "result.json"), "utf8")) as EvaluationRecord;
  assert.equal(saved.status, "pass");
  assert.equal(saved.runId, record.runId);
});

test("integration: unchanged uses the engine baseline, which is outside agent access", async (t) => {
  const runner = await createFakePi(t, "probe-baseline");
  const { record, tempParent } = await runScenario(t, {
    runnerExecutable: runner.executable,
    fixtureFiles: { "seed.txt": "keep me\n" },
    checks: [
      { $type: "file", path: "seed.txt", unchanged: true },
      { $type: "file", path: "probe.txt", matches: "EPERM|EACCES|ENOENT" },
    ],
  });

  assert.equal(record.status, "pass", record.error);
  assert.deepEqual(record.checks.map((check) => check.status), ["pass", "pass"]);
  assert.deepEqual(await readdir(tempParent), []);
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
    checks: [{ $type: "file", path: "hello.txt", matches: "(" }],
  });
  const resultsDir = await makeTempDir(t, "ae-results-invalid-");
  const tempParent = await makeTempDir(t, "ae-runs-invalid-");
  const loadedCase = await loadCase(scenario.casePath);
  const candidate = await loadCandidate(scenario.candidatePath);

  await assert.rejects(
    () =>
      runEvaluation({
        case: loadedCase,
        candidate,
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
  const candidateConfig = await loadCandidate(scenario.candidatePath);
  const modified = {
    ...candidateConfig,
    config: {
      ...candidateConfig.config,
      runner: { ...candidateConfig.config.runner, skills: ["missing-skill"] },
    },
  };
  const resultsDir = await makeTempDir(t, "ae-results-missing-");
  const tempParent = await makeTempDir(t, "ae-runs-missing-");
  const loadedCase = await loadCase(scenario.casePath);

  await assert.rejects(
    () =>
      runEvaluation({
        case: loadedCase,
        candidate: modified,
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

  const result = await runCli(
    ["--case", scenario.casePath, "--candidate", scenario.candidatePath, "--results-dir", resultsDir],
    { cwd, TMPDIR: tempParent },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /run .*: pass/);
  assert.deepEqual(await readdir(tempParent), []);

  const runDirectories = await readdir(resultsDir);
  assert.equal(runDirectories.length, 1);
  const record = JSON.parse(
    await readFile(join(resultsDir, runDirectories[0] ?? "", "result.json"), "utf8"),
  ) as EvaluationRecord;
  assert.equal(record.status, "pass");
  assert.equal(record.candidate.name, "integration");
});

test("integration: CLI reports configuration errors with exit code 2", async (t) => {
  const runner = await createFakePi(t, "success");
  const scenario = await writeScenario(t, {
    runnerExecutable: runner.executable,
    checks: [{ $type: "not-a-checker", path: "hello.txt" }],
  });
  const resultsDir = await makeTempDir(t, "ae-cli-invalid-results-");
  const tempParent = await makeTempDir(t, "ae-cli-invalid-runs-");

  const result = await runCli(
    ["--case", scenario.casePath, "--candidate", scenario.candidatePath, "--results-dir", resultsDir],
    { cwd: scenario.directory, TMPDIR: tempParent },
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /configuration error: unknown checker implementation/);
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

  const child = spawn(
    process.execPath,
    ["src/cli.ts", "--case", scenario.casePath, "--candidate", scenario.candidatePath, "--results-dir", resultsDir],
    { cwd: process.cwd(), env: { ...process.env, TMPDIR: tempParent }, stdio: ["ignore", "pipe", "pipe"] },
  );
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

async function runCli(
  args: string[],
  options: { cwd: string; TMPDIR: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
  const code = await new Promise<number | null>((resolve) => child.on("exit", (value) => resolve(value)));
  return { code, stdout, stderr };
}
