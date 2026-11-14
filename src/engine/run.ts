import { randomBytes } from "node:crypto";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigError,
  errorMessage,
  resolveAuthoringAsset,
  type ImplementationParams,
  type ResolvedCase,
} from "./config.ts";
import {
  requireChecker,
  requireRunner,
  type CheckResult,
  type Checker,
  type InteractionRecord,
  type Registry,
  type Runner,
  type RunnerOutcome,
  type TraceEntry,
} from "./registry.ts";
import {
  createResultDirectory,
  newRunId,
  writeResult,
  type EvaluationRecord,
  type RunStatus,
  type RunnerStatus,
} from "./results.ts";
import { createEnvSource, type EnvSource } from "./env-source.ts";
import { placeCaseFiles } from "./files.ts";
import { startMockHost, type MockHost } from "./mocks.ts";
import { parseImplementationParams } from "./params.ts";
import { truncate, truncateNullable } from "./truncate.ts";
import { substituteValues, type ValueSource } from "./values.ts";
import { openRunRoot, type RunRoot } from "./workspace.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const CHECK_ABORT_GRACE_MS = 12_000;
const MAX_RECORDED_TEXT = 4_000;

export interface RunRequest {
  readonly case: ResolvedCase;
  readonly registry: Registry;
  readonly resultsDir: string;
  readonly signal?: AbortSignal;
  /** Parent directory for the temporary run root. Tests use this to inspect cleanup. */
  readonly tempParent?: string;
  /** Environment-value source override for tests; defaults to `.env` in the invocation cwd. */
  readonly envSource?: EnvSource;
}

/** Validate configuration, execute one runner, run all checks, and clean up. */
export async function runEvaluation(request: RunRequest): Promise<EvaluationRecord> {
  const timeoutMs = request.case.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runId = newRunId();
  const startedAt = new Date().toISOString();

  const abort = new AbortController();
  let cancelled = request.signal?.aborted ?? false;
  const onAbort = () => {
    cancelled = true;
    abort.abort();
  };
  if (request.signal?.aborted === true) {
    abort.abort();
  }
  request.signal?.addEventListener("abort", onAbort, { once: true });

  // Placeholders need the run directories' paths; they are created only after validation.
  const root = join(request.tempParent ?? tmpdir(), `run-${randomBytes(6).toString("hex")}`);
  const workspaceDir = join(root, "workspace");
  const homeDir = join(root, "home");
  const configDir = join(root, "config");
  const scratchDir = join(root, "scratch");
  const baselineDir = join(root, "baseline");

  let registered: Awaited<ReturnType<typeof prepareImplementations>>;
  try {
    registered = await prepareImplementations(request, {
      env: request.envSource ?? createEnvSource(process.cwd(), abort.signal),
      run: { HOME: homeDir, TMPDIR: scratchDir },
    });
    await validateAuthoringAssets(request.case);
    // Exclusive creation, like mkdtemp: an existing path is an error, not reused.
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    request.signal?.removeEventListener("abort", onAbort);
    throw error;
  }

  let runner: Runner | undefined;
  let cleanup: EvaluationRecord["cleanup"] = { status: "removed" };
  let runnerRecord: EvaluationRecord["runner"] = {
    type: registered.runnerType,
    status: "error",
    durationMs: 0,
    finalText: null,
  };
  let checks: CheckResult[] = [];
  let trace: readonly TraceEntry[] | undefined;
  let interactions: readonly InteractionRecord[] | undefined;
  let mockHost: MockHost | undefined;
  const diagnostics: string[] = [];
  let error: string | undefined;
  let status: RunStatus;
  let timedOut = false;
  let stopFailed = false;
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.all([
      mkdir(workspaceDir, { mode: 0o700 }),
      mkdir(homeDir, { mode: 0o700 }),
      mkdir(configDir, { mode: 0o700 }),
      mkdir(scratchDir, { mode: 0o700 }),
      mkdir(baselineDir, { mode: 0o700 }),
    ]);

    const fixture = request.case.config.fixture;
    if (fixture !== undefined) {
      const source = resolveAuthoringAsset(request.case.dir, fixture, "case.fixture");
      await cp(source, workspaceDir, { recursive: true, preserveTimestamps: true });
    }
    await placeCaseFiles(request.case, join(root, "files"), workspaceDir);
    await cp(workspaceDir, baselineDir, { recursive: true, preserveTimestamps: true });
    const workspaceRoot = await openRunRoot(workspaceDir);
    const baselineRoot = await openRunRoot(baselineDir);

    // The host answers calls before the runner starts and stays up past its stop.
    const mocks = request.case.config.mocks;
    if (mocks !== undefined) {
      mockHost = await startMockHost({ runRootDir: root, shell: mocks.shell });
    }

    runner = registered.runner;
    const started = performance.now();
    let outcome: RunnerOutcome | undefined;

    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
      void runner?.stop().catch(() => {});
    }, timeoutMs);

    try {
      outcome = await runner.run({
        workspaceDir,
        homeDir,
        configDir,
        scratchDir,
        runRootDir: root,
        input: request.case.config.input,
        timeoutMs,
        signal: abort.signal,
        ...(mockHost === undefined ? {} : { mocks: mockHost.wiring }),
      });
    } catch (caught) {
      if (!abort.signal.aborted) {
        error = errorMessage(caught);
      }
      diagnostics.push(...diagnosticsOf(caught));
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      try {
        await runner.stop();
      } catch (caught) {
        stopFailed = true;
        diagnostics.push(`failed to stop runner: ${errorMessage(caught)}`);
        error ??= `failed to stop runner: ${errorMessage(caught)}`;
      }
      // Closing the host must not depend on the runner's trace, and vice versa.
      try {
        if (mockHost !== undefined) {
          interactions = await mockHost.close();
        }
      } finally {
        trace = runner.trace?.();
      }
    }

    const runnerStatus: RunnerStatus = stopFailed
      ? "error"
      : outcome !== undefined
        ? "completed"
        : cancelled
          ? "cancelled"
          : timedOut
            ? "timeout"
            : "error";
    runnerRecord = {
      type: registered.runnerType,
      status: runnerStatus,
      durationMs: Math.round(performance.now() - started),
      finalText: outcome === undefined ? null : truncateNullable(outcome.finalText, MAX_RECORDED_TEXT),
    };
    if (outcome !== undefined) {
      diagnostics.push(...outcome.diagnostics);
      checks = await runChecks(
        registered.checks,
        request,
        root,
        workspaceRoot,
        baselineRoot,
        trace,
        timeoutMs,
        abort.signal,
        () => {
          cancelled = true;
        },
      );
    }

    if (cancelled) {
      status = "cancelled";
      error ??= "run was cancelled";
    } else if (timedOut) {
      status = "timeout";
      error ??= `runner exceeded the ${timeoutMs}ms execution timeout`;
    } else if (runnerStatus !== "completed") {
      status = "error";
      error ??= "runner failed before checks could run";
    } else if (checks.some((check) => check.status === "error")) {
      status = "error";
      error ??= "one or more checks could not be evaluated";
    } else if (checks.some((check) => check.status === "fail")) {
      status = "fail";
    } else {
      status = "pass";
    }
  } catch (caught) {
    status = cancelled ? "cancelled" : "error";
    error ??= errorMessage(caught);
    diagnostics.push(...diagnosticsOf(caught));
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    request.signal?.removeEventListener("abort", onAbort);
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    } catch (caught) {
      cleanup = { status: "failed", error: errorMessage(caught) };
    }
  }

  if (cleanup.status === "failed") {
    status = "error";
    error = error === undefined ? `cleanup failed: ${cleanup.error}` : `${error}; cleanup failed: ${cleanup.error}`;
  }

  const record: EvaluationRecord = {
    schemaVersion: 1,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    case: {
      path: request.case.path,
      ...(request.case.name === undefined ? {} : { name: request.case.name }),
    },
    resolvedConfig: request.case.config,
    status,
    runner: runnerRecord,
    checks,
    ...(error === undefined ? {} : { error }),
    diagnostics: boundedDiagnostics(diagnostics),
    cleanup,
  };

  const paths = await createResultDirectory(request.resultsDir, runId);
  await writeResult(paths, record, trace, interactions);
  return record;
}

async function prepareImplementations(
  request: RunRequest,
  values: ValueSource,
): Promise<{
  runnerType: string;
  runner: Runner;
  checks: readonly { readonly type: string; readonly checker: Checker }[];
}> {
  const context = { authoringDir: request.case.dir, values };
  const runnerDefinition = requireRunner(request.registry, request.case.config.runner.$type);
  if (request.case.config.mocks !== undefined && runnerDefinition.mocks !== true) {
    throw new ConfigError(`runner "${runnerDefinition.type}" does not support mocks`);
  }
  const runnerParams = await parseImplementationParams(
    runnerDefinition.params,
    await substituteValues(paramsOf(request.case.config.runner), "runner", values),
    `runner "${runnerDefinition.type}"`,
  );
  const runner = await runnerDefinition.create(runnerParams, context);

  const checks: { type: string; checker: Checker }[] = [];
  for (const [index, record] of request.case.config.checks.entries()) {
    const definition = requireChecker(request.registry, record.$type);
    const params = await parseImplementationParams(
      definition.params,
      await substituteValues(paramsOf(record), `checks[${index}]`, values),
      `checker "${definition.type}"`,
    );
    checks.push({ type: definition.type, checker: await definition.create(params, context) });
  }

  return { runnerType: runnerDefinition.type, runner, checks };
}

async function validateAuthoringAssets(loadedCase: ResolvedCase): Promise<void> {
  const fixture = loadedCase.config.fixture;
  if (fixture !== undefined) {
    const source = resolveAuthoringAsset(loadedCase.dir, fixture, "case.fixture");
    let info;
    try {
      info = await stat(source);
    } catch (caught) {
      throw new ConfigError(`case fixture ${fixture} is not accessible: ${errorMessage(caught)}`);
    }
    if (!info.isDirectory()) {
      throw new ConfigError(`case fixture ${fixture} must be a directory`);
    }
  }

  for (const [destination, source] of Object.entries(loadedCase.config.files ?? {})) {
    try {
      await stat(resolveAuthoringAsset(loadedCase.dir, source, `case.files["${destination}"]`));
    } catch (caught) {
      throw new ConfigError(
        `case files source ${source} for "${destination}" is not accessible: ${errorMessage(caught)}`,
      );
    }
  }
}

async function runChecks(
  prepared: readonly { readonly type: string; readonly checker: Checker }[],
  request: RunRequest,
  root: string,
  workspaceRoot: RunRoot,
  baselineRoot: RunRoot,
  trace: readonly TraceEntry[] | undefined,
  timeoutMs: number,
  signal: AbortSignal,
  markCancelled: () => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of prepared) {
    if (signal.aborted) {
      results.push({
        checker: check.type,
        subject: `${check.type} check`,
        status: "error",
        reason: "run was cancelled before this check ran",
      });
      continue;
    }

    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let timedOutCheck = false;
    let rejectTimer: NodeJS.Timeout | undefined;
    const checkTimer = setTimeout(() => {
      timedOutCheck = true;
      controller.abort();
    }, timeoutMs);
    const promise = check.checker.check({
      workspace: workspaceRoot,
      baseline: baselineRoot,
      runRootDir: root,
      input: request.case.config.input,
      ...(trace === undefined ? {} : { trace }),
      timeoutMs,
      signal: combined,
    });
    promise.catch(() => {});

    try {
      const timeout = new Promise<never>((_, reject) => {
        rejectTimer = setTimeout(() => {
          reject(new Error(`checker exceeded the ${timeoutMs}ms execution timeout`));
        }, timeoutMs + 1_000);
      });
      results.push(...(await Promise.race([promise, timeout])));
    } catch (caught) {
      const reason = signal.aborted
        ? "run was cancelled while this check was running"
        : timedOutCheck
          ? `checker exceeded the ${timeoutMs}ms execution timeout`
          : errorMessage(caught);
      if (signal.aborted) {
        markCancelled();
      }
      results.push({
        checker: check.type,
        subject: `${check.type} check`,
        status: "error",
        reason: truncate(reason, 800),
      });
      await settleWithin(promise, CHECK_ABORT_GRACE_MS);
    } finally {
      clearTimeout(checkTimer);
      if (rejectTimer !== undefined) {
        clearTimeout(rejectTimer);
      }
    }
  }
  return results;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(resolveTimeout, timeoutMs);
  });
  try {
    await Promise.race([promise.catch(() => {}), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function paramsOf(record: Readonly<Record<string, unknown>> & { $type: string }): ImplementationParams {
  const { $type: _type, ...params } = record;
  return params;
}

function diagnosticsOf(error: unknown): string[] {
  if (typeof error === "object" && error !== null && "diagnostics" in error) {
    const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
    if (Array.isArray(diagnostics)) {
      return diagnostics.filter((item): item is string => typeof item === "string").slice(0, 20);
    }
  }
  return [];
}

function boundedDiagnostics(diagnostics: readonly string[]): string[] {
  return diagnostics.slice(0, 20).map((line) => truncate(line, 2_000));
}
