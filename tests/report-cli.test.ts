import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runCliProcess } from "./helpers/cli-process.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";

const ENTRY = join(import.meta.dirname, "..", "src", "cli.ts");

/** A case that passes without an agent: the check asserts a file the run never creates. */
const CASE = `input: noop
checks:
  - $type: file
    path: never-written.txt
    exists: false
runner:
  $type: noop
`;

async function cli(t: Parameters<typeof makeTempDir>[0], cwd: string, args: readonly string[]) {
  return await runCliProcess(t, ENTRY, args, { cwd, timeoutMs: 20_000 });
}

test("--reps runs each selected case the given number of times and reports the session", async (t) => {
  const directory = await makeTempDir(t, "ae-reps-");
  await writeFile(join(directory, "case.yml"), CASE);
  const results = join(directory, "results");

  const run = await cli(t, directory, ["run", "case.yml", "--reps", "3", "--results-dir", results]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /rep 1\/3/u);
  assert.match(run.stdout, /rep 3\/3/u);

  // One report for the invocation, one run directory per repetition, and no extra file.
  assert.match(run.stdout, /^runner noop · harness noop · model — · reps 3 · cases 1$/mu);
  assert.match(run.stdout, /^PASS +\(ordinary\) +3 runs/mu);
  assert.match(run.stdout, /^3 runs · 3 passed/mu);
  const entries = await readdir(results);
  assert.equal(entries.length, 3);
  assert.equal(entries.filter((name) => name.startsWith("report-")).length, 0);
});

test("one run prints its listing and its session report", async (t) => {
  const directory = await makeTempDir(t, "ae-reps-one-");
  await writeFile(join(directory, "case.yml"), CASE);
  const results = join(directory, "results");

  const run = await cli(t, directory, ["run", "case.yml", "--results-dir", results]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^run .*: pass$/mu);
  assert.match(run.stdout, /^runner noop · harness noop · model — · reps 1 · cases 1$/mu);
  assert.match(run.stdout, /^1 run · 1 passed/mu);
  const entries = await readdir(results);
  assert.equal(entries.length, 1, "no separate report file");
});

test("--reps must be a positive integer", async (t) => {
  const directory = await makeTempDir(t, "ae-reps-bad-");
  await writeFile(join(directory, "case.yml"), CASE);
  for (const value of ["0", "abc", "1.5", "9".repeat(30)]) {
    const run = await cli(t, directory, [
      "run",
      "case.yml",
      "--reps",
      value,
      "--results-dir",
      join(directory, "results"),
    ]);
    assert.equal(run.code, 2, `--reps ${value} should be a configuration error`);
    assert.match(run.stderr, /--reps must be a positive integer/u);
  }
  // A dash-prefixed value is rejected by the argument parser itself, before the count is read.
  const negative = await cli(t, directory, [
    "run",
    "case.yml",
    "--reps=-1",
    "--results-dir",
    join(directory, "results"),
  ]);
  assert.equal(negative.code, 2);
  assert.match(negative.stderr, /--reps must be a positive integer/u);
});

test("report counts a record once however many arguments reach it", async (t) => {
  const directory = await makeTempDir(t, "ae-report-dup-");
  await writeFile(join(directory, "case.yml"), CASE);
  const results = join(directory, "results");
  await cli(t, directory, ["run", "case.yml", "--results-dir", results]);
  const [runId] = await readdir(results);

  const report = await cli(t, directory, [
    "report",
    results,
    join(results, runId ?? ""),
    join(results, runId ?? "", "result.json"),
  ]);
  assert.equal(report.code, 0, report.stderr);
  assert.match(report.stdout, /^1 run · 1 passed/mu);
});

test("--reps belongs to run and is refused by the other commands", async (t) => {
  const directory = await makeTempDir(t, "ae-reps-scope-");
  await writeFile(join(directory, "case.yml"), CASE);
  for (const command of ["view", "config", "login"]) {
    const run = await cli(t, directory, [command, "case.yml", "--reps", "2"]);
    assert.equal(run.code, 2, `${command} accepted --reps`);
    assert.match(run.stderr, /--reps/u);
  }
});

test("report reads several directories and refuses one that holds no record", async (t) => {
  const directory = await makeTempDir(t, "ae-report-");
  await writeFile(join(directory, "case.yml"), CASE);
  const first = join(directory, "first");
  const second = join(directory, "second");
  await cli(t, directory, ["run", "case.yml", "--reps", "2", "--results-dir", first]);
  await cli(t, directory, ["run", "case.yml", "--reps", "1", "--results-dir", second]);

  const report = await cli(t, directory, ["report", first, second]);
  assert.equal(report.code, 0, report.stderr);
  // Both directories hold the same case document, so their runs form one session.
  assert.match(report.stdout, /^3 runs · 3 passed/mu);

  const empty = join(directory, "empty");
  await mkdir(empty);
  const missing = await cli(t, directory, ["report", empty]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no result\.json found under/u);
});

test("report accepts a single run directory or a result file", async (t) => {
  const directory = await makeTempDir(t, "ae-report-one-");
  await writeFile(join(directory, "case.yml"), CASE);
  const results = join(directory, "results");
  await cli(t, directory, ["run", "case.yml", "--results-dir", results]);
  const [runId] = await readdir(results);

  for (const path of [join(results, runId ?? ""), join(results, runId ?? "", "result.json")]) {
    const report = await cli(t, directory, ["report", path]);
    assert.equal(report.code, 0, report.stderr);
    assert.match(report.stdout, /^1 run · 1 passed/mu);
  }
});
