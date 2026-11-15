import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { runCliProcess } from "./helpers/cli-process.ts";
import { createFakePi, makeTempDir } from "./helpers/fake-pi-control.ts";
import { makeAcpAgent } from "./helpers/acp-agent.ts";

// Deliberately separate from *.test.ts: npm run test:package performs an actual
// dependency installation and may need registry access, but never calls a model.
test("the packed CLI installs and runs without source or development dependencies", async (t) => {
  const npm = process.env.npm_execpath;
  assert.ok(npm, "Run this test through npm run test:package");
  const project = join(import.meta.dirname, "..");
  const root = await makeTempDir(t, "ae-installed-package-");
  const home = join(root, "home");
  const prefix = join(root, "install");
  const cwd = join(root, "invocation");
  const runtime = join(root, "runtime");
  await Promise.all([home, prefix, cwd, runtime].map((path) => mkdir(path)));
  const env = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: home,
    TMPDIR: root,
    npm_config_userconfig: "/dev/null",
    npm_config_update_notifier: "false",
  };
  const npmCommand = async (args: readonly string[], directory: string) => {
    const result = await runCliProcess(t, npm, args, { cwd: directory, env, timeoutMs: 60_000 });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  };

  // Make environment-file exclusion a reachable assertion without touching a
  // developer's real .env. The unique, ignored probe is removed even on failure.
  const probe = join(project, `.env.package-probe-${randomUUID()}`);
  await writeFile(probe, "PACKAGE_PROBE=synthetic-must-not-be-packed\n", { flag: "wx" });
  t.after(() => rm(probe, { force: true }));
  interface PackMetadata {
    filename: string;
    files: { path: string }[];
  }
  const metadata = JSON.parse(await npmCommand(["pack", "--json", "--pack-destination", root], project)) as
    PackMetadata[] | Record<string, PackMetadata>;
  // npm 12 keys records by package name; earlier npm releases return an array.
  const packs = Array.isArray(metadata) ? metadata : Object.values(metadata);
  assert.equal(packs.length, 1);
  const pack = packs[0];
  assert.ok(pack);
  assert.ok(pack.files.every(({ path }) => /^(dist\/|README\.md$|LICENSE$|package\.json$|\.env\.example$)/.test(path)));
  assert.ok(pack.files.some(({ path }) => path === ".env.example"));

  await npmCommand(
    ["install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", join(root, pack.filename)],
    cwd,
  );
  const installed = join(prefix, "node_modules", "agent-evals");
  const bin = join(prefix, "node_modules", ".bin", "agent-evals");
  const require = createRequire(join(installed, "package.json"));
  const installRoot = (await realpath(prefix)) + sep;
  for (const dependency of ["@agentclientprotocol/sdk", "re2js", "yaml", "zod"]) {
    assert.ok(
      (await realpath(require.resolve(dependency))).startsWith(installRoot),
      `${dependency} escaped the installation`,
    );
  }
  assert.deepEqual((await readdir(join(prefix, "node_modules"))).filter((name) => !name.startsWith(".")).sort(), [
    "@agentclientprotocol",
    "agent-evals",
    "re2js",
    "yaml",
    "zod",
  ]);
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  assert.equal(await hash(join(installed, "dist/cli.js")), await hash(join(project, "dist/cli.js")));
  assert.notEqual((await stat(bin)).mode & 0o111, 0);
  const help = spawnSync(bin, ["--help"], { cwd, env, encoding: "utf8", timeout: 5_000 });
  assert.equal(help.error, undefined);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: agent-evals/);
  await npmCommand(["run", "--silent", "prepare"], installed);

  const runner = await createFakePi(t, "runner-api-key-details");
  const judge = await createFakePi(t, "judge-api-key");
  const config = {
    input: "Create hello.txt with exactly the content Hello, world!.",
    timeoutMs: 5_000,
    runner: {
      $type: "pi",
      model: "opencode-go/test-model",
      apiKey: "${env:MY_KEY}",
      executable: runner.executable,
    },
    checks: [
      { $type: "file", path: "hello.txt", exists: true, matches: "^Hello, world!\\n?$" },
      {
        $type: "judge",
        model: "opencode-go/test-judge",
        apiKey: "${env:MY_KEY}",
        executable: judge.executable,
        file: "hello.txt",
        rubric: ["The file satisfies the task."],
      },
    ],
  };
  const configPath = join(cwd, "case.yml");
  await writeFile(configPath, stringify(config));
  await writeFile(join(cwd, ".env"), 'MY_KEY="!printf x >> count; printf synthetic-runner-key"\n');
  const invoke = async (entry: string, args: readonly string[]) =>
    runCliProcess(t, entry, args, {
      cwd,
      env: { ...env, TMPDIR: runtime },
      timeoutMs: 30_000,
    });
  if (process.platform === "darwin") {
    const agent = await makeAcpAgent(t);
    const queried = await invoke(bin, ["config", agent.path]);
    assert.equal(queried.code, 0, queried.stderr);
    assert.match(queried.stdout, /model-a/);
    const queriedBuilt = await invoke(join(project, "dist/cli.js"), ["config", agent.path]);
    assert.equal(queriedBuilt.code, 0, queriedBuilt.stderr);
    assert.deepEqual(parse(queried.stdout), parse(queriedBuilt.stdout));
    const loggedIn = await invoke(bin, ["login", agent.path]);
    assert.equal(loggedIn.code, 0, loggedIn.stderr);
    assert.equal(await readFile(join(agent.login, ".auth/token"), "utf8"), "synthetic-token");
  }
  const viewed = await invoke(bin, ["view", configPath]);
  const built = await invoke(join(project, "dist/cli.js"), ["view", configPath]);
  assert.equal(viewed.code, 0, viewed.stderr);
  assert.equal(viewed.stdout, built.stdout);
  assert.match(viewed.stdout, /apiKey: \${env:MY_KEY}/);
  assert.deepEqual(await readdir(runtime), []);
  assert.ok(!(await readdir(cwd)).includes("count"), "view executed the environment lookup command");

  const results = join(root, "results");
  const run = await invoke(bin, ["run", configPath, "--results-dir", results]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const ids = await readdir(results);
  assert.equal(ids.length, 1);
  const resultText = await readFile(join(results, ids[0] ?? "", "result.json"), "utf8");
  const record = JSON.parse(resultText) as {
    status: string;
    cleanup: { status: string };
    resolvedConfig: unknown;
    runner: { finalText: string | null };
    checks: { status: string }[];
  };
  assert.equal(record.status, "pass");
  assert.deepEqual(
    record.checks.map(({ status }) => status),
    ["pass", "pass", "pass"],
  );
  assert.equal(record.cleanup.status, "removed");
  assert.deepEqual(record.resolvedConfig, config);
  const details = JSON.parse(record.runner.finalText ?? "") as { apiKeyPresent: boolean; models: string };
  assert.equal(details.apiKeyPresent, true);
  assert.deepEqual(JSON.parse(details.models), {
    providers: { "opencode-go": { apiKey: "$AGENT_EVALS_PI_API_KEY" } },
  });
  assert.doesNotMatch(details.models, /synthetic-runner-key/);
  assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
  assert.doesNotMatch(resultText + run.stdout + run.stderr, /synthetic-runner-key/);
  assert.deepEqual(await readdir(runtime), []);
});
