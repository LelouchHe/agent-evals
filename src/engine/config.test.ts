import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import { ConfigError, loadCandidate, loadCase, resolveAuthoringAsset } from "./config.ts";

test("loadCase parses a real YAML case and keeps implementation parameters opaque", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "case.yml");
  await writeFile(
    path,
    [
      "input: Create hello.txt",
      "timeoutMs: 1234",
      "fixture: fixture",
      "checks:",
      "  - $type: file",
      "    path: hello.txt",
      "    exists: true",
      "  - $type: judge",
      "    model: p/m",
      "    rubric: [one, two]",
    ].join("\n"),
  );

  const loaded = await loadCase(path);
  assert.equal(loaded.dir, dir);
  assert.equal(loaded.config.input, "Create hello.txt");
  assert.equal(loaded.config.timeoutMs, 1234);
  assert.equal(loaded.config.fixture, "fixture");
  assert.equal(loaded.config.checks[0]?.$type, "file");
  assert.deepEqual(loaded.config.checks[1]?.rubric, ["one", "two"]);
});

test("loadCandidate parses the runner record", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "candidate.yml");
  await writeFile(path, "name: baseline\nrunner:\n  $type: pi\n  model: p/m\n  thinking: high\n");

  const loaded = await loadCandidate(path);
  assert.equal(loaded.config.name, "baseline");
  assert.equal(loaded.config.runner.$type, "pi");
  assert.equal(loaded.config.runner.thinking, "high");
});

test("configuration errors are explicit and occur before parsing completes", async (t) => {
  const dir = await makeTempDir(t);
  const cases: Array<[string, string]> = [
    ["invalid.yml", "input: [unterminated"],
    ["scalar.yml", "just-a-string"],
    ["unknown.yml", "input: task\nunknown: true\nchecks:\n  - $type: file\n    path: a\n    exists: true\n"],
    ["no-input.yml", "checks:\n  - $type: file\n    path: a\n    exists: true\n"],
    ["no-checks.yml", "input: task\nchecks: []\n"],
    ["absolute-fixture.yml", "input: task\nfixture: /etc\nchecks:\n  - $type: file\n    path: a\n    exists: true\n"],
    ["bad-timeout.yml", "input: task\ntimeoutMs: 1.5\nchecks:\n  - $type: file\n    path: a\n    exists: true\n"],
    ["missing-type.yml", "input: task\nchecks:\n  - path: a\n"],
  ];

  for (const [name, body] of cases) {
    const path = join(dir, name);
    await writeFile(path, body);
    await assert.rejects(() => loadCase(path), ConfigError, name);
  }

  const candidate = join(dir, "candidate.yml");
  await writeFile(candidate, "runner:\n  model: p/m\n");
  await assert.rejects(() => loadCandidate(candidate), ConfigError);
});

test("authoring assets resolve relative to the declaring configuration", async (t) => {
  const declaring = await makeTempDir(t, "ae-config-");
  await mkdir(join(declaring, "skill"));
  const resolved = resolveAuthoringAsset(declaring, "skill", "candidate.skills[0]");
  assert.equal(resolved, join(declaring, "skill"));
  assert.throws(() => resolveAuthoringAsset(declaring, "/absolute", "asset"), ConfigError);
});
