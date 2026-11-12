import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { loadCase } from "../src/engine/authoring.ts";
import {
  addChecker,
  addRunner,
  createRegistry,
  type CheckerContext,
  type CheckerDefinition,
  type RunnerContext,
  type RunnerDefinition,
} from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

test("engine preparation passes each parsed implementation shape to its bound instance exactly once", async (t) => {
  interface RunnerParsed {
    readonly label: string;
    readonly compiled: number;
  }
  interface CheckerParsed {
    readonly label: string;
    readonly compiled: number;
  }

  const registry = createRegistry();
  let runnerParseCalls = 0;
  let runnerCreateCalls = 0;
  let runnerRunCalls = 0;
  let runnerRawParams: readonly Record<string, unknown>[] = [];
  let runnerReceived: RunnerParsed | undefined;
  let runnerContext: RunnerContext | undefined;

  const runnerDefinition: RunnerDefinition<RunnerParsed> = {
    type: "record-runner",
    parse: (params) => {
      runnerParseCalls += 1;
      runnerRawParams = [...runnerRawParams, params];
      return { label: `parsed:${String(params.marker)}`, compiled: 42 };
    },
    create: () => {
      runnerCreateCalls += 1;
      return {
        run: async (params, context) => {
          runnerRunCalls += 1;
          runnerReceived = params;
          runnerContext = context;
          await writeFile(join(context.workspaceDir, "runner.txt"), params.label);
          return { finalText: params.label, diagnostics: [] };
        },
        stop: async () => {},
      };
    },
  };

  let checkerParseCalls = 0;
  let checkerCreateCalls = 0;
  let checkerCheckCalls = 0;
  let checkerReceived: CheckerParsed | undefined;
  let checkerContext: CheckerContext | undefined;
  const checkerDefinition: CheckerDefinition<CheckerParsed> = {
    type: "record-checker",
    parse: (params) => {
      checkerParseCalls += 1;
      assert.equal(params.$type, undefined);
      return { label: `checker:${String(params.marker)}`, compiled: 7 };
    },
    create: () => {
      checkerCreateCalls += 1;
      return {
        check: async (params, context) => {
          checkerCheckCalls += 1;
          checkerReceived = params;
          checkerContext = context;
          return [{ checker: "record-checker", subject: params.label, status: "pass", reason: "opaque" }];
        },
      };
    },
  };

  addRunner(registry, runnerDefinition, "test");
  addChecker(registry, checkerDefinition, "test");

  const directory = await makeTempDir(t, "ae-typed-run-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "task",
      timeoutMs: 1_000,
      checks: [{ $type: "record-checker", marker: "declared-check" }],
      runner: { $type: "record-runner", marker: "declared-runner" },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-typed-results-");
  const tempParent = await makeTempDir(t, "ae-typed-tmp-");

  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent,
  });

  assert.equal(record.status, "pass", record.error);
  assert.equal(record.cleanup.status, "removed");
  assert.equal(runnerParseCalls, 1);
  assert.equal(runnerCreateCalls, 1);
  assert.equal(runnerRunCalls, 1);
  assert.equal(checkerParseCalls, 1);
  assert.equal(checkerCreateCalls, 1);
  assert.equal(checkerCheckCalls, 1);
  assert.equal(runnerRawParams.length, 1);
  assert.deepEqual(runnerRawParams[0], { marker: "declared-runner" });
  assert.deepEqual(runnerReceived, { label: "parsed:declared-runner", compiled: 42 });
  assert.deepEqual(checkerReceived, { label: "checker:declared-check", compiled: 7 });
  assert.equal(typeof runnerContext?.workspaceDir, "string");
  assert.equal(typeof checkerContext?.workspace.path, "string");
  assert.deepEqual(record.resolvedConfig.runner, { $type: "record-runner", marker: "declared-runner" });
  assert.deepEqual(record.resolvedConfig.checks[0], { $type: "record-checker", marker: "declared-check" });
  assert.equal(record.checks[0]?.status, "pass");
  assert.equal(record.checks[0]?.subject, "checker:declared-check");
  assert.deepEqual(await readdir(tempParent), []);
});
