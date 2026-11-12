import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { z } from "zod";
import { loadCase } from "../src/engine/authoring.ts";
import { ConfigError } from "../src/engine/config.ts";
import { createEnvSource } from "../src/engine/env-source.ts";
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
import { fileChecker } from "../src/checkers/file/checker.ts";
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
    envSource: createEnvSource(directory),
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

test("a declaration record distinguishes references from quoted literal strings", async (t) => {
  const registry = createRegistry();
  let received:
    | {
        reference: string;
        literal: string;
        items: string[];
        details: { value: string };
      }
    | undefined;
  addRunner(
    registry,
    {
      type: "record-values",
      params: z.strictObject({
        reference: z.string(),
        literal: z.string(),
        items: z.array(z.string()),
        details: z.strictObject({ value: z.string() }),
      }),
      create: (params) => {
        received = params;
        return {
          run: async (context) => {
            await writeFile(join(context.workspaceDir, "hello.txt"), "Hello, world!\n");
            return { finalText: "ok", diagnostics: [] };
          },
          stop: async () => {},
        };
      },
    },
    "test",
  );
  addChecker(registry, fileChecker, "test");

  const directory = await makeTempDir(t, "ae-typed-declaration-");
  const casePath = join(directory, "case.yml");
  await writeFile(join(directory, ".env"), "VALUE=resolved-value\n");
  await writeFile(
    casePath,
    [
      "input: task",
      "runner:",
      "  $type: record-values",
      "  reference: $env:VALUE",
      '  literal: "$env:VALUE"',
      "  items:",
      "    - $env:VALUE",
      "    - plain",
      "  details:",
      "    value: $env:VALUE",
      "checks:",
      "  - $type: file",
      "    path: hello.txt",
      "    exists: true",
    ].join("\n") + "\n",
  );
  const resultsDir = await makeTempDir(t, "ae-typed-declaration-results-");
  const tempParent = await makeTempDir(t, "ae-typed-declaration-tmp-");
  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent,
    envSource: createEnvSource(directory),
  });

  assert.equal(record.status, "pass", record.error);
  assert.deepEqual(received, {
    reference: "resolved-value",
    literal: "$env:VALUE",
    items: ["resolved-value", "plain"],
    details: { value: "resolved-value" },
  });
  assert.deepEqual(record.resolvedConfig.runner, {
    $type: "record-values",
    reference: "$env:VALUE",
    literal: "$env:VALUE",
    items: ["$env:VALUE", "plain"],
    details: { value: "$env:VALUE" },
  });
  assert.deepEqual(record.references, [
    { path: ["runner", "reference"], name: "VALUE" },
    { path: ["runner", "items", 0], name: "VALUE" },
    { path: ["runner", "details", "value"], name: "VALUE" },
  ]);
  const resultText = await readFile(join(resultsDir, record.runId, "result.json"), "utf8");
  assert.doesNotMatch(resultText, /resolved-value/);
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
  await writeFile(join(directory, ".env"), "EXTERNAL_TEXT=expanded-value\n");
  await writeFile(
    casePath,
    stringify({
      input: "task",
      checks: [{ $type: "receiver-checker", text: "$env:EXTERNAL_TEXT" }],
      runner: { $type: "receiver-runner", text: "$env:EXTERNAL_TEXT" },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-typed-external-results-");
  const tempParent = await makeTempDir(t, "ae-typed-external-tmp-");

  const record = await runEvaluation({
    case: await loadCase(casePath),
    registry,
    resultsDir,
    tempParent,
    envSource: createEnvSource(directory),
  });

  assert.equal(record.status, "pass", record.error);
  assert.equal(record.runner.finalText, "external:expanded-value");
  assert.equal(record.checks[0]?.subject, "external:expanded-value");
  assert.deepEqual(record.resolvedConfig.runner, { $type: "receiver-runner", text: "$env:EXTERNAL_TEXT" });
  assert.equal(record.checks[0]?.checker, "receiver-checker");
  assert.equal(record.cleanup.status, "removed");
  assert.deepEqual(await readdir(tempParent), []);
});

test("expanded values are validated by the implementation schema without coercion", async (t) => {
  const registry = createRegistry();
  addRunner(
    registry,
    {
      type: "typed-values",
      params: z.strictObject({ count: z.number(), enabled: z.boolean() }),
      create: () => {
        throw new Error("factory must not run for invalid expanded values");
      },
    },
    "test",
  );
  addChecker(registry, fileChecker, "test");

  const directory = await makeTempDir(t, "ae-typed-values-");
  const casePath = join(directory, "case.yml");
  await writeFile(join(directory, ".env"), "COUNT=123\nENABLED=true\n");
  await writeFile(
    casePath,
    stringify({
      input: "task",
      checks: [{ $type: "file", path: "hello.txt", exists: true }],
      runner: { $type: "typed-values", count: "$env:COUNT", enabled: "$env:ENABLED" },
    }),
  );
  const resultsDir = await makeTempDir(t, "ae-typed-values-results-");
  const tempParent = await makeTempDir(t, "ae-typed-values-tmp-");

  const loaded = await loadCase(casePath);
  await assert.rejects(
    () =>
      runEvaluation({
        case: loaded,
        registry,
        resultsDir,
        tempParent,
        envSource: createEnvSource(directory),
      }),
    ConfigError,
  );
  assert.deepEqual(await readdir(resultsDir), []);
  assert.deepEqual(await readdir(tempParent), []);
});
