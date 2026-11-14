import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadCase } from "../src/engine/authoring.ts";

const CASE = join(import.meta.dirname, "..", "examples/cases/deploy-runbook/case.yml");

// The worked example is documentation: nothing else loads it, so a mock whose
// answer no check asserts would drift silently and only a paid live run would
// notice.
test("the worked example's mocked answer is what its check asserts", async () => {
  const loaded = await loadCase(CASE, { caseName: "pi-with-skill" });
  const mock = loaded.config.mocks?.shell.deployctl;
  assert.ok(mock !== undefined, "the example declares the deployctl mock");
  const serial = /serial ([0-9A-F]+)/.exec(mock.stdout)?.[1];
  assert.ok(serial !== undefined, "the mocked answer reports a certificate serial");
  // The check only passes if that serial reached the agent through the mock.
  assert.ok(
    JSON.stringify(loaded.config.checks).includes(`"${serial}"`),
    `a check asserts the serial ${serial} from the mocked answer`,
  );
});
