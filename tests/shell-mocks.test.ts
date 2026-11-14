import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import { z } from "zod";
import { fileChecker } from "../src/checkers/file/checker.ts";
import { loadCase } from "../src/engine/authoring.ts";
import { ConfigError } from "../src/engine/config.ts";
import { startMockHost } from "../src/engine/mocks.ts";
import { addChecker, addRunner, createRegistry } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { acpRunner } from "../src/runners/acp/runner.ts";
import { piRunner } from "../src/runners/pi/runner.ts";
import { makeAcpAgent } from "./helpers/acp-agent.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const INPUT = "Check the tool declarations.";

const PROBE_CHECKS = [
  { path: "where-id", matches: "run-[0-9a-f]{12}/bin/id\\n?$" },
  { path: "call-out", matches: "^answer\\n?$" },
  { path: "call-err", matches: "^denied\\n?$" },
  { path: "call-status", matches: "^7$" },
  { path: "call-binary-hex", matches: "41 +00 +42 +c3 +bf" },
  { path: "call-binary-status", matches: "^0$" },
  { path: "call-binary-err", matches: "^$" },
  { path: "probe-list", matches: "^[1-9][0-9]?$" },
  { path: "probe-read", matches: "^0$" },
  { path: "probe-write", matches: "^[1-9][0-9]?$" },
];

const MOCKS = {
  shell: {
    id: { return: { exitCode: 7, stdout: "answer\n", stderr: "denied\n" } },
    // A NUL byte and a non-ASCII character: the reply must carry arbitrary bytes.
    publish: { return: { stdout: "A\0B\u00ff" } },
  },
};

test(
  "a shell mock answers an in-sandbox PATH call and records it outside the sandbox",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const fixture = await makeAcpAgent(t, "mocks");
    const casePath = join(fixture.root, "case.yml");
    await writeFile(
      casePath,
      stringify({
        input: INPUT,
        mocks: MOCKS,
        runner: { $type: "acp", agent: "agent.yml" },
        checks: PROBE_CHECKS.map((check) => ({ $type: "file", ...check })),
      }),
    );
    const registry = createRegistry();
    addRunner(registry, acpRunner, "built-in");
    addChecker(registry, fileChecker, "built-in");
    const resultsDir = join(fixture.root, "results");
    const tempParent = await makeTempDir(t, "ae-mocks-runs-");

    const record = await runEvaluation({
      case: await loadCase(casePath),
      registry,
      resultsDir,
      tempParent,
    });

    assert.deepEqual(
      record.checks.map((check) => [check.subject, check.status]),
      PROBE_CHECKS.map((check) => [`${check.path} matches /${check.matches}/`, "pass"]),
      record.error,
    );
    assert.equal(record.status, "pass", record.error);
    // The calls are recorded beside the trace, outside everything the sandbox reaches.
    assert.deepEqual(JSON.parse(await readFile(join(resultsDir, record.runId, "interactions.json"), "utf8")), [
      { target: "id", arguments: ["arg with space"] },
      { target: "publish", arguments: ["", "x"] },
    ]);
    assert.deepEqual(await readdir(tempParent), []);
  },
);

test("a case declares mocks only on a runner that wires them", async (t) => {
  const directory = await makeTempDir(t, "ae-mocks-runner-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: INPUT,
      mocks: MOCKS,
      runner: { $type: "pi", model: "example/model" },
      checks: [{ $type: "file", path: "absent.txt", exists: false }],
    }),
  );
  const registry = createRegistry();
  addRunner(registry, piRunner, "built-in");
  addChecker(registry, fileChecker, "built-in");
  const tempParent = await makeTempDir(t, "ae-mocks-runner-runs-");
  const resultsDir = await makeTempDir(t, "ae-mocks-runner-results-");

  await assert.rejects(
    async () => runEvaluation({ case: await loadCase(casePath), registry, resultsDir, tempParent }),
    (error: unknown) => error instanceof ConfigError && /runner "pi" does not support mocks/.test(error.message),
  );
  assert.deepEqual(await readdir(tempParent), []);
  assert.deepEqual(await readdir(resultsDir), []);
});

test("a runner that declares mocks receives the forwarder directory and socket", async (t) => {
  const seen: { socketPath: string; forwarders: string[] }[] = [];
  const registry = createRegistry();
  addRunner(
    registry,
    {
      type: "wired-runner",
      params: z.strictObject({}),
      mocks: true,
      create: () => ({
        run: async (context) => {
          const wiring = context.mocks;
          if (wiring === undefined) throw new Error("the runner received no mocks wiring");
          seen.push({ socketPath: wiring.socketPath, forwarders: await readdir(wiring.forwarderDir) });
          return { finalText: null, diagnostics: [] };
        },
        stop: async () => {},
      }),
    },
    "test",
  );
  addChecker(registry, fileChecker, "built-in");

  const directory = await makeTempDir(t, "ae-mocks-wiring-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: INPUT,
      mocks: MOCKS,
      runner: { $type: "wired-runner" },
      checks: [{ $type: "file", path: "absent.txt", exists: false }],
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-mocks-wiring-results-");
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent: await makeTempDir(t, "ae-mocks-wiring-runs-"),
  });

  assert.equal(record.status, "pass", record.error);
  // One forwarder per declared target, and a socket outside the run root because a Unix
  // socket path is limited to about 100 bytes.
  const observed = seen[0];
  assert.ok(observed !== undefined);
  assert.deepEqual(observed.forwarders, ["id", "publish"]);
  assert.equal(dirname(observed.socketPath), tmpdir());

  // Nothing was called, and an empty record is still written beside the run's other evidence.
  assert.deepEqual(JSON.parse(await readFile(join(resultsDir, record.runId, "interactions.json"), "utf8")), []);
});

test("calls that arrive while the runner stops are still recorded", async (t) => {
  const scratch = await makeTempDir(t, "ae-mocks-stop-");
  const trigger = join(scratch, "trigger");
  const output = join(scratch, "output");
  const finished = join(scratch, "finished");
  const registry = createRegistry();
  addRunner(
    registry,
    {
      type: "stopping-runner",
      params: z.strictObject({}),
      mocks: true,
      create: () => {
        // A lingering process: it calls the mocked command only after run() has returned.
        let child: ReturnType<typeof spawn> | undefined;
        return {
          run: async (context) => {
            const wiring = context.mocks;
            if (wiring === undefined) throw new Error("the runner received no mocks wiring");
            child = spawn(
              "/bin/sh",
              [
                "-c",
                'while [ ! -f "$1" ]; do sleep 0.02; done; id after > "$2" 2>&1; printf "%s" $? > "$3"',
                "sh",
                trigger,
                output,
                finished,
              ],
              { detached: true, stdio: "ignore", env: { PATH: `${wiring.forwarderDir}:/usr/bin:/bin` } },
            );
            child.unref();
            return { finalText: null, diagnostics: [] };
          },
          stop: async () => {
            await writeFile(trigger, "");
            for (let attempt = 0; attempt < 250; attempt += 1) {
              try {
                await readFile(finished);
                return;
              } catch {
                await delay(20);
              }
            }
            throw new Error("the lingering call did not reach the host");
          },
        };
      },
    },
    "test",
  );
  addChecker(registry, fileChecker, "built-in");

  const directory = await makeTempDir(t, "ae-mocks-stop-case-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: INPUT,
      mocks: MOCKS,
      runner: { $type: "stopping-runner" },
      checks: [{ $type: "file", path: "absent.txt", exists: false }],
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-mocks-stop-results-");
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent: await makeTempDir(t, "ae-mocks-stop-runs-"),
  });

  assert.equal(record.status, "pass", record.error);
  assert.deepEqual(JSON.parse(await readFile(join(resultsDir, record.runId, "interactions.json"), "utf8")), [
    { target: "id", arguments: ["after"] },
  ]);
  // The reply reached the lingering process, so the record and the result agree.
  assert.equal(await readFile(output, "utf8"), "answer\ndenied\n");
  assert.equal(await readFile(finished, "utf8"), "7");
});

test("unsupported mock syntax is rejected at load time instead of ignored", async (t) => {
  const directory = await makeTempDir(t, "ae-mocks-syntax-");
  const cases = [
    [{ shell: { make: { args: ["push"], return: {} } } }, /mocks\.shell\["make"\]\.args is not supported yet/],
    [{ shell: { make: { run: ["sh", "fake.sh"] } } }, /mocks\.shell\["make"\]\.run is not supported yet/],
    [{ shell: { make: { pass: true } } }, /mocks\.shell\["make"\]\.pass is not supported yet/],
    [{ shell: { make: [{ return: {} }] } }, /mocks\.shell\["make"\] must be a single rule/],
    [{ shell: { "scripts/deploy.sh": { return: {} } } }, /must be a bare command name/],
    [{ shell: { make: {} } }, /must declare a return rule/],
    [{ shell: { make: { return: {}, times: 1 } } }, /mocks\.shell\["make"\] has unknown field: times/],
    [{ shell: { make: { return: { exitCode: 300 } } } }, /exitCode must be an integer from 0 to 255/],
    [{ shell: { make: { return: { exitCode: "1" } } } }, /exitCode must be an integer from 0 to 255/],
    [{ shell: { make: { return: { output: "text" } } } }, /return has unknown field: output/],
    [{ mcp: { server: {} } }, /mocks has unknown field: mcp/],
    [{}, /mocks must declare shell targets/],
  ] as const;

  for (const [index, [mocks, message]] of [...cases.entries()]) {
    const casePath = join(directory, `${index}.yml`);
    await writeFile(casePath, stringify({ input: INPUT, mocks, runner: { $type: "pi" }, checks: [{ $type: "file" }] }));
    await assert.rejects(
      () => loadCase(casePath),
      (error: unknown) => error instanceof ConfigError && message.test(error.message),
      JSON.stringify(mocks),
    );
  }

  const declared = join(directory, "declared.yml");
  await writeFile(
    declared,
    stringify({
      input: INPUT,
      mocks: { shell: { make: { return: {} }, deploy: { return: { stdout: "done\n" } } } },
      runner: { $type: "pi" },
      checks: [{ $type: "file" }],
    }),
  );
  assert.deepEqual((await loadCase(declared)).config.mocks, {
    shell: { make: { exitCode: 0, stdout: "", stderr: "" }, deploy: { exitCode: 0, stdout: "done\n", stderr: "" } },
  });
});

test(
  "a fixed result keeps stdout, stderr and the exit code separate in every combination",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await makeTempDir(t, "ae-mocks-streams-");
    const host = await startMockHost({
      runRootDir: root,
      shell: {
        both: { exitCode: 3, stdout: "OUT\n", stderr: "ERR\n" },
        onlyout: { exitCode: 0, stdout: "OUT\n", stderr: "" },
        onlyerr: { exitCode: 1, stdout: "", stderr: "ERR\n" },
        neither: { exitCode: 0, stdout: "", stderr: "" },
      },
    });
    const names = ["both", "onlyout", "onlyerr", "neither"];
    const results: Record<string, unknown> = {};
    for (const name of names) {
      results[name] = await callForwarder(join(host.wiring.forwarderDir, name));
    }
    const interactions = await host.close();

    assert.deepEqual(results, {
      both: { status: 3, stdout: "OUT\n", stderr: "ERR\n" },
      onlyout: { status: 0, stdout: "OUT\n", stderr: "" },
      onlyerr: { status: 1, stdout: "", stderr: "ERR\n" },
      neither: { status: 0, stdout: "", stderr: "" },
    });
    assert.deepEqual(
      interactions.map((interaction) => interaction.target),
      names,
    );
  },
);

/** Run one forwarder directly and keep both streams and the exit status apart. */
async function callForwarder(path: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(path, [], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const [stdout, stderr] = await Promise.all([collect(child.stdout), collect(child.stderr)]);
  return { status: await exited, stdout, stderr };
}

async function collect(stream: Readable | null): Promise<string> {
  if (stream === null) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("a throwing runner trace still closes the mock host", async (t) => {
  const registry = createRegistry();
  let socketPath: string | undefined;
  addRunner(
    registry,
    {
      type: "tracing-runner",
      params: z.strictObject({}),
      mocks: true,
      create: () => ({
        run: async (context) => {
          socketPath = context.mocks?.socketPath;
          return { finalText: null, diagnostics: [] };
        },
        stop: async () => {},
        trace: () => {
          throw new Error("trace failed");
        },
      }),
    },
    "test",
  );
  addChecker(registry, fileChecker, "built-in");

  const directory = await makeTempDir(t, "ae-mocks-trace-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: INPUT,
      mocks: MOCKS,
      runner: { $type: "tracing-runner" },
      checks: [{ $type: "file", path: "absent.txt", exists: false }],
    }),
  );
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir: await makeTempDir(t, "ae-mocks-trace-results-"),
    tempParent: await makeTempDir(t, "ae-mocks-trace-runs-"),
  });

  assert.equal(record.status, "error");
  assert.match(record.error ?? "", /trace failed/);
  // The host closed and removed its socket before the trace was read.
  const path = socketPath;
  assert.ok(path !== undefined);
  await assert.rejects(() => stat(path), { code: "ENOENT" });
});
