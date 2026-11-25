import { basename } from "node:path";
import { ConfigError } from "./config.ts";
import type { ImplementationRecord } from "./config.ts";
import type { CheckResult } from "./registry.ts";
import type { EvaluationRecord, RunStatus } from "./results.ts";

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

function matrix(path: string, cases: ReadonlyMap<string, readonly EvaluationRecord[]>): string {
  const labels = [...cases.keys()];
  const declarations = [...cases.values()][0]?.[0]?.resolvedConfig.checks ?? [];
  const canonical = JSON.stringify(declarations);
  for (const [label, runs] of cases) {
    for (const run of runs) {
      const found = run.resolvedConfig.checks;
      if (JSON.stringify(found) === canonical) continue;
      const position = firstDifference(declarations, found);
      throw new ConfigError(
        `--matrix needs one check list across cases: "${label}" declares ${describe(found[position])} at check ${position + 1}, not ${describe(declarations[position])}`,
      );
    }
  }

  const columns = labels.map((label) => {
    const runs = cases.get(label) ?? [];
    const negative = runs.length > 0 && runs.every((run) => run.resolvedConfig.expect === "fail");
    return `${escape(label)}${negative ? " (expect fail)" : ""}`;
  });

  for (const [label, runs] of cases) {
    for (const run of runs) {
      for (const check of run.checks) {
        if (check.declaration === undefined) {
          throw new ConfigError(
            `--matrix needs records that name their declared check: "${label}" predates that field; use report instead`,
          );
        }
      }
    }
  }

  const rows: string[] = [];
  for (let group = 0; group < declarations.length; group += 1) {
    const slots = labels.map((label) => (cases.get(label) ?? []).map((run) => resultsOf(run, group)));
    const width = Math.max(1, ...slots.flat().map((results) => results.length));
    for (let ordinal = 0; ordinal < width; ordinal += 1) {
      const label = slots
        .flat()
        .map((results) => results[ordinal])
        .find((result) => result !== undefined);
      const subject =
        label === undefined
          ? `${value(declarations[group]?.["$type"] ?? "check")} check`
          : `${label.checker} ${label.subject}`;
      const cells = labels.map((_label, index) => cell(slots[index] ?? [], ordinal));
      rows.push(`| ${rows.length + 1} | ${escape(subject)} | ${cells.join(" | ")} |`);
    }
  }

  return [
    path,
    instrument(cases),
    "",
    `| # | Check | ${columns.join(" | ")} |`,
    `| --- | --- | ${columns.map(() => "---").join(" | ")} |`,
    ...rows,
  ].join("\n");
}

/** The results one run recorded for one declared check, in the order the checker returned them. */
function resultsOf(run: EvaluationRecord, declaration: number): readonly CheckResult[] {
  // Records written before the field existed fall back to the result position, which is the
  // declaration position only when that declaration returned a single result.
  return run.checks.filter((check, index) => (check.declaration ?? index) === declaration);
}

/** `passes/judged` for one slot, with errors and unanswered runs named rather than folded in. */
function cell(runs: readonly (readonly CheckResult[])[], ordinal: number): string {
  if (runs.length === 0) {
    return "—";
  }
  const observed = runs.flatMap((results) => {
    const result = results[ordinal];
    return result === undefined ? [] : [result];
  });
  const unjudged = runs.length - observed.length;
  if (observed.length === 0) {
    return `— (${unjudged} not judged)`;
  }
  const passes = observed.filter((check) => check.status === "pass").length;
  const errors = observed.filter((check) => check.status === "error").length;
  const parts = [`${passes}/${observed.length}`];
  if (errors > 0) parts.push(`(${errors} err)`);
  if (unjudged > 0) parts.push(`(${unjudged} not judged)`);
  return parts.join(" ");
}

/** The first declaration position where two lists differ, or the shorter length when nested. */
function firstDifference(left: readonly ImplementationRecord[], right: readonly ImplementationRecord[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
      return index;
    }
  }
  return Math.min(left.length, right.length);
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
  return `runner ${listed(runs.map((run) => value(run.resolvedConfig.runner["$type"])))} · harness ${listed(
    runs.map(harness),
  )} · model ${listed(runs.map(model))} · ${
    counts.size === 1 ? `reps ${[...counts][0]}` : "reps mixed"
  } · cases ${cases.size}`;
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
  const lines: string[] = [];
  for (let position = 0; position < longest(runs.map((run) => run.checks)); position += 1) {
    const observed = runs.flatMap((run) => {
      const check = run.checks[position];
      return check === undefined ? [] : [check];
    });
    if (observed.length === 0) continue;
    if (observed.length === runs.length && observed.every((check) => check.status === "pass")) continue;
    const subject = observed[0]!.subject;
    // Only what did not pass: the denominator already says how many runs there were.
    const counts = new Map<string, number>();
    for (const check of observed) {
      if (check.status !== "pass") counts.set(check.status, (counts.get(check.status) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([status, count]) => `${count}/${runs.length} ${status}`);
    const missing = runs.length - observed.length;
    if (missing > 0) parts.push(`${missing}/${runs.length} not judged`);
    const first = observed.find((check) => check.status !== "pass");
    const reason = truncate(first?.reason ?? "", MAX_REASON);
    lines.push(`✗ ${subject}  ${parts.join(", ")}${reason === "" ? "" : ` — ${reason}`}`);
  }
  return lines;
}

function verdictOf(runs: readonly EvaluationRecord[]): CaseVerdict {
  const statuses = runs.map((run) => run.status);
  if (statuses.some((status) => status !== "pass" && status !== "fail")) return "ERROR";
  if (runs.every((run) => run.resolvedConfig.expect === "fail")) {
    return statuses.every((status) => status === "fail") ? "EXPECTED FAIL" : "UNEXPECTED PASS";
  }
  if (statuses.every((status) => status === "pass")) return "PASS";
  if (statuses.every((status) => status === "fail")) return "FAIL";
  return "FLAKY";
}

function aggregate(runs: readonly EvaluationRecord[]): string {
  const counts = new Map<RunStatus, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  const expected = runs.filter((run) => run.resolvedConfig.expect === "fail");
  const expectedFails = expected.filter((run) => run.status === "fail").length;
  const unexpectedPasses = expected.filter((run) => run.status === "pass").length;
  const named = (["pass", "fail", "error", "timeout", "cancelled"] as const)
    .filter((status) => counts.has(status))
    .map((status) => {
      const count = counts.get(status) ?? 0;
      if (status === "pass") {
        return `${count} passed${unexpectedPasses === 0 ? "" : ` (${unexpectedPasses} unexpected)`}`;
      }
      if (status === "fail") {
        return `${count} fail${expectedFails === 0 ? "" : ` (${expectedFails} expected)`}`;
      }
      return `${count} ${status}`;
    });
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
  const agent = record.resolvedConfig.runner["agent"];
  if (typeof agent !== "string") return value(record.resolvedConfig.runner["$type"]);
  const name = basename(agent);
  return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
}

function model(record: EvaluationRecord): string {
  const config = record.resolvedConfig.runner["config"];
  const configured =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>)["model"] : undefined;
  return value(configured ?? record.resolvedConfig.runner["model"]);
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
