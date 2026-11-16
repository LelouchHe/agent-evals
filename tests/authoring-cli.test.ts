import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

test("view succeeds without Pi or environment values and annotates common versus selected fields", async (t) => {
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
    "      skills: [skill]",
    "  without-skill:",
    "    runner:",
    "      $type: pi",
    "      model: test/model",
    `      executable: ${canary}`,
    "      skills: []",
  ];
  await writeFile(configPath, lines.join("\n") + "\n");
  const cwd = await makeTempDir(t, "ae-view-cwd-");
  const lookupMarker = join(cwd, "lookup-command-ran");
  await writeFile(join(cwd, ".env"), `OPENCODE_API_KEY="!touch ${lookupMarker}"\n`);
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
  await assert.rejects(() => access(lookupMarker), /ENOENT/);
});

test("view shows placeholders and escaped literals as declared without reading .env", async (t) => {
  const cwd = await makeTempDir(t, "ae-view-refs-cwd-");
  const directory = await makeTempDir(t, "ae-view-refs-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    [
      "input: task",
      "runner:",
      "  $type: pi",
      "  model: p/m",
      "  apiKey: ${env:MY_KEY}",
      "  literal: $${env:MY_KEY}",
      "checks:",
      "  - $type: file",
      "    path: hello.txt",
      "    exists: true",
    ].join("\n") + "\n",
  );
  const marker = join(cwd, "lookup-ran");
  await writeFile(join(cwd, ".env"), `MY_KEY="!touch ${marker}"\n`);

  const result = await runCli(t, ["view", configPath], { cwd, TMPDIR: cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^ {4}apiKey: \$\{env:MY_KEY\}$/m);
  assert.match(result.stdout, /^ {4}literal: \$\$\{env:MY_KEY\}$/m);
  await assert.rejects(() => access(marker), /ENOENT/);
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
    "      model: opencode-go/original-model",
    "      apiKey: ${env:MY_KEY}",
    "      thinking: low",
    `      executable: ${fake.executable}`,
    "    checks:",
    "      - $type: file",
    "        path: hello.txt",
    "        exists: true",
  ];
  await writeFile(configPath, original.join("\n") + "\n");
  const cwd = await makeTempDir(t, "ae-retain-cwd-");
  const tempParent = await makeTempDir(t, "ae-retain-runs-");
  const resultsDir = await makeTempDir(t, "ae-retain-results-");

  await writeFile(join(cwd, ".env"), "MY_KEY=value-that-must-not-be-retained\n");
  const result = await runCli(t, ["run", configPath, "--case", "../retained-name", "--results-dir", resultsDir], {
    cwd,
    TMPDIR: tempParent,
  });
  assert.equal(result.code, 0, result.stderr);

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
  assert.equal(record.resolvedConfig.runner.model, "opencode-go/original-model");
  assert.equal(record.resolvedConfig.runner.apiKey, "${env:MY_KEY}");
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
  assert.equal(saved.resolvedConfig.runner.model, "opencode-go/original-model");
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

test("CLI reports help and built-in argument errors with exit code 2", async (t) => {
  const directory = await makeTempDir(t, "ae-cli-grammar-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      checks: [{ $type: "file", path: "hello.txt", exists: true }],
      runner: { $type: "pi", model: "test/model" },
    }),
  );
  const cwd = await makeTempDir(t, "ae-cli-grammar-cwd-");

  const help = await runCli(t, ["--help"], { cwd, TMPDIR: cwd });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Usage: agent-evals/);
  assert.match(help.stdout, /default: \.agent-evals/);

  const missingValue = await runCli(t, ["view", configPath, "--case"], { cwd, TMPDIR: cwd });
  assert.equal(missingValue.code, 2);
  assert.match(missingValue.stderr, /Option '--case <value>' argument missing/);

  const unknown = await runCli(t, ["view", configPath, "--unknown"], { cwd, TMPDIR: cwd });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown option '--unknown'/);

  const extra = await runCli(t, ["view", configPath, "extra"], { cwd, TMPDIR: cwd });
  assert.equal(extra.code, 2);
  assert.match(extra.stderr, /unexpected argument: extra/);

  const runOnly = await runCli(t, ["view", configPath, "--results-dir", join(directory, "results")], {
    cwd,
    TMPDIR: cwd,
  });
  assert.equal(runOnly.code, 2);
  assert.match(runOnly.stderr, /view does not accept --results-dir or --extension-dir/);
});

test("CLI accepts equals values and a dash-prefixed config path after --", async (t) => {
  const cwd = await makeTempDir(t, "ae-cli-dash-cwd-");
  const caseName = "-selected";
  await writeFile(
    join(cwd, "-case.yml"),
    stringify({
      input: "task",
      cases: {
        [caseName]: {
          checks: [{ $type: "file", path: "hello.txt", exists: true }],
          runner: { $type: "pi", model: "test/model" },
        },
      },
    }),
  );

  const result = await runCli(t, ["view", `--case=${caseName}`, "--", "-case.yml"], { cwd, TMPDIR: cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^case: ${escapeRegExp(JSON.stringify(caseName))}$`, "m"));
});

test("CLI loads repeated extension roots and writes to the default results root", async (t) => {
  const zodUrl = import.meta.resolve("zod");
  const runnerRootA = await makeTempDir(t, "ae-cli-runner-a-");
  const runnerRootB = await makeTempDir(t, "ae-cli-runner-b-");
  const checkerRootA = await makeTempDir(t, "ae-cli-checker-a-");
  const checkerRootB = await makeTempDir(t, "ae-cli-checker-b-");
  const checkerModule = (type: string) => `import { z } from ${JSON.stringify(zodUrl)};
export const checker = {
  type: ${JSON.stringify(type)},
  params: z.strictObject({}),
  async create() {
    return {
      async check() {
        return [{ checker: ${JSON.stringify(type)}, subject: ${JSON.stringify(`checker:${type}`)}, status: "pass", reason: "ok" }];
      },
    };
  },
};
`;
  await mkdir(join(runnerRootA, "unused"));
  await writeFile(
    join(runnerRootA, "unused", "index.mjs"),
    `import { z } from ${JSON.stringify(zodUrl)};
export const runner = { type: "unused-runner", params: z.strictObject({}), async create() { return { async run() { return { finalText: "unused", diagnostics: [] }; }, async stop() {} }; } };
`,
  );
  // An implementation root may hold dependencies; node_modules is skipped.
  await mkdir(join(runnerRootA, "node_modules", "dependency"), { recursive: true });
  await writeFile(join(runnerRootA, "node_modules", "dependency", "index.mjs"), "export const other = 1;\n");

  // An implementation is a directory: index.ts plus a helper it imports.
  await mkdir(join(runnerRootB, "used"));
  await writeFile(join(runnerRootB, "used", "helper.ts"), 'export const label = "external-runner";\n');
  await writeFile(
    join(runnerRootB, "used", "index.ts"),
    `import { z } from ${JSON.stringify(zodUrl)};
import { label } from "./helper.ts";
export const runner = {
  type: label,
  params: z.strictObject({}),
  async create() {
    return {
      async run() { return { finalText: \`runner:\${label}\`, diagnostics: [] }; },
      async stop() {},
    };
  },
};
`,
  );

  await mkdir(join(checkerRootA, "used"));
  await writeFile(join(checkerRootA, "used", "index.mjs"), checkerModule("external-checker"));
  await mkdir(join(checkerRootB, "unused"));
  await writeFile(join(checkerRootB, "unused", "index.mjs"), checkerModule("unused-checker"));

  const directory = await makeTempDir(t, "ae-cli-default-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      timeoutMs: 5_000,
      checks: [{ $type: "external-checker" }],
      runner: { $type: "external-runner" },
    }),
  );
  const cwd = await makeTempDir(t, "ae-cli-default-cwd-");
  const tempParent = await makeTempDir(t, "ae-cli-default-tmp-");
  const result = await runCli(
    t,
    [
      "run",
      configPath,
      "--extension-dir",
      runnerRootA,
      "--extension-dir",
      runnerRootB,
      "--extension-dir",
      checkerRootA,
      "--extension-dir",
      checkerRootB,
    ],
    { cwd, TMPDIR: tempParent },
  );
  assert.equal(result.code, 0, result.stderr);

  const resultsDir = join(cwd, ".agent-evals");
  const runDirectories = await readdir(resultsDir);
  assert.equal(runDirectories.length, 1);
  const record = JSON.parse(
    await readFile(join(resultsDir, runDirectories[0] ?? "", "result.json"), "utf8"),
  ) as EvaluationRecord;
  assert.equal(record.status, "pass", record.error);
  assert.equal(record.runner.finalText, "runner:external-runner");
  assert.equal(record.checks[0]?.subject, "checker:external-checker");
  assert.match(result.stdout, /results: .*\/\.agent-evals\/[^/]+\/result\.json/);
  assert.deepEqual(await readdir(tempParent), []);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
