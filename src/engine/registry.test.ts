import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import { ConfigError } from "./config.ts";
import {
  addChecker,
  addRunner,
  createRegistry,
  loadTrustedImplementations,
  requireChecker,
  requireRunner,
} from "./registry.ts";

const fakeChecker = (type: string) => ({
  type,
  validate() {},
  create() {
    return { async check() { return []; } };
  },
});

const fakeRunner = (type: string) => ({
  type,
  validate() {},
  create() {
    return { async run() { return { finalText: null, diagnostics: [] }; }, async stop() {} };
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
  assert.throws(
    () => addRunner(registry, { type: "bad", validate() {} } as never, "test"),
    ConfigError,
  );
});

test("trusted directories load runner and checker modules", async (t) => {
  const checkers = await makeTempDir(t, "ae-trusted-checkers-");
  await writeFile(
    join(checkers, "custom-checker.ts"),
    `export const checker = { type: "custom", validate() {}, create() { return { async check() { return []; } }; } };\n`,
  );
  const runners = await makeTempDir(t, "ae-trusted-runners-");
  await writeFile(
    join(runners, "custom-runner.ts"),
    `export const runner = { type: "custom", validate() {}, create() { return { async run() { return { finalText: null, diagnostics: [] }; }, async stop() {} }; } };\n`,
  );

  const registry = createRegistry();
  await loadTrustedImplementations(registry, { runnerDirs: [runners], checkerDirs: [checkers] });
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
  const body = `export const checker = { type: "same", validate() {}, create() { return { async check() { return []; } }; } };\n`;
  await writeFile(join(first, "a.ts"), body);
  await writeFile(join(second, "b.ts"), body);

  await assert.rejects(
    () => loadTrustedImplementations(createRegistry(), { checkerDirs: [first, second] }),
    /duplicate checker implementation type "same"/,
  );
});
