import { basename } from "node:path";
import { ConfigError } from "./config.ts";
import type { ImplementationRecord } from "./config.ts";
import type { RecordedCheckResult } from "./registry.ts";
import { runOutcome, type EvaluationRecord, type RunOutcome } from "./results.ts";

/**
 * How a case ended across its repetitions; a repetition count is what makes FLAKY possible. A case
 * that declares `expect: fail` is read against that expectation rather than against passing.
 */
type CaseVerdict = "PASS" | "FAIL" | "FLAKY" | "ERROR" | "EXPECTED FAIL" | "UNEXPECTED PASS";

const INDENT = "        ";
const MAX_REASON = 140;
const MAX_LABEL = 56;

/**
 * Render run records the way a test runner reports a session: one line per case with its status,
 * time, tokens and cost, the non-passing assertions indented beneath it, and a totals line. A case
 * is a test and its checks are its assertions, so a passing assertion needs no line of its own.
 *
 * Records are grouped by case document and ordered by completion, which is declaration order for a
 * serial sweep: `startedAt` is stamped when an invocation prepares its runs, so it cannot order them.
 */
export function formatReport(records: readonly EvaluationRecord[]): string {
  if (records.length === 0) {
    return "no run records found\n";
  }
  const ordered = [...records].sort((left, right) => {
    return left.finishedAt.localeCompare(right.finishedAt) || left.runId.localeCompare(right.runId);
  });
  const documents = grouped(ordered);
  const blocks = [...documents].map(([path, cases]) => document(path, cases));
  if (documents.size > 1) {
    blocks.push(`total ${aggregate(ordered)}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

/**
 * Render one markdown table per document: a row per declared check, a column per case, and a cell
 * of `passes/judged` over that case's repetitions. A document qualifies only when every case
 * declares the same checks, because a position must mean the same thing in every column; otherwise
 * the requested comparison does not exist and the command says so.
 */
export function formatMatrix(records: readonly EvaluationRecord[]): string {
  if (records.length === 0) {
    return "no run records found\n";
  }
  const ordered = [...records].sort((left, right) => {
    return left.finishedAt.localeCompare(right.finishedAt) || left.runId.localeCompare(right.runId);
  });
  const blocks = [...grouped(ordered)].map(([path, cases]) => matrix(path, cases));
  return `${blocks.join("\n\n")}\n`;
}

/** Records grouped by document and then by case name, in the order each first finished. */
function grouped(records: readonly EvaluationRecord[]): Map<string, Map<string, EvaluationRecord[]>> {
  const documents = new Map<string, Map<string, EvaluationRecord[]>>();
  for (const record of records) {
    const label = record.case.name ?? "(ordinary)";
    let cases = documents.get(record.case.path);
    if (cases === undefined) {
      cases = new Map();
      documents.set(record.case.path, cases);
    }
    const runs = cases.get(label);
    if (runs === undefined) cases.set(label, [record]);
    else runs.push(record);
  }
  return documents;
}

/** One assertion as a record identifies it, with every result that identity produced. */
interface Observation {
  readonly declaration: number;
  readonly subject: string;
  readonly checker: string;
  readonly results: readonly RecordedCheckResult[];
}

/**
 * A run's results by identity: the declared check and the subject the checker named. A record
 * written before the provenance stamp identifies a result by its position instead, because that is
 * the only identity it has; the two reports never mix the two within one record.
 */
function observations(run: EvaluationRecord): Map<string, Observation> {
  const grouped = new Map<
    string,
    { declaration: number; subject: string; checker: string; results: RecordedCheckResult[] }
  >();
  run.checks.forEach((check, position) => {
    const key =
      check.declaration === undefined
        ? `position:${position}`
        : `declaration:${check.declaration}\u0000${check.subject}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        declaration: check.declaration ?? position,
        subject: check.subject,
        checker: check.checker,
        results: [check],
      });
    } else {
      existing.results.push(check);
    }
  });
  return grouped;
}

/** Every identity the runs share, ordered by declaration and then by first appearance. */
function identities(perRun: readonly ReadonlyMap<string, Observation>[]): readonly string[] {
  const firstSeen = new Map<string, { declaration: number; index: number }>();
  let index = 0;
  for (const run of perRun) {
    for (const [key, observation] of run) {
      if (!firstSeen.has(key)) {
        firstSeen.set(key, { declaration: observation.declaration, index: index++ });
      }
    }
  }
  return [...firstSeen.entries()]
    .sort(([, left], [, right]) => left.declaration - right.declaration || left.index - right.index)
    .map(([key]) => key);
}

function matrix(path: string, cases: ReadonlyMap<string, readonly EvaluationRecord[]>): string {
  const labels = [...cases.keys()];
  const declarations = [...cases.values()][0]?.[0]?.resolvedConfig.checks ?? [];
  for (const [label, runs] of cases) {
    for (const run of runs) {
      if (!sameValue(run.resolvedConfig.checks, declarations)) {
        const position = firstDifference(declarations, run.resolvedConfig.checks);
        throw new ConfigError(
          `--matrix needs one check list across cases: "${label}" declares ${describe(run.resolvedConfig.checks[position])} at check ${position + 1}, not ${describe(declarations[position])}`,
        );
      }
      for (const check of run.checks) {
        if (check.declaration === undefined) {
          throw new ConfigError(
            `--matrix needs records that name their declared check: "${label}" predates that field; use report instead`,
          );
        }
      }
    }
  }

  const columns = labels.map((label) => {
    const runs = cases.get(label) ?? [];
    const negative = runs.length > 0 && runs.every((run) => run.resolvedConfig.expect === "fail");
    return `${escape(label)}${negative ? " (expect fail)" : ""}`;
  });

  const perCase = labels.map((label) => (cases.get(label) ?? []).map(observations));
  const keys = identities(perCase.flat());
  const rows = keys.map((key, index) => {
    const observation = perCase
      .flat()
      .map((run) => run.get(key))
      .find((entry) => entry !== undefined);
    const subject = `${observation?.checker ?? value(declarations[index]?.["$type"] ?? "check")} ${
      observation?.subject ?? "check"
    }`;
    const cells = perCase.map((runs) => cell(runs, key));
    return `| ${index + 1} | ${escape(subject)} | ${cells.join(" | ")} |`;
  });

  const table = [
    `| # | Check | ${columns.join(" | ")} |`,
    `| --- | --- | ${columns.map(() => "---").join(" | ")} |`,
    ...rows,
  ];
  if (rows.length === 0) {
    table.push("", "No check result was recorded for any repetition.");
  }
  return [path, instrument(cases), "", ...table].join("\n");
}

/** `passes/judged` for one identity across a case's runs, with errors and absence named. */
function cell(runs: readonly ReadonlyMap<string, Observation>[], key: string): string {
  if (runs.length === 0) {
    return "—";
  }
  const observed = runs.flatMap((run) => run.get(key)?.results ?? []);
  const missing = runs.filter((run) => !run.has(key)).length;
  if (observed.length === 0) {
    return `— (${missing} not judged)`;
  }
  const passes = observed.filter((check) => check.status === "pass").length;
  const errors = observed.filter((check) => check.status === "error").length;
  const parts = [`${passes}/${observed.length}`];
  if (errors > 0) parts.push(`(${errors} err)`);
  if (missing > 0) parts.push(`(${missing} not judged)`);
  return parts.join(" ");
}

/** The first declaration position where two lists differ, or the shorter length when nested. */
function firstDifference(left: readonly ImplementationRecord[], right: readonly ImplementationRecord[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (!sameValue(left[index], right[index])) {
      return index;
    }
  }
  return Math.min(left.length, right.length);
}

/** Arrays are ordered and mappings are not; an authored key order is not a check parameter. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => sameValue(value, right[index]));
  }
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/** A declaration in an error message: one line, bounded, and never the word undefined. */
function describe(spec: ImplementationRecord | undefined): string {
  return spec === undefined ? "nothing" : truncate(JSON.stringify(spec), 120);
}

/** A table cell is one line: a pipe would open a column and any line ending would end the row. */
function escape(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\r\n?|\n/g, " ");
}

function document(path: string, cases: ReadonlyMap<string, readonly EvaluationRecord[]>): string {
  const runs = [...cases.values()].flat();
  const lines = [path, instrument(cases), ""];
  const width = Math.min(MAX_LABEL, longest([...cases.keys()]));
  const verdictWidth = Math.max(7, ...[...cases.values()].map((caseRuns) => verdictOf(caseRuns).length));
  for (const [label, caseRuns] of cases) {
    lines.push(caseLine(label, caseRuns, width, verdictWidth));
    for (const detail of details(caseRuns)) {
      lines.push(`${INDENT}${detail}`);
    }
  }
  lines.push("", aggregate(runs));
  return lines.join("\n");
}

/** The line under a document heading: which instruments ran it and at what repetition count. */
function instrument(cases: ReadonlyMap<string, readonly EvaluationRecord[]>): string {
  const runs = [...cases.values()].flat();
  const counts = new Set([...cases.values()].map((entry) => entry.length));
  const judges = judgeInstruments(runs);
  const parts = [
    `runner ${listed(runs.map((run) => value(run.resolvedConfig.runner["$type"])))}`,
    `harness ${listed(runs.map(harness))}`,
    `model ${listed(runs.map(model))}`,
    ...(judges.length === 0 ? [] : [`judge ${listed(judges)}`]),
    counts.size === 1 ? `reps ${[...counts][0]}` : "reps mixed",
    `cases ${cases.size}`,
  ];
  return parts.join(" · ");
}

function caseLine(label: string, runs: readonly EvaluationRecord[], width: number, verdictWidth: number): string {
  const verdict = verdictOf(runs);
  const cells = [
    `${runs.length} run${runs.length === 1 ? "" : "s"}`.padStart(8),
    duration(sum(runs, (run) => run.runner.durationMs)).padStart(8),
    tokens(runs).padStart(11),
    cost(runs).padStart(9),
  ];
  return `${verdict.padEnd(verdictWidth)} ${label.padEnd(width)} ${cells.join("  ")}`.trimEnd();
}

/**
 * One line per check that did not pass in every run; the rest are represented by the case verdict.
 * A check is its declared position, not its subject: one case may declare the same subject twice
 * with different parameters, and then two checks share a label. Every run is in the denominator,
 * and a run that recorded no check at all is reported as not judged rather than dropped.
 */
function details(runs: readonly EvaluationRecord[]): string[] {
  const perRun = runs.map(observations);
  const lines: string[] = [];
  for (const key of identities(perRun)) {
    const observed = perRun.flatMap((run) => run.get(key)?.results ?? []);
    if (observed.length === 0) continue;
    const missing = perRun.filter((run) => !run.has(key)).length;
    if (missing === 0 && observed.every((check) => check.status === "pass")) continue;
    const subject = perRun.map((run) => run.get(key)).find((entry) => entry !== undefined)!.subject;
    const counts = new Map<string, number>();
    for (const check of observed) {
      if (check.status !== "pass") counts.set(check.status, (counts.get(check.status) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([status, count]) => `${count}/${observed.length} ${status}`);
    if (missing > 0) parts.push(`${missing}/${runs.length} not judged`);
    const first = observed.find((check) => check.status !== "pass");
    const reason = truncate(first?.reason ?? "", MAX_REASON);
    lines.push(`✗ ${subject}  ${parts.join(", ")}${reason === "" ? "" : ` — ${reason}`}`);
  }
  return lines;
}

function verdictOf(runs: readonly EvaluationRecord[]): CaseVerdict {
  const outcomes = runs.map(runOutcome);
  if (outcomes.some((outcome) => outcome === "error" || outcome === "timeout" || outcome === "cancelled")) {
    return "ERROR";
  }
  // A negative case that ever passed is one failure, however many repetitions failed as declared.
  if (outcomes.some((outcome) => outcome === "unexpected-pass")) return "UNEXPECTED PASS";
  if (outcomes.every((outcome) => outcome === "pass")) return "PASS";
  if (outcomes.every((outcome) => outcome === "fail")) return "FAIL";
  if (outcomes.every((outcome) => outcome === "expected-fail")) return "EXPECTED FAIL";
  return "FLAKY";
}

function aggregate(runs: readonly EvaluationRecord[]): string {
  const outcomes = runs.map(runOutcome);
  const count = (outcome: RunOutcome): number => outcomes.filter((value) => value === outcome).length;
  const passed = count("pass") + count("unexpected-pass");
  const failed = count("fail") + count("expected-fail");
  const named = [
    ...(passed === 0
      ? []
      : [`${passed} passed${count("unexpected-pass") === 0 ? "" : ` (${count("unexpected-pass")} unexpected)`}`]),
    ...(failed === 0
      ? []
      : [`${failed} fail${count("expected-fail") === 0 ? "" : ` (${count("expected-fail")} expected)`}`]),
    ...(["error", "timeout", "cancelled"] as const)
      .filter((status) => count(status) > 0)
      .map((status) => `${count(status)} ${status}`),
  ];
  return [
    `${runs.length} run${runs.length === 1 ? "" : "s"}`,
    ...named,
    duration(sum(runs, (run) => run.runner.durationMs)),
    tokens(runs),
    cost(runs),
  ].join(" · ");
}

function tokens(runs: readonly EvaluationRecord[]): string {
  const reported = runs.filter((run) => run.runner.usage?.tokens !== undefined);
  if (reported.length === 0) return "—";
  const total = sum(reported, (run) => run.runner.usage?.tokens?.totalTokens ?? 0);
  return `${scaled(total)} tok${coverage(reported.length, runs.length)}`;
}

function cost(runs: readonly EvaluationRecord[]): string {
  const reported = runs.filter((run) => run.runner.usage?.cost !== undefined && run.runner.usage.cost !== null);
  if (reported.length === 0) return "—";
  const currencies = new Set(reported.map((run) => run.runner.usage?.cost?.currency));
  if (currencies.size !== 1) return "—";
  const currency = [...currencies][0] ?? "";
  const total = sum(reported, (run) => run.runner.usage?.cost?.amount ?? 0);
  const text = currency === "USD" ? `$${total.toFixed(4)}` : `${total.toFixed(4)} ${currency}`;
  return `${text}${coverage(reported.length, runs.length)}`;
}

/** Say so when only some runs reported a figure, so a subtotal is never read as a total. */
function coverage(reported: number, total: number): string {
  return reported === total ? "" : ` (${reported}/${total})`;
}

/** Distinct values in first-seen order, so a document that mixes instruments says so. */
function listed(values: readonly string[]): string {
  const seen: string[] = [];
  for (const item of values) {
    if (!seen.includes(item)) seen.push(item);
  }
  const shown = seen.slice(0, 3).join(", ");
  return seen.length > 3 ? `${shown}, …` : shown;
}

function longest(values: readonly (string | readonly unknown[])[]): number {
  let size = 0;
  for (const item of values) {
    const length = typeof item === "string" ? item.length : item.length;
    if (length > size) size = length;
  }
  return size;
}

function harness(record: EvaluationRecord): string {
  return harnessOf(record.resolvedConfig.runner);
}

function model(record: EvaluationRecord): string {
  return modelOf(record.resolvedConfig.runner);
}

function harnessOf(runner: Readonly<Record<string, unknown>>): string {
  const agent = runner["agent"];
  if (typeof agent !== "string") return value(runner["$type"]);
  const name = basename(agent);
  return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
}

function modelOf(runner: Readonly<Record<string, unknown>>): string {
  const config = runner["config"];
  const configured =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>)["model"] : undefined;
  return value(configured ?? runner["model"]);
}

function judgeInstruments(runs: readonly EvaluationRecord[]): readonly string[] {
  const result: string[] = [];
  for (const run of runs) {
    for (const check of run.resolvedConfig.checks) {
      if (check["$type"] !== "judge") continue;
      const declared = check["runner"];
      const runner =
        typeof declared === "object" && declared !== null && !Array.isArray(declared)
          ? (declared as Readonly<Record<string, unknown>>)
          : run.resolvedConfig.runner;
      const judgeHarness = harnessOf(runner);
      const judgeModel = modelOf(runner);
      result.push(judgeModel === "—" ? judgeHarness : `${judgeHarness}/${judgeModel}`);
    }
  }
  return result;
}

function value(input: unknown): string {
  return typeof input === "string" && input !== "" ? input : "—";
}

function sum(runs: readonly EvaluationRecord[], pick: (run: EvaluationRecord) => number): number {
  return runs.reduce((total, run) => total + pick(run), 0);
}

function scaled(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function duration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

function truncate(reason: string, limit: number): string {
  const single = reason.replace(/\s+/gu, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}
