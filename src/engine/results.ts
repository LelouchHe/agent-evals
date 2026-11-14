import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CaseConfig } from "./config.ts";
import type { CheckResult, TraceEntry } from "./registry.ts";

export type RunStatus = "pass" | "fail" | "error" | "timeout" | "cancelled";
export type RunnerStatus = "completed" | "error" | "timeout" | "cancelled";

export interface RunnerRecord {
  readonly type: string;
  readonly status: RunnerStatus;
  readonly durationMs: number;
  readonly finalText: string | null;
}

export interface EvaluationRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly case: { readonly path: string; readonly name?: string };
  /** The declared configuration; placeholders remain unsubstituted. */
  readonly resolvedConfig: CaseConfig;
  readonly status: RunStatus;
  readonly runner: RunnerRecord;
  readonly checks: readonly CheckResult[];
  readonly error?: string;
  readonly diagnostics: readonly string[];
  readonly cleanup: { readonly status: "removed" | "failed"; readonly error?: string };
}

export interface ResultPaths {
  readonly directory: string;
  readonly result: string;
}

export function newRunId(now = new Date()): string {
  return `${now.toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID().slice(0, 8)}`;
}

export async function createResultDirectory(resultsRoot: string, runId: string): Promise<ResultPaths> {
  const directory = resolve(resultsRoot, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { directory, result: join(directory, "result.json") };
}

export async function writeResult(
  paths: ResultPaths,
  record: EvaluationRecord,
  trace?: readonly TraceEntry[],
): Promise<void> {
  if (trace !== undefined) {
    await writeFile(join(paths.directory, "trace.json"), JSON.stringify(trace, null, 2) + "\n", { mode: 0o600 });
  }
  const temporary = `${paths.result}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, paths.result);
  if (record.diagnostics.length > 0) {
    await writeFile(join(paths.directory, "diagnostics.log"), formatDiagnostics(record.diagnostics), { mode: 0o600 });
  }
}

function formatDiagnostics(diagnostics: readonly string[]): string {
  return diagnostics.map((line) => `- ${line.replaceAll("\n", "\n  ")}`).join("\n") + "\n";
}
