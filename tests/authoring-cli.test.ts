import assert from "node:assert/strict";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import type { EvaluationRecord } from "../src/engine/results.ts";
import { runCliProcess } from "./helpers/cli-process.ts";
import { createFakePi, makeTempDir, type FakePi } from "./helpers/fake-pi-control.ts";

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  t: Parameters<typeof makeTempDir>[0],
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly TMPDIR: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly unsetEnv?: readonly string[];
  },
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, TMPDIR: options.TMPDIR };
  for (const name of options.unsetEnv ?? []) {
    delete env[name];
  }
  return runCliProcess(t, join(import.meta.dirname, "..", "src", "cli.ts"), args, { cwd: options.cwd, env });
}

/** A harness stand-in that announces itself if anything launches it. */
async function createCanaryPi(fake: FakePi): Promise<string> {
  const executable = join(fake.directory, "canary-pi.sh");
  await writeFile(executable, '#!/bin/sh\necho "CANARY-LAUNCHED"\nexit 0\n');
  await chmod(executable, 0o755);
  return executable;
}

function extractResolvedYaml(stdout: string): unknown {
  const lines = stdout.split("\n");
  const start = lines.indexOf("resolved configuration:");
  const end = lines.indexOf("field origins:");
  assert.ok(start >= 0 && end > start, `unexpected view output:\n${stdout}`);
  const body = lines
    .slice(start + 1, end)
    .map((line) => line.replace(/^ {2}/, ""))
    .join("\n");
  return parse(body);
}

test("view succeeds without Pi or credentials and annotates common versus selected fields", async (t) => {
  const fake = await createFakePi(t, "success");
  const canary = await createCanaryPi(fake);
  const directory = await makeTempDir(t, "ae-view-");
  const configPath = join(directory, "case.yml");
  const lines = [
    'input: Create hello.txt with exactly the content "Hello, world!".',
    "timeoutMs: 120000",
    "checks:",
    "  - $type: file",
    "    path: hello.txt",
    "    exists: true",
    "cases:",
    "  with-skill:",
    "    runner:",
    "      $type: pi",
    "      model: test/model",
    `      executable: ${canary}`,
    "      envPassthrough: [AE_VIEW_SECRET]",
    "      skills: [skill]",
    "  without-skill:",
    "    runner:",
    "      $type: pi",
    "      model: test/model",
    `      executable: ${canary}`,
    "      envPassthrough: [AE_VIEW_SECRET]",
    "      skills: []",
  ];
  await writeFile(configPath, lines.join("\n") + "\n");
  const cwd = await makeTempDir(t, "ae-view-cwd-");
  const emptyPath = await makeTempDir(t, "ae-empty-path-");
  const result = await runCli(t, ["view", configPath, "--case", "with-skill"], {
    cwd,
    TMPDIR: cwd,
    env: { PATH: emptyPath, AE_VIEW_SECRET: "view-secret-value" },
    unsetEnv: ["OPENCODE_API_KEY"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^case: "with-skill"$/m);
  assert.match(result.stdout, new RegExp(`^  input: common ${escapeRegExp(configPath)}:1$`, "m"));
  assert.match(result.stdout, new RegExp(`^  timeoutMs: common ${escapeRegExp(configPath)}:2$`, "m"));
  assert.match(result.stdout, new RegExp(`^  checks: common ${escapeRegExp(configPath)}:3$`, "m"));
  assert.match(result.stdout, new RegExp(`^  runner: case "with-skill" ${escapeRegExp(configPath)}:9$`, "m"));
  assert.doesNotMatch(result.stdout, /view-secret-value/);
  assert.doesNotMatch(result.stdout, /CANARY-LAUNCHED/);
});

test("view escapes control characters in selected case labels", async (t) => {
  const name = 'line\nbreak\u0007 "quoted"\nfield origins:\n  spoof: yes';
  const directory = await makeTempDir(t, "ae-view-control-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      checks: [{ $type: "file", path: "hello.txt", exists: true }],
      cases: { [name]: { runner: { $type: "pi", model: "test/model" } } },
    }),
  );
  const cwd = await makeTempDir(t, "ae-view-control-cwd-");

  const result = await runCli(t, ["view", configPath, "--case", name], { cwd, TMPDIR: cwd });
  assert.equal(result.code, 0, result.stderr);
  const expected = JSON.stringify(name);
  const lines = result.stdout.split("\n");
  assert.ok(lines.includes(`case: ${expected}`), result.stdout);
  assert.ok(
    lines.some((line) => line.startsWith(`  runner: case ${expected} ${configPath}:`)),
    result.stdout,
  );
  assert.equal(lines.filter((line) => line === "field origins:").length, 1);
  assert.ok(!lines.includes("  spoof: yes"), result.stdout);
  assert.ok(!result.stdout.includes("\u0007"));
});

test("view and run resolve the same configuration payload", async (t) => {
  const fake = await createFakePi(t, "success");
  const directory = await makeTempDir(t, "ae-shared-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    [
      'input: Create hello.txt with exactly the content "Hello, world!".',
      "checks:",
      "  - $type: file",
      "    path: hello.txt",
      "    exists: true",
      "runner:",
      "  $type: pi",
      "  model: test/model",
      "  thinking: low",
      `  executable: ${fake.executable}`,
    ].join("\n") + "\n",
  );
  const cwd = await makeTempDir(t, "ae-shared-cwd-");
  const tempParent = await makeTempDir(t, "ae-shared-runs-");
  const resultsDir = await makeTempDir(t, "ae-shared-results-");

  const viewed = await runCli(t, ["view", configPath], { cwd, TMPDIR: tempParent });
  assert.equal(viewed.code, 0, viewed.stderr);
  const viewedConfig = extractResolvedYaml(viewed.stdout);

  const ran = await runCli(t, ["run", configPath, "--results-dir", resultsDir], { cwd, TMPDIR: tempParent });
  assert.equal(ran.code, 0, ran.stderr);

  const runDirectories = await readdir(resultsDir);
  assert.equal(runDirectories.length, 1);
  const record = JSON.parse(
    await readFile(join(resultsDir, runDirectories[0] ?? "", "result.json"), "utf8"),
  ) as EvaluationRecord;
  assert.deepEqual(viewedConfig, record.resolvedConfig);
  assert.deepEqual(await readdir(tempParent), []);
});

test("a run records the resolved configuration, source, and metadata-only case name", async (t) => {
  const fake = await createFakePi(t, "success");
  const directory = await makeTempDir(t, "ae-retain-");
  const configPath = join(directory, "case.yml");
  const original = [
    'input: Create hello.txt with exactly the content "Hello, world!".',
    "cases:",
    '  "../retained-name":',
    "    runner:",
    "      $type: pi",
    "      model: test/original-model",
    "      thinking: low",
    `      executable: ${fake.executable}`,
    "      envPassthrough: [AE_RUN_SECRET]",
    "    checks:",
    "      - $type: file",
    "        path: hello.txt",
    "        exists: true",
  ];
  await writeFile(configPath, original.join("\n") + "\n");
  const cwd = await makeTempDir(t, "ae-retain-cwd-");
  const tempParent = await makeTempDir(t, "ae-retain-runs-");
  const resultsDir = await makeTempDir(t, "ae-retain-results-");

  const previous = process.env.AE_RUN_SECRET;
  process.env.AE_RUN_SECRET = "value-that-must-not-be-retained";
  try {
    const result = await runCli(t, ["run", configPath, "--case", "../retained-name", "--results-dir", resultsDir], {
      cwd,
      TMPDIR: tempParent,
    });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    if (previous === undefined) {
      delete process.env.AE_RUN_SECRET;
    } else {
      process.env.AE_RUN_SECRET = previous;
    }
  }

  const runDirectories = await readdir(resultsDir);
  assert.equal(runDirectories.length, 1);
  assert.ok(!(runDirectories[0] ?? "").includes(".."));
  assert.ok(!(runDirectories[0] ?? "").includes("/"));
  const resultPath = join(resultsDir, runDirectories[0] ?? "", "result.json");
  const resultText = await readFile(resultPath, "utf8");
  const record = JSON.parse(resultText) as EvaluationRecord;

  assert.equal(record.case.path, configPath);
  assert.equal(record.case.name, "../retained-name");
  assert.equal(record.resolvedConfig.input, original[0]?.replace("input: ", ""));
  assert.equal(record.resolvedConfig.runner.model, "test/original-model");
  assert.match(resultText, /AE_RUN_SECRET/);
  assert.doesNotMatch(resultText, /value-that-must-not-be-retained/);

  // Editing the authoring file later must not rewrite the retained run parameters.
  await writeFile(
    configPath,
    original
      .join("\n")
      .replace("test/original-model", "test/changed-model")
      .replace("Create hello.txt", "Do something else") + "\n",
  );
  const saved = JSON.parse(await readFile(resultPath, "utf8")) as EvaluationRecord;
  assert.equal(saved.resolvedConfig.runner.model, "test/original-model");
  assert.match(saved.resolvedConfig.input, /Create hello\.txt/);
  assert.deepEqual(await readdir(tempParent), []);
});

test("view reports configuration errors with exit code 2", async (t) => {
  const directory = await makeTempDir(t, "ae-view-error-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    [
      "input: task",
      "cases:",
      "  one:",
      "    runner:",
      "      $type: pi",
      "    checks:",
      "      - $type: file",
      "        path: hello.txt",
      "        exists: true",
    ].join("\n") + "\n",
  );
  const cwd = await makeTempDir(t, "ae-view-error-cwd-");

  const result = await runCli(t, ["view", configPath, "--case", "missing"], { cwd, TMPDIR: cwd });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /configuration error: .*has no case named "missing"/);
});

test("CLI rejects unknown YAML tags before runtime", async (t) => {
  const directory = await makeTempDir(t, "ae-view-tag-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    [
      "input: !include injected.txt",
      "runner:",
      "  $type: pi",
      "  model: test/model",
      "checks:",
      "  - $type: file",
      "    path: hello.txt",
      "    exists: true",
    ].join("\n") + "\n",
  );
  const cwd = await makeTempDir(t, "ae-view-tag-cwd-");

  const result = await runCli(t, ["view", configPath], { cwd, TMPDIR: cwd });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unsupported YAML.*Unresolved tag/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
