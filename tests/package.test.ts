import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { createFakePi, makeTempDir } from "./helpers/fake-pi-control.ts";

const root = join(import.meta.dirname, "..");
const distEntry = join(root, "dist", "cli.js");
const sourceEntry = join(root, "src", "cli.ts");

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runEntry(
  entry: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly TMPDIR: string },
): Promise<CliResult> {
  const child = spawn(process.execPath, [entry, ...args], {
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

test("package metadata and built runtime assets point at the sole CLI implementation", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    files?: readonly string[];
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.bin?.["agent-evals"], "dist/cli.js");
  assert.equal(pkg.scripts?.eval, "node dist/cli.js");
  assert.deepEqual(pkg.files, ["dist"]);

  const cli = await readFile(distEntry, "utf8");
  assert.ok(cli.startsWith("#!/usr/bin/env node\n"), "dist/cli.js must keep its executable shebang");
  for (const asset of [
    "dist/checkers/file/regex-worker.js",
    "dist/engine/runtime-assets.js",
    "dist/runners/pi/supervisor.js",
    "dist/runners/pi/safe-process-group.js",
    "dist/runners/pi/shell-wrapper.sh",
  ]) {
    await readFile(join(root, asset));
  }
});

test("source and built CLIs produce identical help and view output", async (t) => {
  const directory = await makeTempDir(t, "ae-package-view-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: "task",
      checks: [{ $type: "file", path: "hello.txt", exists: true }],
      cases: {
        named: { runner: { $type: "pi", model: "test/model" } },
      },
    }),
  );
  const cwd = await makeTempDir(t, "ae-package-cwd-");
  const tempParent = await makeTempDir(t, "ae-package-runs-");

  for (const args of [["--help"], ["view", configPath, "--case", "named"]]) {
    const source = await runEntry(sourceEntry, args, { cwd, TMPDIR: tempParent });
    const built = await runEntry(distEntry, args, { cwd, TMPDIR: tempParent });
    assert.equal(built.code, source.code, built.stderr);
    assert.equal(built.stdout, source.stdout);
    assert.equal(built.stderr, source.stderr);
  }
});

test("built CLI runs packaged supervisor, wrapper, regex worker, and judge assets", async (t) => {
  const fake = await createFakePi(t, "record-tools");
  const judge = await createFakePi(t, "judge-valid");
  const directory = await makeTempDir(t, "ae-package-run-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: 'Create hello.txt with exactly the content "Hello, world!".',
      checks: [
        { $type: "file", path: "hello.txt", exists: true, matches: "^Hello, world!\\n?$" },
        {
          $type: "file",
          path: "tools.json",
          matches: [
            '"supervisor\\.js"',
            '"safe-process-group\\.js"',
            '"shell-wrapper\\.sh"',
            '"shellHasStateDir":true',
            "^(?!.*\\.ts).*$",
          ],
        },
        {
          $type: "judge",
          model: "test/judge-model",
          file: "hello.txt",
          rubric: ["hello.txt exists and contains Hello, world!."],
          executable: judge.executable,
        },
      ],
      cases: {
        packaged: {
          runner: {
            $type: "pi",
            model: "test/model",
            thinking: "low",
            executable: fake.executable,
          },
        },
      },
    }),
  );
  const cwd = await makeTempDir(t, "ae-package-run-cwd-");
  const resultsDir = await makeTempDir(t, "ae-package-results-");
  const tempParent = await makeTempDir(t, "ae-package-run-tmp-");

  const result = await runEntry(distEntry, ["run", configPath, "--case", "packaged", "--results-dir", resultsDir], {
    cwd,
    TMPDIR: tempParent,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /run .*: pass/);
  assert.deepEqual(await readdir(tempParent), []);

  const runDirectories = await readdir(resultsDir);
  assert.equal(runDirectories.length, 1);
  const record = JSON.parse(await readFile(join(resultsDir, runDirectories[0] ?? "", "result.json"), "utf8")) as {
    status: string;
    case: { path: string; name?: string };
    resolvedConfig: { runner: { model?: string } };
    cleanup: { status: string };
    checks: readonly { status: string; checker: string }[];
  };
  assert.equal(record.status, "pass");
  assert.equal(record.case.path, configPath);
  assert.equal(record.case.name, "packaged");
  assert.equal(record.resolvedConfig.runner.model, "test/model");
  assert.equal(record.cleanup.status, "removed");
  assert.deepEqual(
    record.checks.map((check) => check.status),
    ["pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass"],
  );
  assert.ok(record.checks.some((check) => check.checker === "judge"));
});
