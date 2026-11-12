import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerContext, RunnerOutcome } from "../../engine/registry.ts";
import { parseImplementationParams } from "../../engine/params.ts";
import { ConfigError, type ImplementationParams } from "../../engine/config.ts";
import { createFakePi, makeTempDir } from "../../../tests/helpers/fake-pi-control.ts";
import { implementationContext } from "../../../tests/helpers/implementation-context.ts";
import { piRunner } from "./runner.ts";
import { PiSessionError } from "./session.ts";

async function setup(t: Parameters<typeof makeTempDir>[0]) {
  const root = await makeTempDir(t, "ae-runner-");
  const workspaceDir = join(root, "workspace");
  const homeDir = join(root, "home");
  const configDir = join(root, "config");
  const scratchDir = join(root, "scratch");
  await Promise.all([mkdir(workspaceDir), mkdir(homeDir), mkdir(configDir), mkdir(scratchDir)]);
  return { root, workspaceDir, homeDir, configDir, scratchDir };
}

function context(
  dirs: Awaited<ReturnType<typeof setup>>,
  timeoutMs: number,
  signal = AbortSignal.timeout(timeoutMs + 5_000),
): RunnerContext {
  return {
    workspaceDir: dirs.workspaceDir,
    homeDir: dirs.homeDir,
    configDir: dirs.configDir,
    scratchDir: dirs.scratchDir,
    runRootDir: dirs.root,
    input: "Create hello.txt with the content Hello, world!",
    timeoutMs,
    signal,
  };
}

async function parsePi(raw: ImplementationParams) {
  return parseImplementationParams(piRunner.params, raw, 'runner "pi"');
}

async function runPrepared(
  raw: ImplementationParams,
  dirs: Awaited<ReturnType<typeof setup>>,
  timeoutMs: number,
): Promise<RunnerOutcome> {
  const params = await parsePi(raw);
  const runner = await piRunner.create(params, implementationContext(dirs.root));
  try {
    return await runner.run(context(dirs, timeoutMs));
  } finally {
    await runner.stop();
  }
}

test("pi runner completes an RPC run and reports assistant text", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "success");
  const outcome = await runPrepared(
    { model: "test/model", thinking: "low", executable: fake.executable },
    dirs,
    10_000,
  );

  assert.equal(outcome.finalText, "Created hello.txt.");
  assert.equal(await readFile(join(dirs.workspaceDir, "hello.txt"), "utf8"), "Hello, world!\n");
  const settings = JSON.parse(await readFile(join(dirs.configDir, "settings.json"), "utf8")) as {
    defaultProjectTrust: string;
  };
  assert.equal(settings.defaultProjectTrust, "never");
});

test("pi runner passes explicit model, tools, and isolated environment", async (t) => {
  const dirs = await setup(t);
  const record = join(dirs.workspaceDir, "args.json");
  const fake = await createFakePi(t, "record-args", record);
  await runPrepared({ model: "test/model", thinking: "high", executable: fake.executable }, dirs, 10_000);

  const recorded = JSON.parse(await readFile(record, "utf8")) as {
    args: string[];
    cwd: string;
    env: Record<string, string>;
  };
  assert.ok(recorded.args.includes("--mode"));
  assert.ok(recorded.args.includes("rpc"));
  assert.ok(recorded.args.includes("--no-session"));
  assert.ok(recorded.args.includes("--no-skills"));
  assert.ok(recorded.args.includes("--no-extensions"));
  assert.ok(recorded.args.includes("--no-mcp"));
  assert.ok(recorded.args.includes("--no-context-files"));
  assert.equal(recorded.args[recorded.args.indexOf("--model") + 1], "test/model");
  assert.equal(recorded.args[recorded.args.indexOf("--thinking") + 1], "high");
  assert.equal(recorded.args[recorded.args.indexOf("--tools") + 1], "read,write,edit,bash");
  assert.equal(recorded.cwd, await realpath(dirs.workspaceDir));
  assert.equal(recorded.env.HOME, dirs.homeDir);
  assert.equal(recorded.env.TMPDIR, dirs.scratchDir);
  assert.equal(recorded.env.PI_CODING_AGENT_DIR, dirs.configDir);
  assert.doesNotMatch(recorded.env.PATH ?? "", /\/Users\/lelouch\/mine/);
});

test("pi runner injects only the resolved provider credential into its isolated environment", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "env");
  await writeFile(
    join(dirs.root, ".env"),
    [
      "OPENCODE_API_KEY=synthetic-credential",
      "HOST_SECRET=dotenv-secret",
      "PATH=/dotenv/path",
      "HOME=/dotenv/home",
    ].join("\n") + "\n",
  );
  const previousKey = process.env.OPENCODE_API_KEY;
  const previousHost = process.env.HOST_SECRET;
  process.env.OPENCODE_API_KEY = "host-secret";
  process.env.HOST_SECRET = "host-only";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previousKey;
    if (previousHost === undefined) delete process.env.HOST_SECRET;
    else process.env.HOST_SECRET = previousHost;
  });

  await runPrepared(
    {
      model: "opencode-go/test-model",
      executable: fake.executable,
      skills: [],
      credentials: ["OPENCODE_API_KEY"],
    },
    dirs,
    10_000,
  );
  const env = JSON.parse(await readFile(join(dirs.workspaceDir, "env.json"), "utf8")) as {
    credential: string | null;
    fake: string | null;
    host: string | null;
    home: string;
    path: string;
  };
  assert.equal(env.credential, "synthetic-credential");
  assert.equal(env.fake, null);
  assert.equal(env.host, null);
  assert.equal(env.home, dirs.homeDir);
  assert.doesNotMatch(env.path, /dotenv/);
});

test("pi runner stages declared skills inside isolated config", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "success");
  await mkdir(join(dirs.root, "skill"));
  await writeFile(
    join(dirs.root, "skill", "SKILL.md"),
    "---\nname: tiny\ndescription: Tiny test skill.\n---\n\nWrite the file.\n",
  );

  await runPrepared({ model: "test/model", executable: fake.executable, skills: ["skill"] }, dirs, 10_000);
  const staged = await readFile(join(dirs.configDir, "skills", "skill", "SKILL.md"), "utf8");
  assert.match(staged, /name: tiny/);
});

test("pi runner rejects invalid parameters and missing prerequisites before launch", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "success");

  await assert.rejects(() => parsePi({ model: "", executable: fake.executable }), ConfigError);
  await assert.rejects(
    () => parsePi({ model: "test/model", executable: fake.executable, thinking: "turbo" }),
    ConfigError,
  );
  await assert.rejects(() => parsePi({ model: "test/model", executable: fake.executable, extra: true }), ConfigError);
  await assert.rejects(
    () => parsePi({ model: "test/model", executable: fake.executable, envPassthrough: ["OPENCODE_API_KEY"] }),
    ConfigError,
  );
  for (const reserved of ["HOME", "PATH", "NODE_OPTIONS", "PI_CODING_AGENT_DIR"]) {
    await assert.rejects(
      () => parsePi({ model: "test/model", executable: fake.executable, credentials: [reserved] }),
      ConfigError,
    );
  }
  await assert.rejects(async () => {
    const params = await parsePi({ model: "test/model", executable: fake.executable, skills: ["missing"] });
    await piRunner.create(params, implementationContext(dirs.root));
  }, ConfigError);
  await mkdir(join(dirs.root, "dir-without-skill"));
  await assert.rejects(async () => {
    const params = await parsePi({ model: "test/model", executable: fake.executable, skills: ["dir-without-skill"] });
    await piRunner.create(params, implementationContext(dirs.root));
  }, ConfigError);
  await assert.rejects(async () => {
    const params = await parsePi({ model: "test/model", executable: "missing-pi-executable" });
    await piRunner.create(params, implementationContext(dirs.root));
  }, ConfigError);
  await assert.rejects(async () => {
    const params = await parsePi({
      model: "test/model",
      executable: fake.executable,
      credentials: ["OPENCODE_API_KEY"],
    });
    await piRunner.create(params, implementationContext(dirs.root));
  }, ConfigError);

  const defaults = await parsePi({ model: "test/model", executable: fake.executable });
  assert.equal(defaults.thinking, "medium");
  assert.deepEqual(defaults.skills, []);
  assert.deepEqual(defaults.credentials, []);
});

test("pi runner reports invalid protocol output as an execution error", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "bad-json");
  await assert.rejects(
    () => runPrepared({ model: "test/model", executable: fake.executable }, dirs, 5_000),
    (error: unknown) => error instanceof PiSessionError && /invalid JSON/.test(error.message),
  );
});

test("pi runner reports an unexpected exit as an execution error", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "crash");
  await assert.rejects(
    () => runPrepared({ model: "test/model", executable: fake.executable }, dirs, 5_000),
    PiSessionError,
  );
});

test("pi runner classifies a final native provider error as execution failure", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "provider-error");
  await assert.rejects(
    () => runPrepared({ model: "test/model", executable: fake.executable }, dirs, 5_000),
    (error: unknown) => error instanceof PiSessionError && /401|provider request failed/.test(error.message),
  );
});

test("pi runner ignores a recoverable earlier provider error when the final run succeeds", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "retry-then-success");
  const outcome = await runPrepared({ model: "test/model", executable: fake.executable }, dirs, 5_000);
  assert.equal(outcome.finalText, "Recovered after a retry.");
});

test("pi runner reports a startup failure without an unhandled rejection", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "startup-crash");
  await assert.rejects(
    () => runPrepared({ model: "test/model", executable: fake.executable }, dirs, 5_000),
    PiSessionError,
  );
});

test("pi runner times out a hung run and stops the process", async (t) => {
  const dirs = await setup(t);
  const fake = await createFakePi(t, "hang");
  const started = performance.now();
  await assert.rejects(
    () => runPrepared({ model: "test/model", executable: fake.executable }, dirs, 500),
    PiSessionError,
  );
  assert.ok(performance.now() - started < 10_000);
});

test("pi runner terminates an owned child process on timeout", async (t) => {
  const dirs = await setup(t);
  const pidFile = join(dirs.workspaceDir, "child.pid");
  const fake = await createFakePi(t, "child-hang", pidFile);
  await assert.rejects(
    () => runPrepared({ model: "test/model", executable: fake.executable }, dirs, 500),
    PiSessionError,
  );

  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(pid > 0);
  assert.equal(isAlive(pid), false, `child process ${pid} should be terminated`);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
