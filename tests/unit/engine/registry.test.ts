import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { makeTempDir } from "../../helpers/fake-pi-control.ts";
import { ConfigError } from "../../../src/engine/config.ts";
import {
  addChecker,
  addRunner,
  createRegistry,
  loadTrustedImplementations,
  requireChecker,
  requireRunner,
  type CheckerDefinition,
  type RunnerDefinition,
} from "../../../src/engine/registry.ts";

interface FakeParams {
  readonly marker: string;
}
const fakeParamsSchema = z.strictObject({ marker: z.string() });

const fakeChecker = (type: string): CheckerDefinition<FakeParams> => ({
  type,
  params: fakeParamsSchema,
  create: (params) => ({
    check: async () => {
      void params.marker;
      return [];
    },
  }),
});

const fakeRunner = (type: string): RunnerDefinition<FakeParams> => ({
  type,
  params: fakeParamsSchema,
  create: (params) => ({
    run: async () => ({ finalText: params.marker, diagnostics: [] }),
    stop: async () => {},
  }),
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

test("trusted extension directories load runner and checker implementations", async (t) => {
  const extensions = await makeTempDir(t, "ae-trusted-extensions-");
  await mkdir(join(extensions, "custom-checker"));
  await writeFile(
    join(extensions, "custom-checker", "index.ts"),
    `${zodImport}export const checker = {
  type: "custom",
  params: z.strictObject({ raw: z.boolean() }).transform(async () => ({ token: "external-checker" })),
  create(params) {
    return { async check() { return [{ checker: "custom", subject: params.token, status: "pass", reason: "ok" }]; } };
  },
};
`,
  );
  await mkdir(join(extensions, "custom-runner"));
  await writeFile(
    join(extensions, "custom-runner", "index.ts"),
    `${zodImport}export const runner = {
  type: "custom",
  params: z.strictObject({ raw: z.boolean() }).transform(() => ({ token: "external-runner" })),
  create(params) {
    return { async run() { return { finalText: params.token, diagnostics: [] }; }, async stop() {} };
  },
};
`,
  );

  const registry = createRegistry();
  await loadTrustedImplementations(registry, { extensionDirs: [extensions] });
  assert.equal(requireChecker(registry, "custom").type, "custom");
  assert.equal(requireRunner(registry, "custom").type, "custom");
});

test("an extension entry point may import helper files from its directory", async (t) => {
  const extensions = await makeTempDir(t, "ae-trusted-helpers-");
  const implementation = join(extensions, "with-helper");
  await mkdir(implementation);
  await writeFile(join(implementation, "helper.ts"), 'export const checkerType = "helper-heavy";\n');
  await writeFile(
    join(implementation, "index.ts"),
    `${zodImport}import { checkerType } from "./helper.ts";
export const checker = {
  type: checkerType,
  params: z.strictObject({}),
  create() {
    return { async check() { return []; } };
  },
};
`,
  );

  const registry = createRegistry();
  await loadTrustedImplementations(registry, { extensionDirs: [extensions] });
  assert.equal(requireChecker(registry, "helper-heavy").type, "helper-heavy");
});

test("trusted discovery fails closed for malformed extensions", async (t) => {
  const missingExport = await makeTempDir(t, "ae-trusted-bad-");
  await mkdir(join(missingExport, "missing-export"));
  await writeFile(join(missingExport, "missing-export", "index.ts"), "export const other = 1;\n");
  await assert.rejects(
    () => loadTrustedImplementations(createRegistry(), { extensionDirs: [missingExport] }),
    /must export a named "runner" or "checker" implementation/,
  );

  const syntax = await makeTempDir(t, "ae-trusted-syntax-");
  await mkdir(join(syntax, "broken"));
  await writeFile(join(syntax, "broken", "index.ts"), "export const checker = {;\n");
  await assert.rejects(
    () => loadTrustedImplementations(createRegistry(), { extensionDirs: [syntax] }),
    /failed to load extension/,
  );

  await assert.rejects(
    () => loadTrustedImplementations(createRegistry(), { extensionDirs: [join(syntax, "missing")] }),
    /trusted extension directory .* is not readable/,
  );
});

test("a subdirectory without an entry point is a configuration error", async (t) => {
  const extensions = await makeTempDir(t, "ae-trusted-no-entry-");
  await mkdir(join(extensions, "misspelled"));
  await writeFile(join(extensions, "misspelled", "indx.ts"), "export const checker = {};\n");

  await assert.rejects(
    () => loadTrustedImplementations(createRegistry(), { extensionDirs: [extensions] }),
    /has no index\.ts, index\.js, or index\.mjs entry point/,
  );
});

test("trusted discovery skips node_modules and dot-directories at the extension root", async (t) => {
  const extensions = await makeTempDir(t, "ae-trusted-dependencies-");
  await mkdir(join(extensions, "node_modules", "dependency"), { recursive: true });
  await writeFile(join(extensions, "node_modules", "dependency", "index.ts"), "export const other = 1;\n");
  // An extension root that is itself a repository holds `.git`, which is not an implementation.
  await mkdir(join(extensions, ".git"));
  await mkdir(join(extensions, "custom"));
  await writeFile(
    join(extensions, "custom", "index.ts"),
    `${zodImport}export const checker = { type: "custom", params: z.strictObject({}), create() { return { async check() { return []; } }; } };\n`,
  );

  const registry = createRegistry();
  await loadTrustedImplementations(registry, { extensionDirs: [extensions] });
  assert.equal(requireChecker(registry, "custom").type, "custom");
});

test("trusted extension directories reject duplicate implementation types", async (t) => {
  const first = await makeTempDir(t, "ae-trusted-dup-a-");
  const second = await makeTempDir(t, "ae-trusted-dup-b-");
  await mkdir(join(first, "a"));
  await mkdir(join(second, "b"));
  const body = `${zodImport}export const checker = { type: "same", params: z.strictObject({}), create() { return { async check() { return []; } }; } };\n`;
  await writeFile(join(first, "a", "index.ts"), body);
  await writeFile(join(second, "b", "index.ts"), body);

  await assert.rejects(
    () => loadTrustedImplementations(createRegistry(), { extensionDirs: [first, second] }),
    /duplicate checker implementation type "same"/,
  );
});
