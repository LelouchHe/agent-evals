import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { stringify } from "yaml";
import { z } from "zod";
import { fileChecker } from "../src/checkers/file/checker.ts";
import { loadCase } from "../src/engine/authoring.ts";
import type { MockArgument, MockResult, MockRule, ShellMocks } from "../src/engine/config.ts";
import { startMockHost, type MockHost, type MockHostOptions } from "../src/engine/mocks.ts";
import { addChecker, addRunner, createRegistry } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const INPUT = "task";

interface Call {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A host rooted in a fresh directory, with workspace and scratch ready. */
async function host(
  t: Parameters<typeof makeTempDir>[0],
  shell: ShellMocks,
  extra: Partial<MockHostOptions> = {},
): Promise<{ host: MockHost; root: string }> {
  const root = await makeTempDir(t, "ae-mock-actions-");
  const workspaceDir = join(root, "workspace");
  const scratchDir = join(root, "scratch");
  await mkdir(workspaceDir);
  await mkdir(scratchDir);
  const started = await startMockHost({
    runRootDir: root,
    workspaceDir,
    scratchDir,
    authoringDir: root,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    shell,
    ...extra,
  });
  // Close once, however the test ends: a failed assertion must not leave the host listening.
  let closing: ReturnType<typeof started.close> | undefined;
  const close = (): ReturnType<typeof started.close> => (closing ??= started.close());
  t.after(async () => {
    await close().catch(() => {});
  });
  return { host: { wiring: started.wiring, close }, root };
}

function result(exitCode = 0, stdout = "", stderr = ""): MockResult {
  return { exitCode, stdout, stderr };
}

interface ArgsInput {
  readonly positional?: readonly string[];
  readonly options?: readonly MockRuleArgumentInput[];
}

function rule(args: ArgsInput | undefined, action: ShellMocks[string][number]["action"]): MockRule {
  return {
    ...(args === undefined
      ? {}
      : {
          args: {
            positional: (args.positional ?? []).map(patternOf),
            options: (args.options ?? []).map(argumentOf),
          },
        }),
    action,
  };
}

function argumentOf(option: MockRuleArgumentInput): MockArgument {
  const key = patternOf(option.key);
  return option.kind === "value" ? { key, kind: "value", value: patternOf(option.value) } : { key, kind: option.kind };
}

/** One fixed-result rule, the internal action shape. */
function returns(value: MockResult, args?: ArgsInput) {
  return [rule(args, { kind: "return", result: value })];
}

type MockRuleArgumentInput =
  | { readonly key: string; readonly kind: "required" | "forbidden" }
  | { readonly key: string; readonly kind: "value"; readonly value: string };

/** `/…/` is a regex; anything else is a literal, mirroring the authoring grammar. */
function patternOf(source: string): { source: string; regex: boolean } {
  return source.length >= 2 && source.startsWith("/") && source.endsWith("/")
    ? { source: source.slice(1, -1), regex: true }
    : { source, regex: false };
}

async function call(path: string, args: readonly string[] = []): Promise<Call> {
  const child = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const collect = async (stream: Readable | null): Promise<string> => {
    if (stream === null) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };
  const [stdout, stderr] = await Promise.all([collect(child.stdout), collect(child.stderr)]);
  return { status: await exited, stdout, stderr };
}

test("ordered rules match the first applicable argument condition", async (t) => {
  const { host: server } = await host(t, {
    git: [
      rule(
        { positional: ["push"], options: [{ key: "/-f|--force/", kind: "required" }] },
        {
          kind: "return",
          result: result(1, "", "force push is disabled\n"),
        },
      ),
      rule({ positional: ["push"] }, { kind: "return", result: result(0, "Everything up-to-date\n") }),
      rule(undefined, { kind: "return", result: result(0, "fallback\n") }),
    ],
  });
  const git = join(server.wiring.forwarderDir, "git");

  assert.deepEqual(await call(git, ["push", "--force"]), {
    status: 1,
    stdout: "",
    stderr: "force push is disabled\n",
  });
  assert.deepEqual(await call(git, ["push", "-f"]), { status: 1, stdout: "", stderr: "force push is disabled\n" });
  // A whole-token regex does not match a longer option.
  assert.deepEqual(await call(git, ["push", "--force-with-lease"]), {
    status: 0,
    stdout: "Everything up-to-date\n",
    stderr: "",
  });
  assert.deepEqual(await call(git, ["push", "origin", "main"]), {
    status: 0,
    stdout: "Everything up-to-date\n",
    stderr: "",
  });
  assert.deepEqual(await call(git, ["fetch"]), { status: 0, stdout: "fallback\n", stderr: "" });

  const { records } = await server.close();
  assert.deepEqual(
    records.map((record) => record.arguments),
    [["push", "--force"], ["push", "-f"], ["push", "--force-with-lease"], ["push", "origin", "main"], ["fetch"]],
  );
});

test("an option value matches the next token or the part after =", async (t) => {
  const { host: server } = await host(t, {
    npm: returns(result(0, "published\n"), {
      options: [{ key: "--registry", kind: "value", value: "https://r.example" }],
    }),
  });
  const npm = join(server.wiring.forwarderDir, "npm");
  assert.equal((await call(npm, ["--registry", "https://r.example"])).stdout, "published\n");
  assert.equal((await call(npm, ["--registry=https://r.example"])).stdout, "published\n");
  assert.equal((await call(npm, ["--registry", "https://other.example"])).status, 126);
  await server.close();
});

test("a positional prefix ignores later arguments and compares numbers as text", async (t) => {
  const { host: server } = await host(t, {
    make: returns(result(0, "deployed\n"), { positional: ["deploy"] }),
    lint: returns(result(0, "five\n"), { positional: ["-n", "5"] }),
  });
  assert.equal((await call(join(server.wiring.forwarderDir, "make"), ["deploy", "--prod"])).stdout, "deployed\n");
  assert.equal((await call(join(server.wiring.forwarderDir, "make"), ["build"])).status, 126);
  assert.equal((await call(join(server.wiring.forwarderDir, "lint"), ["-n", "5"])).stdout, "five\n");
  await server.close();
});

test("a call no rule matches is recorded and denied", async (t) => {
  const { host: server } = await host(t, { deploy: returns(result(0, "ok\n"), { positional: ["prod"] }) });
  const denied = await call(join(server.wiring.forwarderDir, "deploy"), ["staging"]);
  assert.equal(denied.status, 126);
  assert.equal(denied.stdout, "");
  assert.match(denied.stderr, /^deploy: Operation not permitted\n$/);

  const { records, faults } = await server.close();
  assert.deepEqual(records, [{ target: "deploy", arguments: ["staging"] }]);
  assert.deepEqual(faults, []);
});

test("a run program receives the appended arguments, in the case directory, with empty stdin", async (t) => {
  const authoring = await makeTempDir(t, "ae-mock-run-");
  await writeFile(
    join(authoring, "fake.mjs"),
    `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: await new Promise((resolve) => {
      let data = "";
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      process.stdin.resume();
    }) }));
    process.exit(3);`,
  );
  const { host: server } = await host(
    t,
    { quickstart: [rule(undefined, { kind: "run", command: [process.execPath, "fake.mjs"], pass: false })] },
    { authoringDir: authoring },
  );
  const started = await call(join(server.wiring.forwarderDir, "quickstart"), ["alpha", "beta gamma"]);
  assert.equal(started.status, 3);
  assert.deepEqual(JSON.parse(started.stdout), {
    argv: ["alpha", "beta gamma"],
    cwd: await realpath(authoring),
    stdin: "",
  });
  assert.deepEqual((await server.close()).faults, []);
});

test("a run program that cannot start, is killed or overruns is a fault, not a response", async (t) => {
  const { host: server } = await host(
    t,
    {
      missing: [rule(undefined, { kind: "run", command: ["definitely-not-a-program-xyz"], pass: false })],
      timing: [rule(undefined, { kind: "run", command: ["/bin/sh", "-c", "sleep 30"], pass: false })],
    },
    { timeoutMs: 300 },
  );
  const missing = await call(join(server.wiring.forwarderDir, "missing"));
  assert.equal(missing.status, 126);
  assert.match(missing.stderr, /missing: Operation not permitted\n/);

  const timing = await call(join(server.wiring.forwarderDir, "timing"), []);
  assert.equal(timing.status, 126);

  const { records, faults } = await server.close();
  assert.deepEqual(
    records.map((record) => record.target),
    ["missing", "timing"],
  );
  assert.equal(faults.length, 2, faults.join("\n"));
  assert.match(faults[0] as string, /could not start definitely-not-a-program-xyz/);
  assert.match(faults[1] as string, /exceeded 300ms/);
});

test("a run program's descendants are killed when it overruns", async (t) => {
  const authoring = await makeTempDir(t, "ae-mock-descendants-");
  await writeFile(
    join(authoring, "spawn.mjs"),
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
writeFileSync("child.pid", String(child.pid));
setInterval(() => {}, 1000);`,
  );
  const { host: server, root } = await host(
    t,
    { hanging: [rule(undefined, { kind: "run", command: [process.execPath, "spawn.mjs"], pass: false })] },
    { authoringDir: authoring, timeoutMs: 500 },
  );
  void root;
  assert.equal((await call(join(server.wiring.forwarderDir, "hanging"))).status, 126);
  const { faults } = await server.close();
  assert.match(faults[0] as string, /exceeded 500ms/);

  const pid = Number(await readFile(join(authoring, "child.pid"), "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("run can pass only through the marker and only when the rule allows it", async (t) => {
  const authoring = await makeTempDir(t, "ae-mock-marker-");
  await writeFile(join(authoring, "pass.mjs"), `process.stdout.write("agent-evals:pass\\n");`);
  await writeFile(join(authoring, "pass-crash.mjs"), `process.stdout.write("agent-evals:pass\\n"); process.exit(4);`);
  await writeFile(join(authoring, "marker.mjs"), `process.stdout.write("agent-evals:pass\\n");`);
  const { host: server } = await host(
    t,
    {
      allowed: [rule(undefined, { kind: "run", command: [process.execPath, "pass.mjs"], pass: true })],
      crashed: [rule(undefined, { kind: "run", command: [process.execPath, "pass-crash.mjs"], pass: true })],
      refused: [rule(undefined, { kind: "run", command: [process.execPath, "marker.mjs"], pass: false })],
    },
    { authoringDir: authoring },
  );
  // A marker from a rule that allows pass hands the call to the real command; none exists here,
  // so the forwarder denies it and the marker never reaches the agent.
  assert.deepEqual(await call(join(server.wiring.forwarderDir, "allowed")), {
    status: 126,
    stdout: "",
    stderr: "allowed: Operation not permitted\n",
  });
  assert.equal((await call(join(server.wiring.forwarderDir, "crashed"))).status, 126);
  assert.equal((await call(join(server.wiring.forwarderDir, "refused"))).status, 126);

  const { faults } = await server.close();
  assert.equal(faults.length, 2, faults.join("\n"));
  assert.match(faults[0] as string, /printed the pass marker with exit code 4/);
  assert.match(faults[1] as string, /printed the pass marker but the rule has no pass/);
});

test("a forwarder that cannot reach the host is a reported fault", async (t) => {
  const { host: server, root } = await host(t, { deploy: returns(result(0, "ok\n")) });
  // Remove the socket so the forwarder's connection fails, as it would if the host died.
  await rm(server.wiring.socketPath, { force: true });
  const failed = await call(join(server.wiring.forwarderDir, "deploy"));
  assert.equal(failed.status, 126);
  assert.match(failed.stderr, /Service unavailable\n/);
  const { faults } = await server.close();
  assert.deepEqual(faults, ['a forwarder for "deploy" could not reach the mock host']);
  void root;
});

test("workspace scripts run through their forwarder and keep the real one out of reach", async (t) => {
  const root = await makeTempDir(t, "ae-mock-workspace-");
  const workspaceDir = join(root, "workspace");
  await mkdir(join(workspaceDir, "scripts"), { recursive: true });
  await writeFile(join(workspaceDir, "scripts/publish.sh"), "#!/bin/sh\necho real publish\n", { mode: 0o755 });
  await writeFile(join(workspaceDir, "scripts/inspect.sh"), '#!/bin/sh\necho "real inspect $*"\n', { mode: 0o755 });
  const started = await startMockHost({
    runRootDir: root,
    workspaceDir: await realpath(workspaceDir),
    scratchDir: root,
    authoringDir: root,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    shell: {
      "scripts/publish.sh": returns(result(0, "mocked publish\n")),
      "scripts/inspect.sh": [{ action: { kind: "pass" } }],
    },
  });

  const publish = await call(join(workspaceDir, "scripts/publish.sh"));
  assert.deepEqual(publish, { status: 0, stdout: "mocked publish\n", stderr: "" });
  // The real script left the sandbox instead of sitting beside its forwarder.
  await assert.rejects(() => stat(join(workspaceDir, "scripts/.publish.sh")), { code: "ENOENT" });
  assert.match(await readFile(join(root, "replaced/scripts/publish.sh"), "utf8"), /real publish/);

  const inspect = await call(join(workspaceDir, "scripts/inspect.sh"), ["alpha"]);
  assert.deepEqual(inspect, { status: 0, stdout: "real inspect alpha\n", stderr: "" });
  assert.match(await readFile(join(workspaceDir, "scripts/.inspect.sh"), "utf8"), /real inspect/);

  const { records } = await started.close();
  assert.deepEqual(
    records.map((record) => record.target),
    ["scripts/publish.sh", "scripts/inspect.sh"],
  );
});

test("a workspace script target rejects a pass without a real script and a name collision", async (t) => {
  const prepare = async (files: Readonly<Record<string, string>>) => {
    const root = await makeTempDir(t, "ae-mock-workspace-bad-");
    const workspaceDir = join(root, "workspace");
    await mkdir(join(workspaceDir, "scripts"), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(workspaceDir, name), text, { mode: 0o755 });
    }
    const start = async (shell: ShellMocks) =>
      startMockHost({
        runRootDir: root,
        workspaceDir: await realpath(workspaceDir),
        scratchDir: root,
        authoringDir: root,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        shell,
      });
    return start;
  };

  const missing = await prepare({});
  await assert.rejects(() => missing({ "scripts/missing.sh": [{ action: { kind: "pass" } }] }), /needs a real script/);

  const collision = await prepare({
    "scripts/deploy.sh": "#!/bin/sh\necho real\n",
    "scripts/.deploy.sh": "#!/bin/sh\n",
  });
  await assert.rejects(
    () => collision({ "scripts/deploy.sh": [{ action: { kind: "pass" } }] }),
    /already has \.deploy\.sh beside it/,
  );
});

test("a mock fault ends the run as an error while keeping its records", async (t) => {
  const registry = createRegistry();
  addRunner(
    registry,
    {
      type: "calling-runner",
      params: z.strictObject({}),
      mocks: true,
      create: () => ({
        run: async (context) => {
          const wiring = context.mocks;
          assert.ok(wiring !== undefined);
          const child = spawn(join(wiring.forwarderDir, "deploy"), [], { stdio: "ignore" });
          await new Promise((resolve) => child.on("close", resolve));
          return { finalText: null, diagnostics: [] };
        },
        stop: async () => {},
      }),
    },
    "test",
  );
  addChecker(registry, fileChecker, "built-in");

  const directory = await makeTempDir(t, "ae-mock-fault-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: INPUT,
      mocks: { shell: { deploy: { run: ["definitely-not-a-program-xyz"] } } },
      runner: { $type: "calling-runner" },
      checks: [{ $type: "file", path: "absent.txt", exists: false }],
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-mock-fault-results-");
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent: await makeTempDir(t, "ae-mock-fault-runs-"),
  });
  assert.equal(record.status, "error");
  assert.match(record.error ?? "", /could not start definitely-not-a-program-xyz/);
  assert.deepEqual(JSON.parse(await readFile(join(resultsDir, record.runId, "mocks.json"), "utf8")), [
    { target: "deploy", arguments: [] },
  ]);
});
