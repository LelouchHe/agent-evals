import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, sep } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { runCliProcess } from "./helpers/cli-process.ts";
import { createFakePi, makeTempDir } from "./helpers/fake-pi-control.ts";
import {
  checkChildEnv,
  dirEnv,
  isSandboxPlatformSupported,
  SYSTEM_PATH,
  wrapExecutableCommand,
} from "../src/platform/index.ts";
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
  const env: NodeJS.ProcessEnv = {
    ...checkChildEnv(process.env),
    ...dirEnv({ home, tmp: root }),
    PATH: [dirname(process.execPath), ...SYSTEM_PATH].join(delimiter),
    npm_config_userconfig: process.platform === "win32" ? "NUL" : "/dev/null",
    npm_config_update_notifier: "false",
    ...(process.platform === "win32"
      ? {
          AGENT_EVALS_WIN_SANDBOX_BIN: join(project, "native", "win-sandbox", "target", "release", "win-sandbox.exe"),
          AGENT_EVALS_WIN_SANDBOX_CREDENTIALS: join(
            process.env.LOCALAPPDATA ?? "",
            "agent-evals",
            "sandbox-users.json",
          ),
        }
      : {}),
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
  const packOutput = await npmCommand(["pack", "--silent", "--json", "--pack-destination", root], project);
  const jsonStart = packOutput.indexOf("[");
  const metadata = JSON.parse(jsonStart >= 0 ? packOutput.slice(jsonStart) : packOutput) as
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
  const installed = join(prefix, "node_modules", "@lelouchhe", "agent-evals");
  const bin = join(prefix, "node_modules", ".bin", process.platform === "win32" ? "agent-evals.cmd" : "agent-evals");
  const require = createRequire(join(installed, "package.json"));
  const installRoot = (await realpath(prefix)) + sep;
  for (const dependency of ["@agentclientprotocol/sdk", "ignore", "re2js", "yaml", "zod"]) {
    assert.ok(
      (await realpath(require.resolve(dependency))).startsWith(installRoot),
      `${dependency} escaped the installation`,
    );
  }
  assert.deepEqual((await readdir(join(prefix, "node_modules"))).filter((name) => !name.startsWith(".")).sort(), [
    "@agentclientprotocol",
    "@lelouchhe",
    "ignore",
    "re2js",
    "yaml",
    "zod",
  ]);
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  assert.equal(await hash(join(installed, "dist/cli.js")), await hash(join(project, "dist/cli.js")));
  if (process.platform !== "win32") {
    assert.notEqual((await stat(bin)).mode & 0o111, 0);
  }
  const [helpCmd, ...helpArgs] = wrapExecutableCommand(bin, ["--help"]);
  const help = spawnSync(helpCmd, helpArgs, { cwd, env, encoding: "utf8", timeout: 5_000, windowsHide: true });
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
      { $type: "file", path: "hello.txt", exists: true, matches: "/^Hello, world!\\n?$/" },
      {
        $type: "judge",
        runner: {
          $type: "pi",
          model: "opencode-go/test-judge",
          apiKey: "${env:MY_KEY}",
          executable: judge.executable,
        },
        files: ["hello.txt"],
        rubric: ["The file satisfies the task."],
      },
    ],
  };
  const configPath = join(cwd, "case.yml");
  await writeFile(configPath, stringify(config));
  const keyScript = join(cwd, "emit-key.mjs");
  await writeFile(
    keyScript,
    'import { appendFileSync } from "node:fs"; appendFileSync("count", "x"); process.stdout.write("synthetic-runner-key\\n");\n',
  );
  await writeFile(join(cwd, ".env"), `MY_KEY='!"${process.execPath}" "${keyScript}"'\n`);
  const invoke = async (entry: string, args: readonly string[]) =>
    runCliProcess(t, entry, args, {
      cwd,
      env: { ...env, TMPDIR: runtime },
      timeoutMs: 30_000,
    });
  if (isSandboxPlatformSupported) {
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

    // Exercise the packaged mock forwarder (forwarder.sh + forwarder-client.mjs) through the installed CLI.
    const mockAgent = await makeAcpAgent(t, "mocks");
    const mockCase = join(mockAgent.root, "mock-case.yml");
    await writeFile(
      mockCase,
      stringify({
        input: "Check mocks.",
        mocks: {
          shell: {
            id: { return: { exitCode: 7, stdout: "answer\n", stderr: "denied\n" } },
            publish: { return: { stdout: "A\0B\u00ff" } },
          },
        },
        runner: { $type: "acp", agent: "agent.yml" },
        checks: [
          { $type: "file", path: "call-out", matches: "/^answer\\n?$/" },
          { $type: "file", path: "call-status", matches: "/^7$/" },
          { $type: "mock", shell: ["id"], times: 1 },
        ],
      }),
    );
    const mockResults = join(root, "mock-results");
    const mockRun = await runCliProcess(t, bin, ["run", mockCase, "--results-dir", mockResults], {
      cwd,
      env: { ...env, TMPDIR: root },
      timeoutMs: 30_000,
    });
    assert.equal(mockRun.code, 0, mockRun.stdout + mockRun.stderr);
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

  // An external checker may use only the packaged entry. It is placed inside the installation so
  // the package and `zod` resolve from that prefix, exactly as a third-party package would.
  const extensions = join(prefix, "extensions");
  const extension = join(extensions, "parity");
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, "index.mjs"),
    `import { z } from "zod";
import { readRunFile, readRunTree, runPathExists, searches } from "@lelouchhe/agent-evals";

export const checker = {
  type: "parity",
  params: z.strictObject({ path: z.string(), matches: z.string() }),
  async create(params, context) {
    await context.validateCheckPlatform();
    return {
      check: async (ctx) => {
        const home = params.path.startsWith("~/");
        const root = home ? ctx.home : ctx.workspace;
        const relative = home ? params.path.slice(2) : params.path;
        if (!(await runPathExists(root, relative))) {
          return [{ checker: "parity", subject: params.path, status: "error", reason: "not found" }];
        }
        const text = (await readRunFile(root, relative)).toString("utf8");
        const tree = await readRunTree(root, relative.slice(0, relative.lastIndexOf("/")));
        const pass = searches(params.matches, text) && (tree?.size ?? 0) > 0;
        return [
          {
            checker: "parity",
            subject: params.path,
            status: pass ? "pass" : "fail",
            reason: pass ? "matched" : "no match",
          },
        ];
      },
    };
  },
};
`,
  );
  await writeFile(join(cwd, "notes.txt"), "hello world\n");
  const extensionCase = join(cwd, "extension.yml");
  await writeFile(
    extensionCase,
    stringify({
      input: "noop",
      files: { "~/notes/answer.txt": "notes.txt" },
      runner: { $type: "noop" },
      checks: [{ $type: "parity", path: "~/notes/answer.txt", matches: "hello" }],
    }),
  );
  const extensionResults = join(root, "extension-results");
  const runExtension = async (matches: string, path = "~/notes/answer.txt") => {
    await writeFile(
      extensionCase,
      stringify({
        input: "noop",
        files: { "~/notes/answer.txt": "notes.txt" },
        runner: { $type: "noop" },
        checks: [{ $type: "parity", path, matches }],
      }),
    );
    return await invoke(bin, ["run", extensionCase, "--extension-dir", extensions, "--results-dir", extensionResults]);
  };
  const extensionPass = await runExtension("hello");
  assert.equal(extensionPass.code, 0, extensionPass.stdout + extensionPass.stderr);
  const extensionFail = await runExtension("goodbye");
  assert.equal(extensionFail.code, 1, extensionFail.stdout + extensionFail.stderr);
  const extensionMissing = await runExtension("hello", "~/notes/missing.txt");
  assert.equal(extensionMissing.code, 2, extensionMissing.stdout + extensionMissing.stderr);
});
