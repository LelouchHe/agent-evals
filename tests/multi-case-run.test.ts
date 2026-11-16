import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import type { EvaluationRecord } from "../src/engine/results.ts";
import { runCliProcess } from "./helpers/cli-process.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

interface MultiCaseRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly directory: string;
  readonly resultsDir: string;
}

async function runDocument(
  t: TestContext,
  cases: Record<string, unknown>,
  options: { readonly args?: readonly string[] } = {},
): Promise<MultiCaseRun> {
  const directory = await makeTempDir(t, "ae-multi-case-");
  const runs = join(directory, "runs");
  await mkdir(runs);
  const resultsDir = join(directory, "results");
  const path = join(directory, "case.yml");
  await writeFile(path, stringify({ input: "task", cases }));
  const result = await runCliProcess(t, CLI, ["run", path, "--results-dir", resultsDir, ...(options.args ?? [])], {
    cwd: directory,
    env: { ...process.env, TMPDIR: runs },
  });
  return { ...result, directory, resultsDir };
}

interface CaseLine {
  readonly name: string;
  readonly status: string;
  readonly result: string;
}

function caseLines(stdout: string): CaseLine[] {
  return stdout
    .trimEnd()
    .split("\n")
    .map((line) => {
      const match = /^(\S+): (pass|fail|error|timeout|cancelled) (.+)$/.exec(line);
      assert.ok(match !== null, `unexpected output line: ${line}`);
      return { name: match[1]!, status: match[2]!, result: match[3]! };
    });
}

function noopCase(checks: readonly unknown[]): Record<string, unknown> {
  return { runner: { $type: "noop" }, checks };
}

test("run without --case runs every case in order and a failure does not stop the rest", async (t) => {
  const run = await runDocument(t, {
    first: noopCase([{ $type: "file", path: "hello.txt", exists: false }]),
    second: noopCase([{ $type: "file", path: "hello.txt", exists: true }]),
    third: noopCase([{ $type: "file", path: "hello.txt", exists: false }]),
  });

  assert.equal(run.code, 1);
  const lines = caseLines(run.stdout);
  assert.deepEqual(
    lines.map((line) => [line.name, line.status]),
    [
      ["first", "pass"],
      ["second", "fail"],
      ["third", "pass"],
    ],
  );

  // Every case got its own ordinary result record, and the printed path is where it is.
  const directories = await readdir(run.resultsDir);
  assert.equal(directories.length, 3);
  for (const line of lines) {
    const record: EvaluationRecord = JSON.parse(await readFile(line.result, "utf8"));
    assert.equal(record.status, line.status);
    assert.equal(record.case.name, line.name);
  }
});

test("run exits zero only when every case of the document passed", async (t) => {
  const run = await runDocument(t, {
    first: noopCase([{ $type: "file", path: "hello.txt", exists: false }]),
    second: noopCase([{ $type: "file", path: "hello.txt", exists: false }]),
  });
  assert.equal(run.code, 0);
  assert.deepEqual(
    caseLines(run.stdout).map((line) => line.status),
    ["pass", "pass"],
  );
});

test("a configuration error in any selected case runs none of them", async (t) => {
  const run = await runDocument(t, {
    first: noopCase([{ $type: "file", path: "hello.txt", exists: false }]),
    second: { runner: { $type: "noop" }, checks: [{ $type: "file", path: "hello.txt" }], surprise: true },
  });

  assert.equal(run.code, 2);
  assert.match(run.stderr, /configuration error: .*surprise/);
  // The first case was validated but never executed, so it wrote no result record.
  await assert.rejects(readdir(run.resultsDir), { code: "ENOENT" });
});

test("--case still runs exactly the named case of a multi-case document", async (t) => {
  const run = await runDocument(
    t,
    {
      first: noopCase([{ $type: "file", path: "hello.txt", exists: false }]),
      second: noopCase([{ $type: "file", path: "hello.txt", exists: true }]),
    },
    { args: ["--case", "first"] },
  );

  assert.equal(run.code, 0);
  assert.match(run.stdout, /^run \S+: pass$/m);
  assert.match(run.stdout, /^ {2}case: first \(/m);
  assert.equal((await readdir(run.resultsDir)).length, 1);
});
