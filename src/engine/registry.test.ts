import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import { ConfigError, type ImplementationParams } from "./config.ts";
import {
  addChecker,
  addRunner,
  createRegistry,
  loadTrustedImplementations,
  requireChecker,
  requireRunner,
  type CheckerContext,
  type CheckerDefinition,
  type RunnerContext,
  type RunnerDefinition,
} from "./registry.ts";

const fakeParamsSchema = z.strictObject({ marker: z.string() });
type FakeParams = z.output<typeof fakeParamsSchema>;

const fakeChecker = (type: string): CheckerDefinition<FakeParams> => ({
  type,
  params: fakeParamsSchema,
  create() {
    return {
      check: async (params) => {
        void params.marker;
        return [];
      },
    };
  },
});

const fakeRunner = (type: string): RunnerDefinition<FakeParams> => ({
  type,
  params: fakeParamsSchema,
  create() {
    return {
      run: async (params) => ({ finalText: params.marker, diagnostics: [] }),
      stop: async () => {},
    };
  },
});

test("registry rejects duplicate types and reports unknown implementations", () => {
  const registry = createRegistry();
  addChecker(registry, fakeChecker("fake"), "test");
  assert.throws(() => addChecker(registry, fakeChecker("fake"), "test"), ConfigError);
  addRunner(registry, fakeRunner("fake"), "test");
  assert.throws(() => addRunner(registry, fakeRunner("fake"), "test"), ConfigError);

  assert.throws(() => requireChecker(registry, "missing"), /unknown checker implementation "missing"/);
  assert.throws(() => requireRunner(registry, "missing"), /unknown runner implementation "missing"/);
});

test("registry rejects malformed implementation definitions", () => {
  const registry = createRegistry();
  assert.throws(() => addChecker(registry, {} as never, "test"), ConfigError);
  assert.throws(() => addRunner(registry, { type: "bad", params: fakeParamsSchema } as never, "test"), ConfigError);
  assert.throws(() => addChecker(registry, { type: "bad", params: {}, create() {} } as never, "test"), ConfigError);
});

const zodImport = `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};\n`;

test("trusted directories load runner and checker modules with sync and async schemas", async (t) => {
  const checkers = await makeTempDir(t, "ae-trusted-checkers-");
  await writeFile(
    join(checkers, "custom-checker.ts"),
    `${zodImport}export const checker = {
  type: "custom",
  params: z.strictObject({ raw: z.boolean() }).transform(async () => ({ token: "external-checker-parsed" })),
  create(params) {
    return { async check() { return [{ checker: "custom", subject: params.token, status: "pass", reason: "ok" }]; } };
  },
};
`,
  );
  const runners = await makeTempDir(t, "ae-trusted-runners-");
  await writeFile(
    join(runners, "custom-runner.ts"),
    `${zodImport}export const runner = {
  type: "custom",
  params: z.strictObject({ raw: z.boolean() }).transform(() => ({ token: "external-runner-parsed" })),
  create(params) {
    return { async run() { return { finalText: params.token, diagnostics: [] }; }, async stop() {} };
  },
};
`,
  );

  const registry = createRegistry();
  await loadTrustedImplementations(registry, { runnerDirs: [runners], checkerDirs: [checkers] });
  const runner = await requireRunner(registry, "custom").prepare({ raw: true }, checkers);
  const outcome = await runner.run({
    workspaceDir: "/run/workspace",
    homeDir: "/run/home",
    configDir: "/run/config",
    scratchDir: "/run/scratch",
    runRootDir: "/run",
    input: "task",
    authoringDir: checkers,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  });
  assert.equal(outcome.finalText, "external-runner-parsed");

  const checker = await requireChecker(registry, "custom").prepare({ raw: true }, checkers);
  const results = await checker.check({} as CheckerContext);
  assert.equal(results[0]?.subject, "external-checker-parsed");
  assert.equal(requireChecker(registry, "custom").type, "custom");
  assert.equal(requireRunner(registry, "custom").type, "custom");
});

test("trusted discovery fails closed for malformed modules", async (t) => {
  const directory = await makeTempDir(t, "ae-trusted-bad-");
  await writeFile(join(directory, "missing-export.ts"), "export const other = 1;\n");
  const registry = createRegistry();
  await assert.rejects(
    () => loadTrustedImplementations(registry, { checkerDirs: [directory] }),
    /must export a named "checker" implementation/,
  );

  const syntax = await makeTempDir(t, "ae-trusted-syntax-");
  await writeFile(join(syntax, "broken.ts"), "export const checker = {;\n");
  await assert.rejects(
    () => loadTrustedImplementations(createRegistry(), { checkerDirs: [syntax] }),
    /failed to load checker implementation/,
  );

  await assert.rejects(
    () => loadTrustedImplementations(createRegistry(), { checkerDirs: [join(syntax, "missing")] }),
    /trusted checker directory .* is not readable/,
  );
});

test("trusted directories reject duplicate implementation types", async (t) => {
  const first = await makeTempDir(t, "ae-trusted-dup-a-");
  const second = await makeTempDir(t, "ae-trusted-dup-b-");
  const body = `${zodImport}export const checker = { type: "same", params: z.strictObject({}), create() { return { async check() { return []; } }; } };\n`;
  await writeFile(join(first, "a.ts"), body);
  await writeFile(join(second, "b.ts"), body);

  await assert.rejects(
    () => loadTrustedImplementations(createRegistry(), { checkerDirs: [first, second] }),
    /duplicate checker implementation type "same"/,
  );
});

test("preparation validates once and binds each parsed shape to its own instance", async () => {
  interface RunnerParsed {
    readonly label: string;
    readonly compiled: number;
  }
  interface CheckerAParsed {
    readonly kind: "a";
    readonly compiled: string;
  }
  interface CheckerBParsed {
    readonly kind: "b";
    readonly compiled: number;
  }

  const registry = createRegistry();
  let runnerParseCalls = 0;
  let runnerCreateCalls = 0;
  let runnerRaw: ImplementationParams | undefined;
  let runnerReceived: RunnerParsed | undefined;
  const runnerParsed: RunnerParsed = { label: "runner-sentinel", compiled: 42 };
  const runnerSchema = z.strictObject({ value: z.string() }).transform((raw): RunnerParsed => {
    runnerParseCalls += 1;
    runnerRaw = raw;
    return runnerParsed;
  });
  addRunner(
    registry,
    {
      type: "typed-runner",
      params: runnerSchema,
      create: () => {
        runnerCreateCalls += 1;
        return {
          run: async (params) => {
            runnerReceived = params;
            return { finalText: params.label, diagnostics: [] };
          },
          stop: async () => {},
        };
      },
    },
    "test",
  );

  let checkerAParseCalls = 0;
  let checkerAReceived: CheckerAParsed | undefined;
  const checkerAParsed: CheckerAParsed = { kind: "a", compiled: "a-sentinel" };
  const checkerASchema = z.strictObject({ kind: z.literal("raw-a") }).transform((): CheckerAParsed => {
    checkerAParseCalls += 1;
    return checkerAParsed;
  });
  addChecker(
    registry,
    {
      type: "typed-checker-a",
      params: checkerASchema,
      create: () => ({
        check: async (params) => {
          checkerAReceived = params;
          return [];
        },
      }),
    },
    "test",
  );

  let checkerBParseCalls = 0;
  let checkerBReceived: CheckerBParsed | undefined;
  const checkerBParsed: CheckerBParsed = { kind: "b", compiled: 7 };
  const checkerBSchema = z.strictObject({ kind: z.literal("raw-b") }).transform(async (): Promise<CheckerBParsed> => {
    checkerBParseCalls += 1;
    return checkerBParsed;
  });
  addChecker(
    registry,
    {
      type: "typed-checker-b",
      params: checkerBSchema,
      create: () => ({
        check: async (params) => {
          checkerBReceived = params;
          return [];
        },
      }),
    },
    "test",
  );

  const raw = { value: "raw" };
  const preparedRunner = await requireRunner(registry, "typed-runner").prepare(raw, "/authoring");
  assert.equal(runnerParseCalls, 1);
  assert.equal(runnerCreateCalls, 1);
  assert.deepEqual(runnerRaw, raw);

  const preparedCheckerA = await requireChecker(registry, "typed-checker-a").prepare({ kind: "raw-a" }, "/authoring");
  const preparedCheckerB = await requireChecker(registry, "typed-checker-b").prepare({ kind: "raw-b" }, "/authoring");
  assert.equal(checkerAParseCalls, 1);
  assert.equal(checkerBParseCalls, 1);
  assert.equal(checkerAReceived, undefined);
  assert.equal(checkerBReceived, undefined);

  const context: RunnerContext = {
    workspaceDir: "/run/workspace",
    homeDir: "/run/home",
    configDir: "/run/config",
    scratchDir: "/run/scratch",
    runRootDir: "/run",
    input: "task",
    authoringDir: "/authoring",
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  };
  const outcome = await preparedRunner.run(context);
  assert.equal(outcome.finalText, "runner-sentinel");
  assert.equal(runnerParseCalls, 1);
  assert.equal(runnerReceived, runnerParsed);

  await preparedCheckerA.check({} as CheckerContext);
  await preparedCheckerB.check({} as CheckerContext);
  assert.equal(checkerAReceived, checkerAParsed);
  assert.equal(checkerBReceived, checkerBParsed);
  assert.equal(checkerAParseCalls, 1);
  assert.equal(checkerBParseCalls, 1);
});

test("schema failures stop preparation before an instance is created or run", async () => {
  const registry = createRegistry();
  let createCalls = 0;
  addRunner(
    registry,
    {
      type: "failing-runner",
      params: z.strictObject({ raw: z.literal(false) }),
      create: () => {
        createCalls += 1;
        return { run: async () => ({ finalText: null, diagnostics: [] }), stop: async () => {} };
      },
    },
    "test",
  );

  await assert.rejects(
    () => requireRunner(registry, "failing-runner").prepare({ raw: true }, "/authoring"),
    /runner "failing-runner" parameter raw/,
  );
  assert.equal(createCalls, 0);
});

function receiverRunnerModule(type: string): string {
  return `${zodImport}const base = z.strictObject({ text: z.string() }).transform((input) => ({ text: input.text, compiled: 7 }));
let parseCalls = 0;
const paramsSchema = new Proxy(base, {
  get(target, property, receiver) {
    if (property === "parseCalls") return parseCalls;
    if (property === "safeParseAsync") {
      return async function (input) {
        if (this !== paramsSchema) throw new Error("schema receiver lost");
        parseCalls += 1;
        return base.safeParseAsync(input);
      };
    }
    return Reflect.get(target, property, receiver);
  },
});
export const runner = {
  type: ${JSON.stringify(type)},
  params: paramsSchema,
  createCalls: 0,
  create(params) {
    if (this !== runner) throw new Error("create receiver lost");
    this.createCalls += 1;
    return {
      marker: "runner-instance",
      async run(runParams) {
        if (this?.marker !== "runner-instance") throw new Error("run receiver lost");
        return { finalText: \`parsed:\${runParams.text}:\${runParams.compiled}\`, diagnostics: [] };
      },
      async stop() {
        if (this?.marker !== "runner-instance") throw new Error("stop receiver lost");
      },
    };
  },
};
`;
}

function receiverCheckerModule(type: string): string {
  return `${zodImport}const base = z.strictObject({ text: z.string() }).transform((input) => ({ text: input.text, compiled: 3 }));
let parseCalls = 0;
const paramsSchema = new Proxy(base, {
  get(target, property, receiver) {
    if (property === "parseCalls") return parseCalls;
    if (property === "safeParseAsync") {
      return async function (input) {
        if (this !== paramsSchema) throw new Error("checker schema receiver lost");
        parseCalls += 1;
        return base.safeParseAsync(input);
      };
    }
    return Reflect.get(target, property, receiver);
  },
});
export const checker = {
  type: ${JSON.stringify(type)},
  params: paramsSchema,
  createCalls: 0,
  create(params) {
    if (this !== checker) throw new Error("checker create receiver lost");
    this.createCalls += 1;
    return {
      marker: "checker-instance",
      async check(checkParams) {
        if (this?.marker !== "checker-instance") throw new Error("check receiver lost");
        return [{ checker: "receiver-checker", subject: \`parsed:\${checkParams.text}:\${checkParams.compiled}\`, status: "pass", reason: "ok" }];
      },
    };
  },
};
`;
}

function createReceiverRunnerModule(type: string): string {
  return `${zodImport}export const runner = {
  type: ${JSON.stringify(type)},
  createCalls: 0,
  params: z.strictObject({ text: z.string() }).transform((params) => ({ text: params.text, compiled: 7 })),
  create(params) {
    if (this !== runner) throw new Error("create receiver lost");
    this.createCalls += 1;
    return {
      marker: "runner-instance",
      async run(runParams) {
        if (this?.marker !== "runner-instance") throw new Error("run receiver lost");
        return { finalText: \`parsed:\${runParams.text}:\${runParams.compiled}\`, diagnostics: [] };
      },
      async stop() {},
    };
  },
};
`;
}

function createReceiverCheckerModule(type: string): string {
  return `${zodImport}export const checker = {
  type: ${JSON.stringify(type)},
  createCalls: 0,
  params: z.strictObject({ text: z.string() }).transform((params) => ({ text: params.text, compiled: 3 })),
  create(params) {
    if (this !== checker) throw new Error("checker create receiver lost");
    this.createCalls += 1;
    return {
      marker: "checker-instance",
      async check(checkParams) {
        if (this?.marker !== "checker-instance") throw new Error("check receiver lost");
        return [{ checker: "receiver-checker", subject: \`parsed:\${checkParams.text}:\${checkParams.compiled}\`, status: "pass", reason: "ok" }];
      },
    };
  },
};
`;
}

interface ReceiverParams {
  readonly text: string;
  readonly compiled: number;
}
interface ReceiverRunnerExported {
  readonly createCalls: number;
  readonly params: { readonly parseCalls: number };
}
interface ReceiverCheckerExported {
  readonly createCalls: number;
  readonly params: { readonly parseCalls: number };
}

const runnerContext: RunnerContext = {
  workspaceDir: "/run/workspace",
  homeDir: "/run/home",
  configDir: "/run/config",
  scratchDir: "/run/scratch",
  runRootDir: "/run",
  input: "task",
  authoringDir: "/authoring",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};

test("direct and trusted discovery preserve definition and schema receivers", async (t) => {
  const directRunnerDir = await makeTempDir(t, "ae-receiver-direct-runner-");
  const directCheckerDir = await makeTempDir(t, "ae-receiver-direct-checker-");
  const discoveredRunnerDir = await makeTempDir(t, "ae-receiver-discovered-runner-");
  const discoveredCheckerDir = await makeTempDir(t, "ae-receiver-discovered-checker-");
  await writeFile(join(directRunnerDir, "runner.mjs"), receiverRunnerModule("receiver-direct-runner"));
  await writeFile(join(directCheckerDir, "checker.mjs"), receiverCheckerModule("receiver-direct-checker"));
  await writeFile(join(discoveredRunnerDir, "runner.mjs"), receiverRunnerModule("receiver-discovered-runner"));
  await writeFile(join(discoveredCheckerDir, "checker.mjs"), receiverCheckerModule("receiver-discovered-checker"));

  const directRunnerModule = (await import(pathToFileURL(join(directRunnerDir, "runner.mjs")).href)) as {
    runner: RunnerDefinition<ReceiverParams> & ReceiverRunnerExported;
  };
  const directCheckerModule = (await import(pathToFileURL(join(directCheckerDir, "checker.mjs")).href)) as {
    checker: CheckerDefinition<ReceiverParams> & ReceiverCheckerExported;
  };
  const directRegistry = createRegistry();
  addRunner(directRegistry, directRunnerModule.runner, "direct");
  addChecker(directRegistry, directCheckerModule.checker, "direct");

  const directRunner = await requireRunner(directRegistry, "receiver-direct-runner").prepare(
    { text: "direct" },
    directRunnerDir,
  );
  const directRun = await directRunner.run(runnerContext);
  await directRunner.stop();
  const directChecker = await requireChecker(directRegistry, "receiver-direct-checker").prepare(
    { text: "direct" },
    directCheckerDir,
  );
  const directChecks = await directChecker.check({} as CheckerContext);

  assert.equal(directRun.finalText, "parsed:direct:7");
  assert.equal(directChecks[0]?.subject, "parsed:direct:3");
  assert.equal(directRunnerModule.runner.params.parseCalls, 1);
  assert.equal(directRunnerModule.runner.createCalls, 1);
  assert.equal(directCheckerModule.checker.params.parseCalls, 1);
  assert.equal(directCheckerModule.checker.createCalls, 1);

  const discoveredRegistry = createRegistry();
  await loadTrustedImplementations(discoveredRegistry, {
    runnerDirs: [discoveredRunnerDir],
    checkerDirs: [discoveredCheckerDir],
  });
  const discoveredRunnerModule = (await import(pathToFileURL(join(discoveredRunnerDir, "runner.mjs")).href)) as {
    runner: ReceiverRunnerExported;
  };
  const discoveredCheckerModule = (await import(pathToFileURL(join(discoveredCheckerDir, "checker.mjs")).href)) as {
    checker: ReceiverCheckerExported;
  };

  const discoveredRunner = await requireRunner(discoveredRegistry, "receiver-discovered-runner").prepare(
    { text: "discovered" },
    discoveredRunnerDir,
  );
  const discoveredRun = await discoveredRunner.run(runnerContext);
  await discoveredRunner.stop();
  const discoveredChecker = await requireChecker(discoveredRegistry, "receiver-discovered-checker").prepare(
    { text: "discovered" },
    discoveredCheckerDir,
  );
  const discoveredChecks = await discoveredChecker.check({} as CheckerContext);

  assert.equal(discoveredRun.finalText, "parsed:discovered:7");
  assert.equal(discoveredChecks[0]?.subject, "parsed:discovered:3");
  assert.equal(discoveredRunnerModule.runner.params.parseCalls, 1);
  assert.equal(discoveredRunnerModule.runner.createCalls, 1);
  assert.equal(discoveredCheckerModule.checker.params.parseCalls, 1);
  assert.equal(discoveredCheckerModule.checker.createCalls, 1);
});

test("trusted discovery preserves create receivers independently of schema style", async (t) => {
  const runnerDir = await makeTempDir(t, "ae-create-receiver-runner-");
  const checkerDir = await makeTempDir(t, "ae-create-receiver-checker-");
  await writeFile(join(runnerDir, "runner.mjs"), createReceiverRunnerModule("create-receiver-runner"));
  await writeFile(join(checkerDir, "checker.mjs"), createReceiverCheckerModule("create-receiver-checker"));

  const registry = createRegistry();
  await loadTrustedImplementations(registry, { runnerDirs: [runnerDir], checkerDirs: [checkerDir] });
  const runnerModule = (await import(pathToFileURL(join(runnerDir, "runner.mjs")).href)) as {
    runner: { readonly createCalls: number };
  };
  const checkerModule = (await import(pathToFileURL(join(checkerDir, "checker.mjs")).href)) as {
    checker: { readonly createCalls: number };
  };

  const runner = await requireRunner(registry, "create-receiver-runner").prepare({ text: "create" }, runnerDir);
  const outcome = await runner.run(runnerContext);
  await runner.stop();
  const checker = await requireChecker(registry, "create-receiver-checker").prepare({ text: "create" }, checkerDir);
  const checks = await checker.check({} as CheckerContext);

  assert.equal(outcome.finalText, "parsed:create:7");
  assert.equal(checks[0]?.subject, "parsed:create:3");
  assert.equal(runnerModule.runner.createCalls, 1);
  assert.equal(checkerModule.checker.createCalls, 1);
});
