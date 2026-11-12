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
  nested: z.strictObject({
    flag: z.boolean(),
    value: z.number().finite(),
  }),
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
    create: () => ({
      run: async (params) => {
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

function ordinaryConfig(fields: readonly string[]): string {
  return (
    [
      "input: task",
      "checks:",
      "  - $type: record-checker",
      "runner:",
      ...runnerYaml(fields)
        .split("\n")
        .map((line) => `  ${line}`),
    ].join("\n") + "\n"
  );
}

function namedConfig(fields: readonly string[]): string {
  return (
    [
      "input: task",
      "checks:",
      "  - $type: record-checker",
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

test("real YAML values preserve zero, false, empty arrays, and literal syntax through Zod", async (t) => {
  const { record, state, tempParent } = await execute(t, ordinaryConfig(validFields));
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
  assert.deepEqual(await readdir(tempParent), []);
  assert.equal(record.resolvedConfig.runner.count, 0);
  assert.equal(record.resolvedConfig.runner.enabled, false);
  assert.equal("mode" in record.resolvedConfig.runner, true);
});

test("missing fields apply schema defaults while explicit null fails unless nullable", async (t) => {
  const { record, state } = await execute(
    t,
    ordinaryConfig(["count: 1", "enabled: true", "label: plain", "list: []", "nested:", "  flag: true", "  value: 2"]),
  );
  assert.equal(record.status, "pass", record.error);
  assert.deepEqual(state.parsed(), {
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
  assert.equal(state.parsed()?.optional, undefined);
  assert.equal(state.parsed()?.nullable, undefined);
  assert.equal("mode" in record.resolvedConfig.runner, false);

  await assert.rejects(
    () => execute(t, ordinaryConfig(replaceField(validFields, "mode", "mode: null"))),
    (error: unknown) => error instanceof ConfigError && /parameter mode/.test(error.message),
  );
  await assert.rejects(
    () => execute(t, ordinaryConfig(replaceField(validFields, "flagsDefault", "flagsDefault: null"))),
    (error: unknown) => error instanceof ConfigError && /parameter flagsDefault/.test(error.message),
  );
});

test("quoted scalars and YAML 1.2 on/off/yes/no do not coerce to numbers or booleans", async (t) => {
  for (const field of ["count: '3'", "count: .nan", "count: .inf", "enabled: 'false'", "enabled: on", "enabled: yes"]) {
    const key = field.split(":")[0] ?? "";
    const fields = replaceField(validFields, key, field);
    await assert.rejects(
      () => execute(t, ordinaryConfig(fields)),
      (error: unknown) =>
        error instanceof ConfigError &&
        /parameter (count|enabled)/.test(error.message) &&
        /expected (number|boolean)/.test(error.message),
      field,
    );
  }
});

test("nested issue paths and unknown fields are reported centrally without raw values", async (t) => {
  await assert.rejects(
    () => execute(t, ordinaryConfig(replaceNestedFlag(validFields, "  flag: 'no'"))),
    (error: unknown) =>
      error instanceof ConfigError &&
      /parameter nested\.flag/.test(error.message) &&
      !error.message.includes("literal &pi"),
  );
  await assert.rejects(
    () => execute(t, ordinaryConfig([...validFields, "unknownField: secret-looking-value"])),
    (error: unknown) =>
      error instanceof ConfigError &&
      /parameters: Unrecognized key: "unknownField"/.test(error.message) &&
      !error.message.includes("secret-looking-value"),
  );
  await assert.rejects(
    () =>
      execute(
        t,
        ordinaryConfig([
          ...validFields.filter(
            (line) => line !== "nested:" && !line.startsWith("  flag:") && !line.startsWith("  value:"),
          ),
          "nested:",
          "  flag: false",
          "  value: 0",
          "  extra: nested-unknown",
        ]),
      ),
    (error: unknown) =>
      error instanceof ConfigError &&
      /parameter nested: Unrecognized key: "extra"/.test(error.message) &&
      !error.message.includes("nested-unknown"),
  );
});

test("named cases use the same YAML-to-Zod preparation path", async (t) => {
  const { record, state } = await execute(t, namedConfig(validFields), "selected");
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
});

test("invalid schema data fails before resources and never reaches run", async (t) => {
  const directory = await makeTempDir(t, "ae-yaml-schema-invalid-");
  const configPath = join(directory, "case.yml");
  await writeFile(configPath, ordinaryConfig(["count: '3'", ...validFields.slice(1)]));
  const tempParent = await makeTempDir(t, "ae-yaml-schema-invalid-runs-");
  const resultsDir = await makeTempDir(t, "ae-yaml-schema-invalid-results-");
  const state = harness();
  const loaded = await loadCase(configPath);

  await assert.rejects(
    () =>
      runEvaluation({
        case: loaded,
        registry: state.registry,
        resultsDir,
        tempParent,
      }),
    ConfigError,
  );
  assert.equal(state.runCalls(), 0);
  assert.deepEqual(await readdir(tempParent), []);
  assert.deepEqual(await readdir(resultsDir), []);
});
