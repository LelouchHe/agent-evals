import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { z } from "zod";
import { fileChecker } from "../src/checkers/file/index.ts";
import { mockChecker } from "../src/checkers/mock/index.ts";
import { loadCase } from "../src/engine/authoring.ts";
import { ConfigError } from "../src/engine/config.ts";
import { createEnvSource } from "../src/engine/env-source.ts";
import { addChecker, addRunner, createRegistry, type RunnerDefinition } from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

/** A runner that calls the declared forwarders on the host, so no sandbox is needed. */
const callingRunnerParams = z.strictObject({
  calls: z.array(z.array(z.string()).min(1)).default([]),
});
type CallingRunnerParams = z.output<typeof callingRunnerParams>;

const callingRunner: RunnerDefinition<CallingRunnerParams> = {
  type: "calling",
  params: callingRunnerParams,
  mocks: true,
  create: (params) => ({
    run: async (context) => {
      const wiring = context.mocks;
      if (wiring === undefined) throw new Error("the runner received no mocks wiring");
      const statuses: (number | null)[] = [];
      for (const [target, ...args] of params.calls) {
        const program = target!.includes("/")
          ? join(context.workspaceDir, target!)
          : join(wiring.forwarderDir, target!);
        statuses.push(await call(program, args));
      }
      return { finalText: statuses.length === 0 ? null : statuses.join(" "), diagnostics: [] };
    },
    stop: async () => {},
  }),
};

function call(program: string, args: readonly string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: "ignore" });
    child.once("close", resolve);
    child.once("error", reject);
  });
}

async function runCase(t: Parameters<typeof makeTempDir>[0], declaration: Record<string, unknown>) {
  const directory = await makeTempDir(t, "ae-mock-check-case-");
  const casePath = join(directory, "case.yml");
  await writeFile(casePath, stringify({ input: "task", ...declaration }));
  await writeFile(join(directory, ".env"), "TOOL=git\n");
  const registry = createRegistry();
  addRunner(registry, callingRunner, "test");
  addChecker(registry, fileChecker, "built-in");
  addChecker(registry, mockChecker, "built-in");
  return {
    directory,
    record: await runEvaluation({
      case: await loadCase(casePath),
      registry,
      resultsDir: await makeTempDir(t, "ae-mock-check-results-"),
      tempParent: await makeTempDir(t, "ae-mock-check-runs-"),
      envSource: createEnvSource(directory),
    }),
  };
}

test("a mock check counts recorded calls, including refused and unmatched ones", async (t) => {
  const { record } = await runCase(t, {
    mocks: {
      shell: {
        refused: { pass: false },
        // Only the listed argument reaches the rule, so the second call below is unmatched.
        allowed: { args: ["ok-only"], return: { stdout: "ok\n" } },
      },
    },
    runner: {
      $type: "calling",
      calls: [
        ["refused", "one"],
        ["allowed", "denied-call"],
      ],
    },
    checks: [
      // Both calls reached the mock: one was refused, one matched no rule.
      { $type: "mock", shell: ["refused", "one"], times: 1 },
      { $type: "mock", shell: ["allowed", "other"], times: 0 },
      { $type: "mock", shell: ["allowed", "denied-call"], times: 1 },
      { $type: "mock", shell: ["refused"] },
    ],
  });
  assert.equal(record.status, "pass", record.error);
  // 126 is the forwarder's refusal for both a declared refusal and a call no rule matched.
  assert.equal(record.runner.finalText, "126 126");
  assert.deepEqual(
    record.checks.map((check) => [check.subject, check.status]),
    [
      ["refused one", "pass"],
      ["allowed other", "pass"],
      ["allowed denied-call", "pass"],
      ["refused", "pass"],
    ],
  );
});

test("the mock checker substitutes placeholders in the check's own parameters", async (t) => {
  const { record } = await runCase(t, {
    mocks: { shell: { git: { return: { stdout: "up to date\n" } } } },
    runner: { $type: "calling", calls: [["git", "push"]] },
    checks: [{ $type: "mock", shell: ["${env:TOOL}", "push"] }],
  });
  assert.equal(record.status, "pass", record.error);
  assert.equal(record.checks[0]?.subject, "git push");
});

test("a workspace target is named by either spelling through the run's records", async (t) => {
  const { record } = await runCase(t, {
    mocks: { shell: { "./scripts/x": { return: { stdout: "ran\n" } } } },
    runner: { $type: "calling", calls: [["./scripts/x", "alpha"]] },
    checks: [
      { $type: "mock", shell: ["scripts/x", "alpha"] },
      { $type: "mock", shell: ["./scripts/x", "alpha"] },
    ],
  });
  assert.equal(record.status, "pass", record.error);
});

test("an undeclared or PATH-versus-script target is a configuration error before any run directory exists", async (t) => {
  const directory = await makeTempDir(t, "ae-mock-check-load-");
  const resultsDir = await makeTempDir(t, "ae-mock-check-load-results-");
  const tempParent = await makeTempDir(t, "ae-mock-check-load-runs-");
  for (const target of ["make", "x"]) {
    const casePath = join(directory, `${target}.yml`);
    await writeFile(
      casePath,
      stringify({
        input: "task",
        mocks: { shell: { git: { return: { stdout: "ok\n" } }, "./x": { return: {} } } },
        runner: { $type: "calling" },
        checks: [{ $type: "mock", shell: [target] }],
      }),
    );
    const registry = createRegistry();
    addRunner(registry, callingRunner, "test");
    addChecker(registry, mockChecker, "built-in");
    await assert.rejects(
      async () => runEvaluation({ case: await loadCase(casePath), registry, resultsDir, tempParent }),
      (error: unknown) =>
        error instanceof ConfigError &&
        new RegExp(`"${target}" is not a declared mocks\\.shell target`).test(error.message),
    );
  }
  assert.deepEqual(await readdir(tempParent), []);
  assert.deepEqual(await readdir(resultsDir), []);
});
