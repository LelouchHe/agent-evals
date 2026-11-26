import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError } from "./config.ts";
import { formatMatrix, formatReport } from "./report.ts";
import type { EvaluationRecord, RunStatus } from "./results.ts";

interface RunSpec {
  readonly name?: string;
  readonly status: RunStatus;
  readonly checks: readonly (readonly [string, "pass" | "fail" | "error", string?, number?])[];
  readonly declarations?: readonly unknown[];
  readonly agent?: string;
  readonly durationMs?: number;
  readonly tokens?: number;
  readonly cost?: number;
  readonly path?: string;
  readonly model?: string;
  readonly expect?: "pass" | "fail";
}

function record(index: number, spec: RunSpec): EvaluationRecord {
  const tokens = spec.tokens === undefined ? undefined : { totalTokens: spec.tokens, inputTokens: 0, outputTokens: 0 };
  const cost = spec.cost === undefined ? undefined : { amount: spec.cost, currency: "USD" };
  return {
    schemaVersion: 1,
    runId: `2026-01-01T00-00-0${index}-000Z-record00`,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: `2026-01-01T00:00:0${index}.000Z`,
    case: { path: spec.path ?? "/cases/example.yml", ...(spec.name === undefined ? {} : { name: spec.name }) },
    resolvedConfig: {
      input: "task",
      ...(spec.expect === undefined ? {} : { expect: spec.expect }),
      checks: spec.declarations ?? spec.checks.map(([subject]) => ({ $type: "trace", event: "skill", name: subject })),
      runner: {
        $type: "acp",
        agent: spec.agent ?? "/agents/pi.yml",
        config: { model: spec.model ?? "vendor/model-1" },
      },
    } as unknown as EvaluationRecord["resolvedConfig"],
    status: spec.status,
    runner: {
      type: "acp",
      status: "completed",
      durationMs: spec.durationMs ?? 0,
      finalText: null,
      ...(tokens === undefined ? {} : { usage: { tokens, ...(cost === undefined ? {} : { cost }) } }),
    },
    checks: spec.checks.map(([subject, status, reason, declaration], index) => ({
      checker: "trace",
      subject,
      status,
      reason: reason ?? "observed",
      declaration: declaration ?? index,
    })),
    diagnostics: [],
    cleanup: { status: "removed" },
  };
}

test("a session reports one line per case, its failing assertions, and totals", () => {
  const report = formatReport([
    record(1, {
      name: "stable",
      status: "pass",
      durationMs: 1_500,
      tokens: 2_000,
      cost: 0.001,
      checks: [["a", "pass"]],
    }),
    record(2, {
      name: "stable",
      status: "pass",
      durationMs: 1_500,
      tokens: 2_000,
      cost: 0.001,
      checks: [["a", "pass"]],
    }),
    record(3, {
      name: "flaky",
      status: "fail",
      durationMs: 3_000,
      tokens: 4_000,
      cost: 0.002,
      checks: [
        ["a", "fail", "expected none, consulted: skill"],
        ["b", "pass"],
      ],
    }),
    record(4, {
      name: "flaky",
      status: "pass",
      durationMs: 3_000,
      tokens: 4_000,
      cost: 0.002,
      checks: [
        ["a", "pass"],
        ["b", "pass"],
      ],
    }),
    record(5, { name: "broken", status: "error", checks: [["a", "error", "the run produced no assistant text"]] }),
  ]);

  assert.match(report, /^\/cases\/example\.yml$/mu);
  assert.match(report, /^runner acp · harness pi · model vendor\/model-1 · reps mixed · cases 3$/mu);
  // A case line carries the verdict, the repetition count, time, tokens and cost.
  assert.match(report, /^PASS +stable +2 runs +3\.0s +4\.0k tok +\$0\.0020$/mu);
  // Mixed repetitions inside one case are FLAKY, not PASS or FAIL.
  assert.match(report, /^FLAKY +flaky +2 runs +6\.0s +8\.0k tok +\$0\.0040$/mu);
  assert.match(report, /^ {8}✗ a {2}1\/2 fail — expected none, consulted: skill$/mu);
  // A check that passed in every run gets no line of its own.
  assert.doesNotMatch(report, /✗ b/u);
  assert.match(report, /^ERROR +broken +1 run +0ms +— +—$/mu);
  assert.match(report, /^ {8}✗ a {2}1\/1 error — the run produced no assistant text$/mu);
  // The erroring run reported no usage, so the figures are marked as subtotals of four runs.
  assert.match(report, /^5 runs · 3 passed · 1 fail · 1 error · 9\.0s · 12\.0k tok \(4\/5\) · \$0\.0060 \(4\/5\)$/mu);
});

test("a case whose runs all fail says FAIL, and one all-pass case says PASS", () => {
  const report = formatReport([
    record(1, { name: "all-fail", status: "fail", checks: [["a", "fail"]] }),
    record(2, { name: "all-fail", status: "fail", checks: [["a", "fail"]] }),
    record(3, { name: "all-pass", status: "pass", checks: [["a", "pass"]] }),
  ]);
  assert.match(report, /^FAIL +all-fail/mu);
  assert.match(report, /^PASS +all-pass/mu);
  assert.doesNotMatch(report, /all-pass[\s\S]*✗/u);
});

test("several documents keep separate sessions and add one total", () => {
  const report = formatReport([
    record(1, { name: "one", status: "pass", checks: [["a", "pass"]], path: "/cases/one.yml" }),
    record(2, { name: "two", status: "fail", checks: [["a", "fail"]], path: "/cases/two.yml" }),
  ]);
  assert.match(report, /^\/cases\/one\.yml$/mu);
  assert.match(report, /^\/cases\/two\.yml$/mu);
  assert.match(report, /· reps 1 · cases 1$/mu);
  assert.match(report, /^total 2 runs · 1 passed · 1 fail · 0ms · — · —$/mu);
});

test("an ordinary document labels its case without inventing a name", () => {
  const report = formatReport([record(1, { status: "pass", checks: [["a", "pass"]] })]);
  assert.match(report, /^PASS +\(ordinary\)/mu);
});

test("no records is reported as such, not as an empty session", () => {
  assert.equal(formatReport([]), "no run records found\n");
});

test("a figure that only some runs reported is marked as a subtotal", () => {
  const report = formatReport([
    record(1, { name: "case", status: "pass", tokens: 100, cost: 1, checks: [["a", "pass"]] }),
    record(2, { name: "case", status: "pass", checks: [["a", "pass"]] }),
  ]);
  assert.match(report, /^PASS +case +2 runs +0ms +100 tok \(1\/2\) +\$1\.0000 \(1\/2\)$/mu);
  assert.match(report, /100 tok \(1\/2\) · \$1\.0000 \(1\/2\)$/mu);
});

test("a document that mixes harnesses names each of them instead of the first", () => {
  const report = formatReport([
    record(1, { name: "one", status: "pass", agent: "/agents/pi.yml", model: "vendor/a", checks: [["a", "pass"]] }),
    record(2, { name: "two", status: "pass", agent: "/agents/claude.yml", model: "vendor/b", checks: [["a", "pass"]] }),
  ]);
  assert.match(report, /^runner acp · harness pi, claude · model vendor\/a, vendor\/b · reps 1 · cases 2$/mu);
});

test("two checks with one subject stay two declarations, not one doubled assertion", () => {
  const report = formatReport([
    record(1, {
      name: "twice",
      status: "fail",
      checks: [
        ["skill absent", "fail", "consulted: absent"],
        ["skill absent", "pass"],
      ],
    }),
  ]);
  assert.match(report, /^ {8}✗ skill absent {2}1\/1 fail — consulted: absent$/mu);
  assert.doesNotMatch(report, /1\/2 fail/u);
});

test("a run that recorded no check counts as not judged rather than leaving the denominator", () => {
  const report = formatReport([
    record(1, { name: "case", status: "fail", checks: [["a", "fail", "observed"]] }),
    record(2, { name: "case", status: "error", checks: [] }),
  ]);
  assert.match(report, /^ {8}✗ a {2}1\/1 fail, 1\/2 not judged — observed$/mu);
});

test("a negative case is read against its expectation", () => {
  const report = formatReport([
    record(1, { name: "baseline", status: "fail", expect: "fail", checks: [["asked", "fail", "no steps"]] }),
    record(2, { name: "baseline", status: "fail", expect: "fail", checks: [["asked", "fail", "no steps"]] }),
    record(3, { name: "skill", status: "pass", checks: [["asked", "pass"]] }),
  ]);

  assert.match(report, /^EXPECTED FAIL baseline/mu);
  assert.match(report, /^PASS {10}skill/mu);
  assert.match(report, /^3 runs · 1 passed · 2 fail \(2 expected\)/mu);
});

test("a negative case that passes is an unexpected pass", () => {
  const report = formatReport([
    record(1, { name: "baseline", status: "pass", expect: "fail", checks: [["asked", "pass"]] }),
    record(2, { name: "baseline", status: "fail", expect: "fail", checks: [["asked", "fail"]] }),
  ]);

  assert.match(report, /^UNEXPECTED PASS baseline/mu);
  assert.match(report, /^2 runs · 1 passed \(1 unexpected\) · 1 fail \(1 expected\)/mu);
});

test("the matrix puts a check per row and a case per column", () => {
  const text = formatMatrix([
    record(1, {
      name: "skill",
      status: "pass",
      checks: [
        ["resource|exists", "pass"],
        ["asked", "pass"],
      ],
    }),
    record(2, {
      name: "skill",
      status: "pass",
      checks: [
        ["resource|exists", "pass"],
        ["asked", "pass"],
      ],
    }),
    record(3, {
      name: "baseline",
      status: "fail",
      expect: "fail",
      checks: [
        ["resource|exists", "pass"],
        ["asked", "fail", "no steps"],
      ],
    }),
    record(4, {
      name: "baseline",
      status: "fail",
      expect: "fail",
      checks: [
        ["resource|exists", "pass"],
        ["asked", "fail", "no steps"],
      ],
    }),
  ]);

  assert.ok(text.includes("| # | Check | skill | baseline (expect fail) |"), text);
  assert.ok(text.includes("| 1 | trace resource\\|exists | 2/2 | 2/2 |"), text);
  assert.ok(text.includes("| 2 | trace asked | 2/2 | 0/2 |"), text);
});

test("a matrix cell names errors and runs that recorded no check", () => {
  const declarations = [{ $type: "trace", event: "skill", name: "asked" }];
  const text = formatMatrix([
    record(1, { name: "case", status: "pass", declarations, checks: [["asked", "pass"]] }),
    record(2, { name: "case", status: "error", declarations, checks: [["asked", "error", "deadline"]] }),
    record(3, { name: "case", status: "error", declarations, checks: [] }),
  ]);

  assert.match(text, /^\| 1 \| trace asked \| 1\/2 \(1 err\) \(1 not judged\) \|$/mu);
});

test("a matrix refuses declarations that differ even when their result labels match", () => {
  assert.throws(
    () =>
      formatMatrix([
        record(1, {
          name: "a",
          status: "pass",
          declarations: [{ $type: "trace", event: "skill", name: "x", times: 2 }],
          checks: [["skill x", "pass"]],
        }),
        record(2, {
          name: "b",
          status: "pass",
          declarations: [{ $type: "trace", event: "skill", name: "x", times: 0 }],
          checks: [["skill x", "pass"]],
        }),
      ]),
    ConfigError,
  );
});

test("a matrix groups one declaration's results across different result counts", () => {
  const declarations = [{ $type: "file", path: "vault" }];
  const text = formatMatrix([
    record(1, {
      name: "run",
      status: "fail",
      declarations,
      checks: [
        ["pattern one", "pass", undefined, 0],
        ["pattern two", "fail", undefined, 0],
      ],
    }),
    record(2, { name: "other", status: "error", declarations, checks: [["file check", "error", "no evidence", 0]] }),
  ]);

  // The declaration-level error is its own identity, not the first pattern's slot.
  assert.ok(text.includes("| 1 | trace pattern one | 1/1 | — (1 not judged) |"), text);
  assert.ok(text.includes("| 2 | trace pattern two | 0/1 | — (1 not judged) |"), text);
  assert.ok(text.includes("| 3 | trace file check | — (1 not judged) | 0/1 (1 err) |"), text);
});

test("a matrix names runs that recorded no result at all", () => {
  const declarations = [{ $type: "judge", rubric: ["asked"] }];
  const text = formatMatrix([
    record(1, { name: "a", status: "error", declarations, checks: [] }),
    record(2, { name: "b", status: "error", declarations, checks: [] }),
  ]);

  assert.ok(text.includes("No check result was recorded for any repetition."), text);
});

test("a matrix refuses records that do not name their declaration", () => {
  const old = record(1, {
    name: "a",
    status: "pass",
    declarations: [{ $type: "file", path: "x" }],
    checks: [["x", "pass"]],
  });
  const { declaration: _declaration, ...result } = old.checks[0]!;
  assert.throws(() => formatMatrix([{ ...old, checks: [result] }]), ConfigError);
});

test("a matrix keeps a carriage return out of the table", () => {
  const text = formatMatrix([record(1, { name: "a", status: "pass", checks: [["line\rone", "pass"]] })]);
  assert.ok(text.includes("| 1 | trace line one | 1/1 |"), text);
  assert.equal(text.includes("\r"), false, text);
});

test("session and matrix headers show judge harness/model when judge checks are present", () => {
  const noJudge = formatReport([record(1, { name: "a", status: "pass", checks: [] })]);
  assert.doesNotMatch(noJudge, /· judge /);

  const explicitDeclarations = [{ $type: "judge", runner: { $type: "pi", model: "deepseek/judge" }, rubric: ["ok"] }];
  const explicitRun = record(1, {
    name: "a",
    status: "pass",
    declarations: explicitDeclarations,
    checks: [["ok", "pass", undefined, 0]],
  });
  assert.match(formatReport([explicitRun]), /· judge pi\/deepseek\/judge ·/);
  assert.match(formatMatrix([explicitRun]), /· judge pi\/deepseek\/judge ·/);

  const inheritedRun = record(2, {
    name: "b",
    status: "pass",
    agent: "agents/claude.yml",
    model: "haiku",
    declarations: [{ $type: "judge", rubric: ["ok"] }],
    checks: [["ok", "pass", undefined, 0]],
  });
  assert.match(formatReport([inheritedRun]), /· judge claude\/haiku ·/);
});
