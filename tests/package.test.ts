import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { isSandboxPlatformSupported } from "../src/platform/index.ts";
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

/** Every file beneath a directory whose name ends with the suffix. */
async function filesEndingWith(directory: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesEndingWith(path, suffix)));
    else if (entry.name.endsWith(suffix)) found.push(path);
  }
  return found;
}

test("package metadata and built runtime assets point at the sole CLI implementation", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name?: string;
    os?: readonly string[];
    bin?: Record<string, string>;
    files?: readonly string[];
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.name, "@lelouchhe/agent-evals");
  assert.deepEqual(pkg.os, ["darwin", "linux", "win32"]);
  assert.equal(pkg.bin?.["agent-evals"], "dist/cli.js");
  assert.equal(pkg.scripts?.eval, "node dist/cli.js");
  assert.deepEqual(pkg.files, ["dist", ".env.example"]);

  // Published declarations must import the JavaScript beside them, not source `.ts` specifiers
  // that a consumer's TypeScript only resolves by substitution.
  for (const declaration of await filesEndingWith(join(root, "dist"), ".d.ts")) {
    assert.doesNotMatch(
      await readFile(declaration, "utf8"),
      /(from\s*|import\()["']\.[^"']*\.ts["']/u,
      `${declaration} keeps a .ts import specifier`,
    );
  }

  const cli = await readFile(distEntry, "utf8");
  assert.ok(cli.startsWith("#!/usr/bin/env node\n"), "dist/cli.js must keep its executable shebang");
  for (const asset of [
    "dist/engine/check-runner.js",
    "dist/engine/forwarder.sh",
    "dist/engine/forwarder.cmd",
    "dist/engine/forwarder.ps1",
    "dist/engine/regex.js",
    "dist/engine/runtime-assets.js",
    "dist/platform/posix-forwarder-client.mjs",
    "dist/platform/windows/forwarder-client.mjs",
    "dist/platform/macos/supervisor.sh",
    "dist/runners/pi/supervisor.js",
    "dist/runners/pi/safe-process-group.js",
    "dist/runners/pi/shell-wrapper.sh",
  ]) {
    await readFile(join(root, asset));
  }
});

test("--version and -V print the package version from both source and built CLI", async (t) => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  const cwd = await makeTempDir(t, "ae-version-cwd-");
  const tempParent = await makeTempDir(t, "ae-version-tmp-");

  for (const [entry, flag] of [
    [sourceEntry, "--version"],
    [distEntry, "--version"],
    [distEntry, "-V"],
  ] as const) {
    const result = await runEntry(t, entry, [flag], { cwd, TMPDIR: tempParent });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg.version);
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

test("built CLI runs packaged supervisor, wrapper, and judge assets", async (t) => {
  const fake = await createFakePi(t, "record-tools");
  const judge = await createFakePi(t, "judge-valid");
  const directory = await makeTempDir(t, "ae-package-run-");
  const configPath = join(directory, "case.yml");
  await writeFile(
    configPath,
    stringify({
      input: 'Create hello.txt with exactly the content "Hello, world!".',
      checks: [
        { $type: "file", path: "hello.txt", exists: true, matches: "/^Hello, world!\\n?$/" },
        {
          $type: "file",
          path: "tools.json",
          matches: [
            '"supervisor.js"',
            '"safe-process-group.js"',
            ...(process.platform === "win32" ? [] : ['"shell-wrapper.sh"']),
            '"shellHasStateDir":true',
            // Every staged tool is a built .js/.sh asset, never a .ts source file.
            '/^\\{"names":\\["[a-z-]+\\.(js|sh)"(,"[a-z-]+\\.(js|sh)")*\\],"shellHasStateDir":true\\}$/',
          ],
        },
        {
          $type: "judge",
          runner: { $type: "pi", model: "test/judge-model", executable: judge.executable },
          files: ["hello.txt"],
          rubric: ["hello.txt exists and contains Hello, world!."],
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
    process.platform === "win32"
      ? ["pass", "pass", "pass", "pass", "pass", "pass", "pass"]
      : ["pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass"],
  );
  assert.ok(record.checks.some((check) => check.checker === "judge"));
});

/** Run one command to completion, keeping its last stderr line for the failure message. */
async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024, ...(process.platform === "win32" ? { shell: true } : {}) },
      (error, _stdout, stderr) => {
        if (error === null) resolve();
        else reject(new Error(`${command} ${args[0] ?? ""} failed: ${stderr.trim() || error.message}`));
      },
    );
  });
}

test(
  "the packed artifact carries the forwarder its own host loads",
  { skip: !isSandboxPlatformSupported },
  async (t) => {
    const packDir = await makeTempDir(t, "ae-pack-");
    await run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], root);
    const [tarball] = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
    assert.ok(tarball !== undefined, "npm pack produced a tarball");
    await run(
      process.platform === "win32" ? "tar" : "/usr/bin/tar",
      ["-xzf", join(packDir, tarball), "-C", packDir],
      packDir,
    );
    const packageRoot = join(packDir, "package");
    const mocksModule = pathToFileURL(join(packageRoot, "dist", "engine", "mocks.js"));
    // The host must resolve the asset beside itself inside the package, not from this worktree.
    assert.equal(
      fileURLToPath(new URL("./forwarder.sh", mocksModule)),
      join(packageRoot, "dist", "engine", "forwarder.sh"),
    );
    await readFile(join(packageRoot, "dist", "engine", "forwarder.sh"), "utf8");
    // A package resolves its declared dependency from its own tree; give the unpacked copy the
    // installed re2js the engine imports, so the test never falls back to this worktree.
    await cp(join(root, "node_modules", "re2js"), join(packageRoot, "node_modules", "re2js"), { recursive: true });

    const { startMockHost } = (await import(mocksModule.href)) as typeof import("../src/engine/mocks.ts");
    const runRoot = join(packDir, "run");
    await mkdir(runRoot);
    await mkdir(join(runRoot, "workspace"));
    await mkdir(join(runRoot, "tmp"));
    await mkdir(join(runRoot, "engine"));
    await mkdir(join(runRoot, "mocks"));
    const host = await startMockHost({
      runRootDir: runRoot,
      engineDir: join(runRoot, "engine"),
      mocksDir: join(runRoot, "mocks"),
      workspaceDir: join(runRoot, "workspace"),
      tmpDir: join(runRoot, "tmp"),
      authoringDir: packDir,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      shell: {
        release: [
          {
            action: { kind: "return", result: { exitCode: 4, stdout: "packed out\n", stderr: "packed err\n" } },
          },
        ],
      },
    });
    // Close once, however the test ends: a failed call must not leave the host listening.
    let closing: ReturnType<typeof host.close> | undefined;
    const closeHost = (): ReturnType<typeof host.close> => (closing ??= host.close());
    t.after(async () => {
      await closeHost().catch(() => {});
    });

    const calls = [];
    for (const args of [["--now", ""], ["next"]]) {
      calls.push(await callForwarder(join(host.wiring.forwarderDir, "release"), args));
    }
    const { records: mockRecords } = await closeHost();

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

/**
 * Run one generated forwarder to completion, keeping both streams and the exit status apart.
 * A spawn failure rejects instead of surfacing as an unhandled error, and no child survives it.
 */
async function callForwarder(
  path: string,
  args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const collect = async (stream: NodeJS.ReadableStream | null): Promise<string> => {
    if (stream === null) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [stdout, stderr] = await Promise.all([collect(child.stdout), collect(child.stderr)]);
    return { status: await exited, stdout, stderr };
  } catch (error) {
    child.kill("SIGKILL");
    await exited.catch(() => {});
    throw error;
  }
}
