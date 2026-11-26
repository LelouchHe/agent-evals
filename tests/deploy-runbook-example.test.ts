import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileChecker } from "../src/checkers/file/index.ts";
import { mockChecker } from "../src/checkers/mock/index.ts";
import { shellChecker } from "../src/checkers/shell/index.ts";
import { traceChecker } from "../src/checkers/trace/index.ts";
import { loadCase } from "../src/engine/authoring.ts";
import { parsePatternScalar, type MockRule, type PatternSyntax, type ResolvedCase } from "../src/engine/config.ts";
import { parseImplementationParams } from "../src/engine/params.ts";
import {
  addChecker,
  addRunner,
  createRegistry,
  type CheckerContext,
  type RunnerDefinition,
} from "../src/engine/registry.ts";
import { searches } from "../src/engine/regex.ts";
import { runEvaluation } from "../src/engine/run.ts";
import { openRunRoot } from "../src/engine/workspace.ts";
import { noopRunner } from "../src/runners/noop/index.ts";
import { makeTempDir } from "./helpers/fake-pi-control.ts";
import { z } from "zod";
import { implementationContext, unusedCheckSandbox } from "./helpers/implementation-context.ts";
import { isSandboxPlatformSupported } from "../src/platform/index.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples/cases/deploy-runbook-posix");
const CASE = join(EXAMPLE, "case.yml");

function actions(loaded: ResolvedCase): Readonly<Record<string, readonly MockRule[]>> {
  return loaded.config.mocks?.shell ?? {};
}

function patternsOf(loaded: ResolvedCase): readonly PatternSyntax[] {
  return loaded.config.checks.flatMap((check) => parsedPatterns(check));
}

/** The check's declared patterns under the checker's own literal-or-/…/ rule. */
function parsedPatterns(check: Readonly<Record<string, unknown>>): readonly PatternSyntax[] {
  return matchPatterns(check).map((value) => {
    const parsed = parsePatternScalar(value);
    assert.ok(parsed.kind === "pattern", `the example declares a valid pattern: ${String(value)}`);
    return parsed.pattern;
  });
}

function patternFound(pattern: PatternSyntax, text: string): boolean {
  return pattern.regex ? searches(pattern.source, text) : text.includes(pattern.source);
}

// The worked example is documentation: nothing else loads it, so an action nobody exercises or
// a response no check asserts would drift silently and only a paid live run would notice.
test("the worked example exercises every mock action and its checks assert the responses", async () => {
  for (const caseName of [
    "pi-with-skill",
    "pi-without-skill",
    "claude-with-skill",
    "claude-without-skill",
    "copilot-with-skill",
    "copilot-without-skill",
    "baseline",
  ]) {
    await loadCase(CASE, { caseName });
  }
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
      patterns.some((pattern) => patternFound(pattern, line)),
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
  const home = join(root, "home");
  const homeBaseline = join(root, "home-baseline");
  await mkdir(workspace);
  await mkdir(baseline);
  await mkdir(home);
  await mkdir(homeBaseline);
  const context: CheckerContext = {
    workspace: await openRunRoot(workspace),
    baseline: await openRunRoot(baseline),
    home: await openRunRoot(home),
    homeBaseline: await openRunRoot(homeBaseline),
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

// The consultation is asserted deterministically, so the judge no longer carries it.
test("the worked example asserts the skill consultation with a trace check", async () => {
  const loaded = await loadCase(CASE, { caseName: "pi-with-skill" });
  assert.deepEqual(
    loaded.config.checks.filter((check) => check.$type === "trace"),
    [{ $type: "trace", event: "skill", name: "deploy-runbook" }],
  );
  const traceJudges = loaded.config.checks.filter((check) => check.$type === "judge" && check.trace === true);
  assert.equal(traceJudges.length, 1, "the restraint judge keeps its trace evidence");
  const rubric = (traceJudges[0] as { readonly rubric?: readonly string[] } | undefined)?.rubric ?? [];
  assert.deepEqual(
    rubric.filter((statement) => /consult/i.test(statement)),
    [],
    "no judge statement asks whether the skill was consulted",
  );
});

test("the worked example runs one fixture script and one check-time acceptance script", async () => {
  const loaded = await loadCase(CASE, { caseName: "pi-with-skill" });
  const shells = loaded.config.checks.filter((check) => check.$type === "shell");
  assert.equal(shells.length, 2);

  const [internal, external] = shells;
  assert.ok(internal);
  assert.deepEqual((internal as { readonly run?: readonly string[] }).run, ["sh", "checks/check-diagnosis.sh"]);
  // The fixture script must be proven unchanged before the check runs it.
  assert.ok(
    loaded.config.checks
      .slice(0, loaded.config.checks.indexOf(internal))
      .some((check) => check.$type === "file" && check.path === "checks/check-diagnosis.sh" && check.changed === false),
    "a file changed: false check on the fixture script precedes the shell check",
  );

  // The acceptance script is placed only at check time and is not in the fixture.
  assert.ok(external);
  assert.deepEqual((external as { readonly files?: Readonly<Record<string, string>> }).files, {
    "checks/acceptance.sh": "checks/acceptance.sh",
  });
  assert.deepEqual((external as { readonly run?: readonly string[] }).run, ["sh", "checks/acceptance.sh"]);

  const fixtureScript = await readFile(join(EXAMPLE, "fixture/checks/check-diagnosis.sh"), "utf8");
  assert.doesNotMatch(fixtureScript, /rotate-signing-cert|make deploy|expired/i);
  const acceptance = await readFile(join(EXAMPLE, "checks/acceptance.sh"), "utf8");
  assert.match(acceptance, /rotate-signing-cert/);
  assert.match(acceptance, /make deploy/);
  await assert.rejects(readFile(join(EXAMPLE, "fixture/checks/acceptance.sh")));
});

const VALID_DIAGNOSIS = `Error E4127: the artifact signing certificate expired for release 2.8.1, build 2.8.1-b41, on Darwin.
The release state reports signing-cert serial 41A7.
Fix: make rotate-signing-cert, then make deploy.
`;

const diagnosisRunner: RunnerDefinition<{ readonly content: string }> = {
  type: "write-diagnosis",
  params: z.strictObject({ content: z.string() }),
  mocks: true,
  home: true,
  create: (params) => ({
    run: async (context) => {
      await writeFile(join(context.workspaceDir, "diagnosis.md"), params.content);
      return { finalText: params.content, diagnostics: [] };
    },
    stop: async () => {},
    // A completed skill tool call, the form Claude Code and Copilot CLI report.
    trace: () => [
      {
        type: "tool",
        toolCallId: "call-skill",
        title: "Load skill: deploy-runbook",
        kind: "other",
        status: "completed",
        rawInput: { skill: "deploy-runbook" },
      },
    ],
  }),
};

function deterministicCase(loaded: ResolvedCase, runner: ResolvedCase["config"]["runner"]): ResolvedCase {
  return {
    ...loaded,
    config: {
      ...loaded.config,
      runner,
      checks: loaded.config.checks.filter((check) => check.$type !== "judge"),
    },
  };
}

function deterministicRegistry() {
  const registry = createRegistry();
  addRunner(registry, noopRunner, "built-in");
  addChecker(registry, fileChecker, "built-in");
  addChecker(registry, mockChecker, "built-in");
  addChecker(registry, shellChecker, "built-in");
  addChecker(registry, traceChecker, "built-in");
  return registry;
}

test(
  "the worked example's baseline case fails positive checks and passes restraint checks under noop",
  {
    skip: !isSandboxPlatformSupported || process.platform === "win32",
  },
  async (t) => {
    const loaded = await loadCase(CASE, { caseName: "baseline" });
    assert.deepEqual(loaded.config.runner, { $type: "noop" });
    // The worked example is where the field is first read, so it has to declare it.
    assert.equal(loaded.config.expect, "fail");
    // Strip only the model-calling judges so the deterministic baseline runs offline.
    const record = await runEvaluation({
      case: deterministicCase(loaded, { $type: "noop" }),
      registry: deterministicRegistry(),
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
        ["file", "fail"],
        ["file", "pass"],
        ["file", "pass"],
        ["file", "pass"],
        ["shell", "fail"],
        ["shell", "fail"],
        ["trace", "fail"],
        ["mock", "pass"],
      ],
    );
  },
);

test(
  "both shell checks pass on a valid diagnosis",
  {
    skip: !isSandboxPlatformSupported || process.platform === "win32",
  },
  async (t) => {
    const loaded = await loadCase(CASE, { caseName: "baseline" });
    const registry = deterministicRegistry();
    addRunner(registry, diagnosisRunner, "test");
    const record = await runEvaluation({
      case: deterministicCase(loaded, { $type: "write-diagnosis", content: VALID_DIAGNOSIS }),
      registry,
      resultsDir: await makeTempDir(t, "ae-example-valid-results-"),
      tempParent: await makeTempDir(t, "ae-example-valid-runs-"),
    });
    assert.equal(record.status, "pass", record.error);
    assert.deepEqual(
      record.checks.map((check) => [check.checker, check.status]),
      [
        ["file", "pass"],
        ["file", "pass"],
        ["file", "pass"],
        ["file", "pass"],
        ["file", "pass"],
        ["file", "pass"],
        ["file", "pass"],
        ["file", "pass"],
        ["shell", "pass"],
        ["shell", "pass"],
        ["trace", "pass"],
        ["mock", "pass"],
      ],
    );
  },
);
