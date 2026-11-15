import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileChecker } from "../src/checkers/file/checker.ts";
import { loadCase } from "../src/engine/authoring.ts";
import type { ImplementationRecord } from "../src/engine/config.ts";
import { parseImplementationParams } from "../src/engine/params.ts";
import type { CheckerContext } from "../src/engine/registry.ts";
import { openRunRoot } from "../src/engine/workspace.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";
import { implementationContext } from "./helpers/implementation-context.ts";

const CASE = join(import.meta.dirname, "..", "examples/cases/deploy-runbook/case.yml");

function matchPatterns(check: ImplementationRecord): readonly unknown[] {
  const patterns = check.matches;
  return typeof patterns === "string" ? [patterns] : Array.isArray(patterns) ? patterns : [];
}

// The worked example is documentation: nothing else loads it, so a mock whose
// answer no check asserts would drift silently and only a paid live run would
// notice.
test("the worked example's mocked answer is what its check asserts", async (t) => {
  const loaded = await loadCase(CASE, { caseName: "pi-with-skill" });
  const mock = loaded.config.mocks?.shell.deployctl;
  assert.ok(mock !== undefined, "the example declares the deployctl mock");
  const serial = /serial ([0-9A-F]+)/.exec(mock.stdout)?.[1];
  assert.ok(serial !== undefined, "the mocked answer reports a certificate serial");
  // The cause and the fix are the skill's private knowledge; the mock only
  // reports release state, which the fixture log already implies.
  assert.doesNotMatch(mock.stdout, /expired|rotate-signing-cert/i);

  // Exactly one file check on diagnosis.md must assert that serial, and the real
  // checker must accept evidence carrying it and reject evidence without it.
  const asserted = loaded.config.checks.filter(
    (check) => check.$type === "file" && check.path === "diagnosis.md" && matchPatterns(check).includes(serial),
  );
  assert.equal(asserted.length, 1, "one file check asserts the mocked serial in diagnosis.md");
  const { $type: _type, ...params } = asserted[0] as ImplementationRecord;

  const root = await makeTempDir(t, "ae-example-diagnosis-");
  const workspace = join(root, "workspace");
  const baseline = join(root, "baseline");
  await mkdir(workspace);
  await mkdir(baseline);
  const context: CheckerContext = {
    workspace: await openRunRoot(workspace),
    baseline: await openRunRoot(baseline),
    runRootDir: root,
    input: "task",
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(5_000),
  };
  const checker = await fileChecker.create(
    await parseImplementationParams(fileChecker.params, params, 'checker "file"'),
    implementationContext(process.cwd()),
  );

  await writeFile(join(workspace, "diagnosis.md"), `E4127, signing-cert serial ${serial}\n`);
  assert.deepEqual(
    (await checker.check(context)).map((result) => result.status),
    ["pass"],
  );

  await writeFile(join(workspace, "diagnosis.md"), "E4127, cause and fix only\n");
  assert.deepEqual(
    (await checker.check(context)).map((result) => result.status),
    ["fail"],
  );
});
