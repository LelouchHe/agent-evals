import { randomBytes } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertSeatbeltAvailable } from "../platform/macos/policy.ts";
import {
  ConfigError,
  errorMessage,
  resolveAuthoringAsset,
  type ImplementationParams,
  type ImplementationRecord,
  type ResolvedCase,
} from "./config.ts";
import {
  requireChecker,
  requireRunner,
  type RecordedCheckResult,
  type Checker,
  type HomeProtection,
  type ImplementationContext,
  type MockRecord,
  type PreparedRunner,
  type RegisteredCheckerDefinition,
  type Registry,
  type Runner,
  type RunnerContext,
  type RunnerOutcome,
  type RunnerUsage,
  type TraceEntry,
} from "./registry.ts";
import {
  classifyOutcome,
  createResultDirectory,
  newRunId,
  writeResult,
  type EvaluationRecord,
  type RetainArtifacts,
  type RunStatus,
  type RunnerStatus,
} from "./results.ts";
import { createEnvSource, type EnvSource } from "./env-source.ts";
import {
  authoringCopyFilter,
  copyPlacement,
  fileIdentity,
  homeEntries,
  placeCaseFiles,
  placedPaths,
  stageEntries,
  validateCheckFiles,
} from "./files.ts";
import { startMockHost, type MockHost } from "./mocks.ts";
import { createCheckSandbox } from "./check-sandbox.ts";
import { parseImplementationParams } from "./params.ts";
import { truncate, truncateNullable } from "./truncate.ts";
import { substituteValues, type ValueSource } from "./values.ts";
import { assertRunRoot, isMissing, isProtectedHomePath, openRunRoot, type RunRoot } from "./workspace.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const CHECK_ABORT_GRACE_MS = 12_000;
const MAX_RECORDED_TEXT = 4_000;

export interface RunRequest {
  readonly case: ResolvedCase;
  readonly registry: Registry;
  readonly resultsDir: string;
  readonly retain?: RetainArtifacts;
  readonly signal?: AbortSignal;
  /** Parent directory for the temporary run root. Tests use this to inspect cleanup. */
  readonly tempParent?: string;
  /** Environment-value source override for tests; defaults to `.env` in the invocation cwd. */
  readonly envSource?: EnvSource;
}

/** One validated case, bound to run directories that do not exist yet. */
export interface PreparedEvaluation {
  readonly request: RunRequest;
  readonly runId: string;
  readonly startedAt: string;
  readonly root: string;
  readonly workspaceDir: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly mocksDir: string;
  readonly engineDir: string;
  /** A runner-owned writable directory; only the native Pi runner uses it. */
  readonly configDir: string;
  readonly baselineWorkspaceDir: string;
  readonly baselineHomeDir: string;
  readonly registered: {
    readonly runnerType: string;
    readonly runner: Runner;
    readonly checks: readonly { readonly type: string; readonly checker: Checker }[];
    /** Shared mutable resource keys across all runners created for this evaluation (case + checkers). */
    readonly concurrencyKeys: readonly string[];
  };
}

/**
 * Validate a case and bind it to new run directories without creating them, so a caller can
 * validate every selected case before the first one runs.
 */
export async function prepareEvaluation(request: RunRequest): Promise<PreparedEvaluation> {
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  // Placeholders need the run directories' paths; they are created only after validation.
  // The parent is canonicalized first: the sandbox authorizes the `deps` link only when the
  // run-root path and its target carry no symlink spelling such as `/tmp` for `/private/tmp`.
  const parent = await realpath(request.tempParent ?? tmpdir());
  const root = join(parent, `run-${randomBytes(6).toString("hex")}`);
  const workspaceDir = join(root, "workspace");
  const homeDir = join(root, "home");
  const tmpDir = join(root, "tmp");
  const mocksDir = join(root, "mocks");
  const engineDir = join(root, "engine");
  const configDir = join(root, "config");
  const baselineWorkspaceDir = join(engineDir, "baseline", "workspace");
  const baselineHomeDir = join(engineDir, "baseline", "home");
  const registered = await prepareImplementations(
    request,
    {
      env: request.envSource ?? createEnvSource(process.cwd(), request.signal),
      run: { HOME: homeDir, TMPDIR: tmpDir },
    },
    request.signal,
  );
  await validateAuthoringAssets(request.case);
  return {
    request,
    runId,
    startedAt,
    root,
    workspaceDir,
    homeDir,
    tmpDir,
    mocksDir,
    engineDir,
    configDir,
    baselineWorkspaceDir,
    baselineHomeDir,
    registered,
  };
}

/** Validate configuration, execute one runner, run all checks, and clean up. */
export async function runEvaluation(request: RunRequest): Promise<EvaluationRecord> {
  return executeEvaluation(await prepareEvaluation(request));
}

/** Execute one prepared case: prepare the run root, drive the runner, check, record and clean up. */
export async function executeEvaluation(prepared: PreparedEvaluation): Promise<EvaluationRecord> {
  const {
    request,
    runId,
    startedAt,
    root,
    workspaceDir,
    homeDir,
    tmpDir,
    mocksDir,
    engineDir,
    configDir,
    baselineWorkspaceDir,
    baselineHomeDir,
    registered,
  } = prepared;
  const timeoutMs = request.case.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

  try {
    // Exclusive creation, like mkdtemp: an existing path is an error, not reused.
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    request.signal?.removeEventListener("abort", onAbort);
    throw error;
  }

  let runner: Runner | undefined;
  let workspaceRoot: RunRoot | undefined;
  let homeRoot: RunRoot | undefined;
  let cleanup: EvaluationRecord["cleanup"] = { status: "removed" };
  let artifacts: EvaluationRecord["artifacts"] | undefined;
  let protectedPaths: readonly string[] = registered.runner.homeFiles ?? [];
  const protectedIdentities: string[] = [];
  let runnerRecord: EvaluationRecord["runner"] = {
    type: registered.runnerType,
    status: "error",
    durationMs: 0,
    finalText: null,
  };
  let checks: RecordedCheckResult[] = [];
  let trace: readonly TraceEntry[] | undefined;
  let usage: RunnerUsage | undefined;
  let mockRecords: readonly MockRecord[] | undefined;
  let mockHost: MockHost | undefined;
  let mockFailed = false;
  const diagnostics: string[] = [];
  let error: string | undefined;
  let status: RunStatus = "error";
  let timedOut = false;
  let stopFailed = false;
  let timer: NodeJS.Timeout | undefined;
  let paths: Awaited<ReturnType<typeof createResultDirectory>> | undefined;

  try {
    await Promise.all([
      mkdir(workspaceDir, { mode: 0o700 }),
      mkdir(homeDir, { mode: 0o700 }),
      mkdir(tmpDir, { mode: 0o700 }),
      mkdir(mocksDir, { mode: 0o700 }),
      mkdir(join(engineDir, "baseline", "workspace"), { recursive: true, mode: 0o700 }),
      mkdir(join(engineDir, "baseline", "home"), { recursive: true, mode: 0o700 }),
    ]);
    // Capture root identities immediately after creation so setup failures still retain safely.
    [workspaceRoot, homeRoot] = await Promise.all([openRunRoot(workspaceDir), openRunRoot(homeDir)]);

    const fixture = request.case.config.fixture;
    if (fixture !== undefined) {
      const source = resolveAuthoringAsset(request.case.dir, fixture, "case.fixture");
      await cp(source, workspaceDir, {
        recursive: true,
        preserveTimestamps: true,
        filter: authoringCopyFilter(source),
      });
    }
    await placeCaseFiles(request.case, join(engineDir, "files", "workspace"), workspaceDir);

    // The runner places its own HOME content first; the case then overlays it without
    // touching login state, and only what the case placed becomes the HOME baseline.
    const context: RunnerContext = {
      workspaceDir,
      homeDir,
      tmpDir,
      engineDir,
      configDir,
      runRootDir: root,
      input: request.case.config.input,
      timeoutMs,
      signal: abort.signal,
    };
    runner = registered.runner;
    const preparedProtected = (await runner.prepareHome?.(context)) ?? [];
    protectedPaths = [...new Set([...protectedPaths, ...preparedProtected])];
    // Login state is protected by the file the filesystem actually holds at each declared
    // path, so a differently-cased or otherwise normalised spelling cannot alias it.
    await recordProtectedIdentities(homeDir, protectedPaths, protectedIdentities);
    const homePlacements = homeEntries(request.case.config.files);
    const homeStaging = join(engineDir, "files", "home");
    if (homePlacements.length > 0) {
      await stageEntries(homePlacements, request.case.dir, homeStaging, "files", abort.signal);
      try {
        await copyPlacement(homeStaging, homeDir, {
          label: "files",
          overwrite: true,
          protect: { paths: protectedPaths, identities: protectedIdentities },
          signal: abort.signal,
        });
        await cp(homeStaging, baselineHomeDir, { recursive: true, preserveTimestamps: true });
      } finally {
        await rm(homeStaging, { recursive: true, force: true });
      }
    }

    // Forwarders are written before the baseline snapshot, so it already holds them.
    const mocks = request.case.config.mocks;
    if (mocks !== undefined) {
      mockHost = await startMockHost({
        runRootDir: root,
        engineDir,
        mocksDir,
        workspaceDir: workspaceRoot.path,
        tmpDir,
        authoringDir: request.case.dir,
        shell: mocks.shell,
        timeoutMs,
        signal: abort.signal,
      });
    }
    await cp(workspaceDir, baselineWorkspaceDir, { recursive: true, preserveTimestamps: true });
    const baselineRoot = await openRunRoot(baselineWorkspaceDir);
    const homeBaselineRoot = await openRunRoot(baselineHomeDir);

    const started = performance.now();
    let outcome: RunnerOutcome | undefined;

    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
      void runner?.stop().catch(() => {});
    }, timeoutMs);

    try {
      outcome = await runner.run({
        ...context,
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
          const outcome = await mockHost.close();
          mockRecords = outcome.records;
          if (outcome.faults.length > 0) {
            mockFailed = true;
            diagnostics.push(...outcome.faults);
            error ??= outcome.faults[0];
          }
        }
      } finally {
        trace = runner.trace?.();
        usage = runner.usage?.();
      }
      // Re-record login file identities after the runner stops so an atomic credential refresh
      // (new inode) stays protected from checks and artifact retention.
      await recordProtectedIdentities(homeDir, protectedPaths, protectedIdentities);
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
      ...(usage === undefined ? {} : { usage }),
    };
    if (outcome !== undefined) {
      diagnostics.push(...outcome.diagnostics);
      checks = await runChecks(
        registered.checks,
        request,
        root,
        workspaceRoot,
        baselineRoot,
        homeRoot,
        homeBaselineRoot,
        { paths: protectedPaths, identities: protectedIdentities },
        trace,
        mockRecords,
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
    } else if (mockFailed) {
      status = "error";
      error ??= "a mock fault ended the run";
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
    // A backstop for any failure before the runner's own teardown; close is idempotent.
    if (mockHost !== undefined) {
      try {
        await mockHost.close();
      } catch (caught) {
        diagnostics.push(`failed to close mock host: ${errorMessage(caught)}`);
      }
    }
    if (shouldRetain(request.retain ?? "none", status, request.case.config.expect)) {
      try {
        paths = await createResultDirectory(request.resultsDir, runId);
        const artifactsDir = join(paths.directory, "artifacts");
        await retainRunArtifacts(workspaceRoot, homeRoot, artifactsDir, {
          paths: protectedPaths,
          identities: protectedIdentities,
        });
        artifacts = { status: "retained", path: "artifacts" };
      } catch (caught) {
        const message = errorMessage(caught);
        artifacts = { status: "failed", error: message };
        diagnostics.push(`failed to retain artifacts: ${message}`);
      }
    }
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
    ...(artifacts === undefined ? {} : { artifacts }),
  };

  paths ??= await createResultDirectory(request.resultsDir, runId);
  await writeResult(paths, record, trace, mockRecords);
  return record;
}

function shouldRetain(retain: RetainArtifacts, status: RunStatus, expect: ResolvedCase["config"]["expect"]): boolean {
  if (retain === "all") return true;
  if (retain === "none") return false;
  const outcome = classifyOutcome(status, expect);
  return outcome !== "pass" && outcome !== "expected-fail" && outcome !== "cancelled";
}

async function recordProtectedIdentities(
  homeDir: string,
  protectedPaths: readonly string[],
  identities: string[],
): Promise<void> {
  const seen = new Set(identities);
  for (const path of protectedPaths) {
    try {
      const info = await lstat(join(homeDir, path), { bigint: true });
      if (info.isFile()) {
        const id = fileIdentity(info);
        if (!seen.has(id)) {
          seen.add(id);
          identities.push(id);
        }
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

async function retainRunArtifacts(
  workspaceRoot: RunRoot | undefined,
  homeRoot: RunRoot | undefined,
  artifactsDir: string,
  excludeHome: HomeProtection,
): Promise<void> {
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  if (workspaceRoot !== undefined) {
    await assertRunRoot(workspaceRoot);
    await retainTree(workspaceRoot.path, join(artifactsDir, "workspace"), {
      paths: [],
      identities: excludeHome.identities,
    });
  }
  if (homeRoot !== undefined) {
    await assertRunRoot(homeRoot);
    await retainTree(homeRoot.path, join(artifactsDir, "home"), excludeHome);
  }
}

async function retainTree(sourceDir: string, destinationDir: string, exclude?: HomeProtection): Promise<void> {
  const excludedPaths = exclude?.paths ?? [];
  const excludedIdentities = new Set(exclude?.identities ?? []);

  const walk = async (currentSource: string, currentDest: string, relPrefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(currentSource, { withFileTypes: true });
    } catch (caught) {
      if (isMissing(caught)) return;
      throw caught;
    }
    await mkdir(currentDest, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const rel = relPrefix.length === 0 ? entry.name : `${relPrefix}/${entry.name}`;
      if (isProtectedHomePath(rel, excludedPaths)) continue;
      const srcPath = join(currentSource, entry.name);
      let info;
      try {
        info = await lstat(srcPath, { bigint: true });
      } catch (caught) {
        if (isMissing(caught)) continue;
        throw caught;
      }
      if (info.isFile()) {
        if (excludedIdentities.has(fileIdentity(info))) continue;
        await copyFile(srcPath, join(currentDest, entry.name));
      } else if (info.isDirectory()) {
        await walk(srcPath, join(currentDest, entry.name), rel);
      }
      // Symlinks, sockets, FIFOs and devices are skipped so an agent-created link can never
      // pull host files into the retained results directory.
    }
  };

  await walk(sourceDir, destinationDir, "");
}

async function prepareImplementations(
  request: RunRequest,
  values: ValueSource,
  signal: AbortSignal | undefined,
): Promise<{
  runnerType: string;
  runner: Runner;
  checks: readonly { readonly type: string; readonly checker: Checker }[];
  concurrencyKeys: readonly string[];
}> {
  const mockTargets =
    request.case.config.mocks === undefined ? undefined : Object.keys(request.case.config.mocks.shell);
  const runnerDefinition = requireRunner(request.registry, request.case.config.runner.$type);
  if (request.case.config.mocks !== undefined && runnerDefinition.mocks !== true) {
    throw new ConfigError(`runner "${runnerDefinition.type}" does not support mocks`);
  }
  const runnerSupportsHome = runnerDefinition.home === true;
  if (!runnerSupportsHome && homeEntries(request.case.config.files).length > 0) {
    throw new ConfigError(`runner "${runnerDefinition.type}" does not support case files under "~"`);
  }
  // The case runner's placeholders resolve once; a checker-declared runner arrives resolved with
  // the checker parameters it was written in, so neither declaration is walked twice.
  const caseRunnerParams = await substituteValues(paramsOf(request.case.config.runner), "runner", values);
  const concurrencyKeys = new Set<string>();
  const createRunner = async (record?: ImplementationRecord): Promise<PreparedRunner> => {
    const declaration = record ?? request.case.config.runner;
    const definition = requireRunner(request.registry, declaration.$type);
    const params = await parseImplementationParams(
      definition.params,
      // Each instance gets its own copy: a schema may keep a value it was given, and the case
      // runner's parameters are also the inherited judge's.
      structuredClone(record === undefined ? caseRunnerParams : paramsOf(record)),
      `runner "${definition.type}"`,
    );
    const created = await definition.create(params, context);
    if (created.concurrencyKey !== undefined) {
      concurrencyKeys.add(created.concurrencyKey);
    }
    return { type: definition.type, label: created.label ?? definition.type, runner: created };
  };
  const context: ImplementationContext = {
    authoringDir: request.case.dir,
    values,
    validateFiles: (files) => validateCheckFiles(files, request.case.dir, "check files", signal),
    ...(mockTargets === undefined ? {} : { mockTargets }),
    runnerSupportsHome,
    validateCheckPlatform: async () => assertSeatbeltAvailable(),
    createRunner,
  };
  const { runner } = await createRunner();
  await validateCaseHomePlacement(request.case, runner.homeFiles ?? [], signal);

  const checks: { type: string; checker: Checker }[] = [];
  for (const [index, record] of request.case.config.checks.entries()) {
    const definition = requireChecker(request.registry, record.$type);
    const params = await parseImplementationParams(
      definition.params,
      await substituteValues(paramsOf(record), `checks[${index}]`, values),
      `checker "${definition.type}"`,
    );
    checks.push({ type: definition.type, checker: await createChecker(definition, params, index, context) });
  }

  return { runnerType: runnerDefinition.type, runner, checks, concurrencyKeys: [...concurrencyKeys] };
}

/**
 * Create one checker and name the declaration in its failure: a checker may create a runner of its
 * own, so the nested error has to say which check asked for it.
 */
async function createChecker(
  definition: RegisteredCheckerDefinition,
  params: unknown,
  index: number,
  context: ImplementationContext,
): Promise<Checker> {
  try {
    return await definition.create(params, context);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`checks[${index}] (checker "${definition.type}"): ${error.message}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Reject a case's `~/` placement that would land on login state, including a directory source
 * whose contents name a login file. Runs while every selected case is prepared, before any
 * case executes; the filesystem-level alias guard still applies at placement time.
 */
async function validateCaseHomePlacement(
  loadedCase: ResolvedCase,
  loginFiles: readonly string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const entries = homeEntries(loadedCase.config.files);
  if (entries.length === 0 || loginFiles.length === 0) {
    return;
  }
  let placed: readonly string[];
  try {
    placed = await placedPaths(entries, loadedCase.dir, "files", signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ConfigError(`case files: ${errorMessage(error)}`, { cause: error });
  }
  for (const target of placed) {
    const file = loginFiles.find((login) => target === login || target.startsWith(`${login}/`));
    if (file !== undefined) {
      throw new ConfigError(`case files place ${target}, which collides with login state at ${file}`);
    }
  }
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
  homeRoot: RunRoot,
  homeBaselineRoot: RunRoot,
  protectedHome: HomeProtection,
  trace: readonly TraceEntry[] | undefined,
  mockRecords: readonly MockRecord[] | undefined,
  timeoutMs: number,
  signal: AbortSignal,
  markCancelled: () => void,
): Promise<RecordedCheckResult[]> {
  const results: RecordedCheckResult[] = [];
  for (const [declaration, check] of prepared.entries()) {
    if (signal.aborted) {
      results.push({
        declaration,
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
    // Called inside an async function so that an implementation which returns its results
    // directly, or throws before it can, becomes a rejection this loop already handles.
    const promise = (async () =>
      check.checker.check({
        workspace: workspaceRoot,
        baseline: baselineRoot,
        home: homeRoot,
        homeBaseline: homeBaselineRoot,
        protectedHome,
        runRootDir: root,
        input: request.case.config.input,
        ...(trace === undefined ? {} : { trace }),
        ...(mockRecords === undefined ? {} : { mockRecords }),
        checkSandbox: createCheckSandbox({
          workspaceDir: workspaceRoot.path,
          engineDir: join(root, "engine"),
          authoringDir: request.case.dir,
          signal: combined,
          cancelled: signal,
        }),
        timeoutMs,
        signal: combined,
      }))();
    promise.catch(() => {});

    try {
      const timeout = new Promise<never>((_, reject) => {
        rejectTimer = setTimeout(() => {
          reject(new Error(`checker exceeded the ${timeoutMs}ms execution timeout`));
        }, timeoutMs + 1_000);
      });
      const settled = await Promise.race([promise, timeout]);
      // A verdict that arrives after the budget signal fired is not trusted in either direction:
      // a late pass claims success past the deadline, and a late fail may be a partial comparison
      // that a negative case would otherwise read as the expected outcome.
      results.push(
        ...settled.map((result) =>
          timedOutCheck && result.status !== "error"
            ? {
                declaration,
                checker: result.checker,
                subject: result.subject,
                status: "error" as const,
                reason: truncate(`checker exceeded the ${timeoutMs}ms execution timeout: ${result.reason}`, 800),
              }
            : { ...result, declaration },
        ),
      );
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
        declaration,
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
