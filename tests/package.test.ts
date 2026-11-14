import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { runCliProcess } from "./helpers/cli-process.ts";
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
  t: Parameters<typeof makeTempDir>[0],
  entry: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly TMPDIR: string },
): Promise<CliResult> {
  return runCliProcess(t, entry, args, {
    cwd: options.cwd,
    env: { ...process.env, TMPDIR: options.TMPDIR },
  });
}

test("package metadata and built runtime assets point at the sole CLI implementation", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    files?: readonly string[];
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.bin?.["agent-evals"], "dist/cli.js");
  assert.equal(pkg.scripts?.eval, "node dist/cli.js");
  assert.deepEqual(pkg.files, ["dist", ".env.example"]);

  const cli = await readFile(distEntry, "utf8");
  assert.ok(cli.startsWith("#!/usr/bin/env node\n"), "dist/cli.js must keep its executable shebang");
  for (const asset of [
    "dist/checkers/file/regex-worker.js",
    "dist/engine/forwarder.sh",
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
    const source = await runEntry(t, sourceEntry, args, { cwd, TMPDIR: tempParent });
    const built = await runEntry(t, distEntry, args, { cwd, TMPDIR: tempParent });
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

  const result = await runEntry(t, distEntry, ["run", configPath, "--case", "packaged", "--results-dir", resultsDir], {
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

/** Run one command to completion, keeping its last stderr line for the failure message. */
async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) resolve();
      else reject(new Error(`${command} ${args[0] ?? ""} failed: ${stderr.trim() || error.message}`));
    });
  });
}

test(
  "the packed artifact carries the forwarder its own host loads",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const packDir = await makeTempDir(t, "ae-pack-");
    await run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], root);
    const [tarball] = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
    assert.ok(tarball !== undefined, "npm pack produced a tarball");
    await run("/usr/bin/tar", ["-xzf", join(packDir, tarball), "-C", packDir], packDir);
    const packageRoot = join(packDir, "package");
    const mocksModule = pathToFileURL(join(packageRoot, "dist", "engine", "mocks.js"));
    // The host must resolve the asset beside itself inside the package, not from this worktree.
    assert.equal(
      fileURLToPath(new URL("./forwarder.sh", mocksModule)),
      join(packageRoot, "dist", "engine", "forwarder.sh"),
    );
    await readFile(join(packageRoot, "dist", "engine", "forwarder.sh"), "utf8");

    const { startMockHost } = (await import(mocksModule.href)) as typeof import("../src/engine/mocks.ts");
    const runRoot = join(packDir, "run");
    await mkdir(runRoot);
    const host = await startMockHost({
      runRootDir: runRoot,
      shell: { release: { exitCode: 4, stdout: "packed out\n", stderr: "packed err\n" } },
    });
    const calls = [];
    for (const args of [["--now", ""], ["next"]]) {
      const child = spawn(join(host.wiring.forwarderDir, "release"), args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: [Buffer[], Buffer[]] = [[], []];
      child.stdout.on("data", (chunk: Buffer) => chunks[0].push(chunk));
      child.stderr.on("data", (chunk: Buffer) => chunks[1].push(chunk));
      const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
      calls.push({
        status,
        stdout: Buffer.concat(chunks[0]).toString("utf8"),
        stderr: Buffer.concat(chunks[1]).toString("utf8"),
      });
    }
    const mockRecords = await host.close();

    assert.deepEqual(calls, [
      { status: 4, stdout: "packed out\n", stderr: "packed err\n" },
      { status: 4, stdout: "packed out\n", stderr: "packed err\n" },
    ]);
    assert.deepEqual(mockRecords, [
      { target: "release", arguments: ["--now", ""] },
      { target: "release", arguments: ["next"] },
    ]);
  },
);
