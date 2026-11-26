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

/**
 * The per-case lines a multi-case run prints, stopping before the session report that follows them.
 * The report itself is covered by `report.test.ts`; here it is output to skip, not to assert.
 */
function caseLines(stdout: string): CaseLine[] {
  const [head = ""] = stdout.split("\n\n");
  return head
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const match = /^(\S+): (pass|fail|error|timeout|cancelled|expected-fail|unexpected-pass) (.+)$/.exec(line);
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

test("a negative case that fails its checks exits zero and says the failure was expected", async (t) => {
  const run = await runDocument(t, {
    baseline: {
      ...noopCase([{ $type: "file", path: "hello.txt", exists: true }]),
      expect: "fail",
    },
  });

  assert.equal(run.code, 0);
  assert.deepEqual(
    caseLines(run.stdout).map((line) => [line.name, line.status]),
    [["baseline", "expected-fail"]],
  );
  assert.match(run.stdout, /^EXPECTED FAIL baseline/mu);
  assert.match(run.stdout, /^1 run · 1 fail \(1 expected\)/mu);
});

test("a negative case that passes is an unexpected pass and exits nonzero", async (t) => {
  const run = await runDocument(t, {
    baseline: {
      ...noopCase([{ $type: "file", path: "hello.txt", exists: false }]),
      expect: "fail",
    },
  });

  assert.equal(run.code, 1);
  assert.deepEqual(
    caseLines(run.stdout).map((line) => [line.name, line.status]),
    [["baseline", "unexpected-pass"]],
  );
  assert.match(run.stdout, /^UNEXPECTED PASS baseline/mu);
});

test("expect accepts only pass or fail", async (t) => {
  const run = await runDocument(t, {
    first: { ...noopCase([{ $type: "file", path: "hello.txt", exists: false }]), expect: "maybe" },
  });

  assert.equal(run.code, 2);
  assert.match(run.stderr, /expect must be "pass" or "fail"/);
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
  // The first case is valid; the second fails only when its implementation parameters are
  // validated, which must happen for every case before the first one executes.
  const run = await runDocument(t, {
    first: noopCase([{ $type: "file", path: "hello.txt", exists: false }]),
    second: noopCase([{ $type: "file", path: "hello.txt", matches: { nested: true } }]),
  });

  assert.equal(run.code, 2);
  assert.match(run.stderr, /configuration error: .*matches/);
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
    { args: ["--case", "second"] },
  );

  // The named case is the failing one, so a selection that fell back to the first case would
  // pass and report the wrong name.
  assert.equal(run.code, 1);
  assert.match(run.stdout, /^run \S+: fail$/m);
  assert.match(run.stdout, /^ {2}case: second \(/m);
  assert.equal((await readdir(run.resultsDir)).length, 1);
});

test("--jobs runs cases concurrently up to the limit and preserves declaration order in output", async (t) => {
  const directory = await makeTempDir(t, "ae-jobs-");
  const runs = join(directory, "runs");
  const resultsDir = join(directory, "results");
  const extensionDir = join(directory, "extensions");
  await mkdir(runs);
  await mkdir(join(extensionDir, "timed"), { recursive: true });
  // Track concurrent runs in-process and delay the first case longer than the second so we
  // prove both bounded parallelism (active <= 2, peak === 2) and deterministic output ordering.
  await writeFile(
    join(extensionDir, "timed", "index.mjs"),
    `
let active = 0;
let peak = 0;
export const runner = {
  type: "timed",
  params: {
    async safeParseAsync(raw) {
      return { success: true, data: { delayMs: Number(raw.delayMs ?? 0) } };
    },
  },
  create(parsed) {
    return {
      async run() {
        active += 1;
        if (active > peak) peak = active;
        await new Promise((resolve) => setTimeout(resolve, parsed.delayMs));
        const seenPeak = peak;
        active -= 1;
        return { finalText: "peak=" + seenPeak, diagnostics: [] };
      },
      async stop() {},
    };
  },
};
`,
  );
  const path = join(directory, "case.yml");
  await writeFile(
    path,
    stringify({
      input: "task",
      checks: [{ $type: "file", path: "missing.txt", exists: false }],
      cases: {
        slow: { runner: { $type: "timed", delayMs: 200 } },
        fast: { runner: { $type: "timed", delayMs: 40 } },
        third: { runner: { $type: "timed", delayMs: 120 } },
      },
    }),
  );

  const run = await runCliProcess(
    t,
    CLI,
    ["run", path, "--jobs", "2", "--extension-dir", extensionDir, "--results-dir", resultsDir],
    { cwd: directory, env: { ...process.env, TMPDIR: runs } },
  );

  assert.equal(run.code, 0, run.stderr);
  const lines = caseLines(run.stdout);
  assert.deepEqual(
    lines.map((line) => line.name),
    ["slow", "fast", "third"],
  );
  const peaks = await Promise.all(
    lines.map(async (line) => {
      const record: EvaluationRecord = JSON.parse(await readFile(line.result, "utf8"));
      return record.runner.finalText;
    }),
  );
  assert.ok(peaks.includes("peak=2"), `expected peak concurrency of 2, got ${JSON.stringify(peaks)}`);
  assert.ok(!peaks.includes("peak=3"), `concurrency exceeded --jobs 2: ${JSON.stringify(peaks)}`);
});

test("--jobs rejects non-positive values and commands other than run", async (t) => {
  const zero = await runDocument(
    t,
    { first: noopCase([{ $type: "file", path: "hello.txt", exists: false }]) },
    { args: ["--jobs", "0"] },
  );
  assert.equal(zero.code, 2);
  assert.match(zero.stderr, /--jobs must be a positive integer/);

  const directory = await makeTempDir(t, "ae-jobs-view-");
  const path = join(directory, "case.yml");
  await writeFile(path, stringify({ input: "task", runner: { $type: "noop" }, checks: [] }));
  const viewRun = await runCliProcess(t, CLI, ["view", path, "--jobs", "2"], { cwd: directory });
  assert.equal(viewRun.code, 2);
  assert.match(viewRun.stderr, /view does not accept .*--jobs/);
});
