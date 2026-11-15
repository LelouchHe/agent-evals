import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileChecker } from "../src/checkers/file/checker.ts";
import { mockChecker } from "../src/checkers/mock/checker.ts";
import { loadCase } from "../src/engine/authoring.ts";
import type { MockRule, ResolvedCase } from "../src/engine/config.ts";
import { parseImplementationParams } from "../src/engine/params.ts";
import { addChecker, addRunner, createRegistry, type CheckerContext } from "../src/engine/registry.ts";
import { searches } from "../src/engine/regex.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { openRunRoot } from "../src/engine/workspace.ts";
import { noopRunner } from "../src/runners/noop/runner.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";
import { implementationContext, unusedCheckSandbox } from "./helpers/implementation-context.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples/cases/deploy-runbook");
const CASE = join(EXAMPLE, "case.yml");

function actions(loaded: ResolvedCase): Readonly<Record<string, readonly MockRule[]>> {
  return loaded.config.mocks?.shell ?? {};
}

function patternsOf(loaded: ResolvedCase): readonly string[] {
  return loaded.config.checks.flatMap((check) => patternStrings(check));
}

// The worked example is documentation: nothing else loads it, so an action nobody exercises or
// a response no check asserts would drift silently and only a paid live run would notice.
test("the worked example exercises every mock action and its checks assert the responses", async () => {
  const loaded = await loadCase(CASE, { caseName: "pi-with-skill" });
  const shell = actions(loaded);
  const patterns = patternsOf(loaded);

  // return: the status answer, whose serial only it reveals.
  const status = shell.deployctl?.[0]?.action;
  assert.equal(status?.kind, "return");
  const serial = /serial ([0-9A-F]+)/.exec(status.kind === "return" ? status.result.stdout : "")?.[1];
  assert.ok(serial !== undefined, "the mocked answer reports a certificate serial");

  // run: the author's program, whose build id only it prints.
  const facts = shell["release-facts"]?.[0]?.action;
  assert.equal(facts?.kind, "run");
  const script = await readFile(join(EXAMPLE, "mocks/release-facts.sh"), "utf8");
  const build = /build: (\S+)/.exec(script)?.[1];
  assert.ok(build !== undefined, "the run program prints a build id");

  // pass: the real platform command, reachable only through a pass rule.
  const uname = shell.uname ?? [];
  assert.deepEqual(uname[0]?.args?.positional, [{ source: "-s", regex: false }]);
  assert.equal(uname[0]?.action.kind, "pass");

  // The private cause and fix stay in the skill: no mocked answer hands them over.
  for (const rules of Object.values(shell)) {
    for (const rule of rules) {
      if (rule.action.kind === "return") {
        assert.doesNotMatch(rule.action.result.stdout, /expired|rotate-signing-cert/i);
      }
    }
  }

  // Each fact is asserted by a check pattern that really matches the response line.
  for (const [line, label] of [
    [`signing-cert: serial ${serial}`, "the serial from the mocked status"],
    [`build: ${build}`, "the build id from the run program"],
    ["Darwin", "the platform from the passed command"],
  ] as const) {
    assert.ok(
      patterns.some((pattern) => searches(pattern, line)),
      `${label} is asserted by a check`,
    );
  }
});

test("the worked example's mocked answer is what its check asserts", async (t) => {
  const loaded = await loadCase(CASE, { caseName: "pi-with-skill" });
  const rule = actions(loaded).deployctl?.[0];
  assert.ok(rule?.action.kind === "return", "the example declares the deployctl mock");
  const mock = rule.action.result;
  const serial = /serial ([0-9A-F]+)/.exec(mock.stdout)?.[1];
  assert.ok(serial !== undefined, "the mocked answer reports a certificate serial");

  // Exactly one file check on diagnosis.md must assert that serial, and the real
  // checker must accept evidence carrying it and reject evidence without it.
  const asserted = loaded.config.checks.filter(
    (check) => check.$type === "file" && check.path === "diagnosis.md" && matchPatterns(check).includes(serial),
  );
  assert.equal(asserted.length, 1, "one file check asserts the mocked serial in diagnosis.md");
  const { $type: _type, ...params } = asserted[0] as (typeof loaded.config.checks)[number];

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
    checkSandbox: unusedCheckSandbox,
  };
  const checker = await fileChecker.create(
    await parseImplementationParams(fileChecker.params, params, 'checker "file"'),
    implementationContext(process.cwd()),
  );

  await writeFile(join(workspace, "diagnosis.md"), `E4127, signing-cert serial ${serial}\n`);
  assert.deepEqual(
    (await checker.check(context)).map((resultValue) => resultValue.status),
    ["pass"],
  );

  await writeFile(join(workspace, "diagnosis.md"), "E4127, cause and fix only\n");
  assert.deepEqual(
    (await checker.check(context)).map((resultValue) => resultValue.status),
    ["fail"],
  );
});

function matchPatterns(check: Readonly<Record<string, unknown>>): readonly unknown[] {
  return typeof check.matches === "string" ? [check.matches] : Array.isArray(check.matches) ? check.matches : [];
}

function patternStrings(check: Readonly<Record<string, unknown>>): readonly string[] {
  return matchPatterns(check).filter((pattern): pattern is string => typeof pattern === "string");
}

// The deterministic half of the trace judge's restraint question: a fix command that does run
// would be refused and recorded, so `times: 0` fails instead of only being judged.
test("the worked example refuses make and asserts that no call reached it", async () => {
  const loaded = await loadCase(CASE, { caseName: "pi-with-skill" });
  const make = actions(loaded).make;
  assert.ok(make !== undefined && make.length > 0, "the example declares make");
  assert.deepEqual(
    make.map((rule) => rule.action.kind),
    ["refuse"],
    "every make call is refused, so the check can prove absence",
  );
  assert.deepEqual(
    loaded.config.checks.filter((check) => check.$type === "mock"),
    [{ $type: "mock", shell: ["make"], times: 0 }],
  );
  assert.ok(
    loaded.config.checks.some((check) => check.$type === "judge" && check.trace === true),
    "the trace judge asking the same question stays",
  );
});

test("the worked example's baseline case fails positive checks and passes restraint checks under noop", async (t) => {
  const loaded = await loadCase(CASE, { caseName: "baseline" });
  assert.deepEqual(loaded.config.runner, { $type: "noop" });

  // Strip only the model-calling judges so the deterministic baseline runs offline.
  const deterministic = {
    ...loaded,
    config: {
      ...loaded.config,
      checks: loaded.config.checks.filter((check) => check.$type !== "judge"),
    },
  };
  const registry = createRegistry();
  addRunner(registry, noopRunner, "built-in");
  addChecker(registry, fileChecker, "built-in");
  addChecker(registry, mockChecker, "built-in");

  const record = await runEvaluation({
    case: deterministic,
    registry,
    resultsDir: await makeTempDir(t, "ae-example-baseline-results-"),
    tempParent: await makeTempDir(t, "ae-example-baseline-runs-"),
  });
  assert.equal(record.status, "fail");
  assert.deepEqual(
    record.checks.map((check) => [check.checker, check.status]),
    [
      ["file", "fail"],
      ["file", "fail"],
      ["file", "fail"],
      ["file", "fail"],
      ["file", "pass"],
      ["mock", "pass"],
    ],
  );
});
