import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadCase } from "../src/engine/authoring.ts";
import type { EvaluationRecord } from "../src/engine/results.ts";
import { runCliProcess } from "./helpers/cli-process.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const CASE = join(import.meta.dirname, "..", "examples/cases/notes-home/case.yml");

test("notes-home example resolves merged disjoint files across all arms", async () => {
  const withSkill = await loadCase(CASE, { caseName: "pi-with-skill" });
  assert.deepEqual(withSkill.config.files, {
    "~/notes": "home-notes",
    ".agents/skills/notes-policy": "skill",
  });

  const withoutSkill = await loadCase(CASE, { caseName: "pi-without-skill" });
  assert.deepEqual(withoutSkill.config.files, { "~/notes": "home-notes" });

  const baseline = await loadCase(CASE, { caseName: "baseline" });
  assert.equal(baseline.config.expect, "fail");
  assert.deepEqual(baseline.config.files, { "~/notes": "home-notes" });
});

test("notes-home baseline runs with noop, fails content checks as expected, and retains HOME artifacts when asked", async (t) => {
  const resultsDir = await makeTempDir(t, "ae-notes-home-results-");
  const runs = await makeTempDir(t, "ae-notes-home-tmp-");

  const run = await runCliProcess(
    t,
    CLI,
    ["run", CASE, "--case", "baseline", "--retain", "all", "--results-dir", resultsDir],
    { cwd: import.meta.dirname, env: { ...process.env, TMPDIR: runs } },
  );

  // Baseline expects failure, so exit code is 0 and the record marks status=fail with expect=fail.
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^run \S+: expected-fail$/m);

  const [runId] = await readdir(resultsDir);
  assert.ok(runId !== undefined);
  const record: EvaluationRecord = JSON.parse(await readFile(join(resultsDir, runId, "result.json"), "utf8"));
  assert.equal(record.status, "fail");
  assert.equal(record.artifacts?.status, "retained");

  // Both workspace fixture and HOME notes were retained for inspection.
  assert.match(
    await readFile(join(resultsDir, runId, "artifacts", "workspace", "session-notes.md"), "utf8"),
    /TLS 1\.3/,
  );
  assert.match(await readFile(join(resultsDir, runId, "artifacts", "home", "notes", "inbox.md"), "utf8"), /TLS 1\.3/);
});
