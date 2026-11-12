import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { z } from "zod";
import { loadCase } from "../src/engine/authoring.ts";
import {
  addChecker,
  addRunner,
  createRegistry,
  loadTrustedImplementations,
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

  const runnerSchema = z.strictObject({ marker: z.string() }).transform((params): RunnerParsed => {
    runnerParseCalls += 1;
    runnerRawParams = [...runnerRawParams, params];
    return { label: `parsed:${params.marker}`, compiled: 42 };
  });
  const runnerDefinition: RunnerDefinition<RunnerParsed> = {
    type: "record-runner",
    params: runnerSchema,
    create: (params) => {
      runnerCreateCalls += 1;
      runnerReceived = params;
      return {
        run: async (context) => {
          runnerRunCalls += 1;
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
  const checkerSchema = z.strictObject({ marker: z.string() }).transform((params): CheckerParsed => {
    checkerParseCalls += 1;
    return { label: `checker:${params.marker}`, compiled: 7 };
  });
  const checkerDefinition: CheckerDefinition<CheckerParsed> = {
    type: "record-checker",
    params: checkerSchema,
    create: (params) => {
      checkerCreateCalls += 1;
      checkerReceived = params;
      return {
        check: async (context) => {
          checkerCheckCalls += 1;
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

test("a discovered extension executes through shared factory preparation", async (t) => {
  const zodUrl = import.meta.resolve("zod");
  const runnerDir = await makeTempDir(t, "ae-typed-external-runner-");
  const checkerDir = await makeTempDir(t, "ae-typed-external-checker-");
  await writeFile(
    join(runnerDir, "runner.mjs"),
    `import { z } from ${JSON.stringify(zodUrl)};
export const runner = {
  type: "receiver-runner",
  params: z.strictObject({ text: z.string() }).transform((params) => ({ text: params.text })),
  async create(params) {
    if (this !== runner) throw new Error("create receiver lost");
    return {
      async run() {
        return { finalText: \`external:\${params.text}\`, diagnostics: [] };
      },
      async stop() {},
    };
  },
};
`,
  );
  await writeFile(
    join(checkerDir, "checker.mjs"),
    `import { z } from ${JSON.stringify(zodUrl)};
export const checker = {
  type: "receiver-checker",
  params: z.strictObject({ text: z.string() }).transform((params) => ({ text: params.text })),
  async create(params) {
    if (this !== checker) throw new Error("checker create receiver lost");
    return {
      async check() {
        return [{ checker: "receiver-checker", subject: \`external:\${params.text}\`, status: "pass", reason: "ok" }];
      },
    };
  },
};
`,
  );

  const registry = createRegistry();
  await loadTrustedImplementations(registry, { runnerDirs: [runnerDir], checkerDirs: [checkerDir] });
  const directory = await makeTempDir(t, "ae-typed-external-case-");
  const casePath = join(directory, "case.yml");
  await writeFile(
    casePath,
    stringify({
      input: "task",
      checks: [{ $type: "receiver-checker", text: "declared-check" }],
      runner: { $type: "receiver-runner", text: "declared-runner" },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-typed-external-results-");
  const tempParent = await makeTempDir(t, "ae-typed-external-tmp-");

  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent,
  });

  assert.equal(record.status, "pass", record.error);
  assert.equal(record.runner.finalText, "external:declared-runner");
  assert.equal(record.checks[0]?.subject, "external:declared-check");
  assert.deepEqual(record.resolvedConfig.runner, { $type: "receiver-runner", text: "declared-runner" });
  assert.equal(record.cleanup.status, "removed");
  assert.deepEqual(await readdir(tempParent), []);
});
