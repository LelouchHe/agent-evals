import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { loadCase } from "../src/engine/authoring.ts";
import { ConfigError } from "../src/engine/config.ts";
import {
  addChecker,
  addRunner,
  createRegistry,
  type CheckerDefinition,
  type RunnerDefinition,
} from "../src/engine/registry.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const yamlParamsSchema = z.strictObject({
  count: z.number().finite(),
  enabled: z.boolean(),
  label: z.string(),
  list: z.array(z.string()),
  nested: z.strictObject({ flag: z.boolean(), value: z.number().finite() }),
  mode: z.enum(["a", "b"]).default("a"),
  optional: z.string().optional(),
  nullable: z.string().nullable().optional(),
  flagsDefault: z.array(z.string()).default([]),
  countDefault: z.number().default(7),
  falseDefault: z.boolean().default(true),
});
type YamlParams = z.output<typeof yamlParamsSchema>;

interface Harness {
  readonly registry: ReturnType<typeof createRegistry>;
  readonly parsed: () => YamlParams | undefined;
  readonly runCalls: () => number;
}

function harness(): Harness {
  let parsed: YamlParams | undefined;
  let runCalls = 0;
  const registry = createRegistry();
  const runner: RunnerDefinition<YamlParams> = {
    type: "record-runner",
    params: yamlParamsSchema,
    create: (params) => ({
      run: async () => {
        runCalls += 1;
        parsed = params;
        return { finalText: JSON.stringify(params), diagnostics: [] };
      },
      stop: async () => {},
    }),
  };
  const checker: CheckerDefinition<Record<string, never>> = {
    type: "record-checker",
    params: z.strictObject({}),
    create: () => ({ check: async () => [{ checker: "record-checker", subject: "ok", status: "pass", reason: "ok" }] }),
  };
  addRunner(registry, runner, "test");
  addChecker(registry, checker, "test");
  return { registry, parsed: () => parsed, runCalls: () => runCalls };
}

function runnerYaml(fields: readonly string[]): string {
  return ["$type: record-runner", ...fields].join("\n");
}

function config(fields: readonly string[], named: boolean): string {
  const prefix = ["input: task", "checks:", "  - $type: record-checker"];
  if (!named) {
    return (
      [
        ...prefix,
        "runner:",
        ...runnerYaml(fields)
          .split("\n")
          .map((line) => `  ${line}`),
      ].join("\n") + "\n"
    );
  }
  return (
    [
      ...prefix,
      "cases:",
      "  selected:",
      "    runner:",
      ...runnerYaml(fields)
        .split("\n")
        .map((line) => `      ${line}`),
    ].join("\n") + "\n"
  );
}

async function execute(
  t: Parameters<typeof makeTempDir>[0],
  yaml: string,
  caseName?: string,
): Promise<{
  record: Awaited<ReturnType<typeof runEvaluation>>;
  state: Harness;
  tempParent: string;
  resultsDir: string;
}> {
  const directory = await makeTempDir(t, "ae-yaml-schema-");
  const configPath = join(directory, "case.yml");
  await writeFile(configPath, yaml);
  const tempParent = await makeTempDir(t, "ae-yaml-schema-runs-");
  const resultsDir = await makeTempDir(t, "ae-yaml-schema-results-");
  const state = harness();
  const record = await runEvaluation({
    case: await loadCase(configPath, caseName === undefined ? {} : { caseName }),
    registry: state.registry,
    resultsDir,
    tempParent,
  });
  return { record, state, tempParent, resultsDir };
}

function replaceField(fields: readonly string[], key: string, line: string): string[] {
  return [...fields.filter((entry) => !entry.startsWith(`${key}:`)), line];
}

function replaceNestedFlag(fields: readonly string[], line: string): string[] {
  const index = fields.indexOf("nested:");
  return [...fields.slice(0, index + 1), line, "  value: 1", ...fields.slice(index + 3)];
}

const validFields = [
  "count: 0",
  "enabled: false",
  "label: 'literal &pi *pi <<: text'",
  "list: []",
  "nested:",
  "  flag: false",
  "  value: 0",
  "mode: b",
  "optional: present",
  "nullable: null",
  "flagsDefault: []",
  "countDefault: 0",
  "falseDefault: false",
];

test("real YAML values, defaults, and falsy values reach the factory and raw declarations stay raw", async (t) => {
  const { record, state, tempParent } = await execute(t, config(validFields, false));
  assert.equal(record.status, "pass", record.error);
  assert.deepEqual(state.parsed(), {
    count: 0,
    enabled: false,
    label: "literal &pi *pi <<: text",
    list: [],
    nested: { flag: false, value: 0 },
    mode: "b",
    optional: "present",
    nullable: null,
    flagsDefault: [],
    countDefault: 0,
    falseDefault: false,
  });
  assert.equal(state.runCalls(), 1);
  assert.deepEqual(await readdir(tempParent), []);
  assert.equal(record.resolvedConfig.runner.count, 0);
  assert.equal(record.resolvedConfig.runner.enabled, false);
  assert.equal("mode" in record.resolvedConfig.runner, true);

  const missing = await execute(
    t,
    config(["count: 1", "enabled: true", "label: plain", "list: []", "nested:", "  flag: true", "  value: 2"], false),
  );
  assert.deepEqual(missing.state.parsed(), {
    count: 1,
    enabled: true,
    label: "plain",
    list: [],
    nested: { flag: true, value: 2 },
    mode: "a",
    flagsDefault: [],
    countDefault: 7,
    falseDefault: true,
  });
  assert.equal(missing.state.parsed()?.optional, undefined);
  assert.equal(missing.state.parsed()?.nullable, undefined);
  assert.equal("mode" in missing.record.resolvedConfig.runner, false);
  assert.equal("countDefault" in missing.record.resolvedConfig.runner, false);
});

test("invalid YAML-derived schema values fail before resources and never reach run", async (t) => {
  const invalid = [
    replaceField(validFields, "count", "count: '3'"),
    replaceField(validFields, "count", "count: .nan"),
    replaceField(validFields, "count", "count: .inf"),
    replaceField(validFields, "enabled", "enabled: 'false'"),
    replaceField(validFields, "enabled", "enabled: on"),
    replaceField(validFields, "enabled", "enabled: yes"),
    replaceField(validFields, "mode", "mode: null"),
    replaceField(validFields, "flagsDefault", "flagsDefault: null"),
    validFields.filter((line) => !line.startsWith("count:")),
    replaceNestedFlag(validFields, "  flag: 'no'"),
    [...validFields, "unknownField: secret-looking-value"],
  ];
  for (const fields of invalid) {
    await assert.rejects(
      () => execute(t, config(fields, false)),
      (error: unknown) => error instanceof ConfigError && !error.message.includes("secret-looking-value"),
    );
  }

  const directory = await makeTempDir(t, "ae-yaml-schema-invalid-");
  const configPath = join(directory, "case.yml");
  await writeFile(configPath, config(replaceField(validFields, "count", "count: '3'"), false));
  const tempParent = await makeTempDir(t, "ae-yaml-schema-invalid-runs-");
  const resultsDir = await makeTempDir(t, "ae-yaml-schema-invalid-results-");
  const state = harness();
  const loaded = await loadCase(configPath);
  await assert.rejects(
    () => runEvaluation({ case: loaded, registry: state.registry, resultsDir, tempParent }),
    ConfigError,
  );
  assert.equal(state.runCalls(), 0);
  assert.deepEqual(await readdir(tempParent), []);
  assert.deepEqual(await readdir(resultsDir), []);
});

test("named cases use the same YAML-to-Zod preparation path", async (t) => {
  const { record, state } = await execute(t, config(validFields, true), "selected");
  assert.equal(record.status, "pass", record.error);
  assert.equal(record.case.name, "selected");
  assert.deepEqual(state.parsed(), {
    count: 0,
    enabled: false,
    label: "literal &pi *pi <<: text",
    list: [],
    nested: { flag: false, value: 0 },
    mode: "b",
    optional: "present",
    nullable: null,
    flagsDefault: [],
    countDefault: 0,
    falseDefault: false,
  });
  assert.deepEqual(record.resolvedConfig.runner, {
    $type: "record-runner",
    count: 0,
    enabled: false,
    label: "literal &pi *pi <<: text",
    list: [],
    nested: { flag: false, value: 0 },
    mode: "b",
    optional: "present",
    nullable: null,
    flagsDefault: [],
    countDefault: 0,
    falseDefault: false,
  });
});
