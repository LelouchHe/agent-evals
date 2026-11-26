import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "./helpers/fake-pi-control.ts";
import { runCliProcess } from "./helpers/cli-process.ts";

const DEADLINE_CHILD = `
const fs = require("node:fs");
fs.writeFileSync(process.env.AE_CHILD_PID_FILE, String(process.pid));
process.on("SIGTERM", () => {});
setTimeout(() => process.exit(0), 10000);
setInterval(() => {}, 1000);
`;

const GRACEFUL_CHILD = `
const fs = require("node:fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(process.env.AE_CHILD_TERM_MARKER, "terminated");
  process.exit(0);
});
fs.writeFileSync(process.env.AE_CHILD_PID_FILE, String(process.pid));
setTimeout(() => process.exit(0), 10000);
setInterval(() => {}, 1000);
`;

async function waitForPid(path: string, timeoutMs: number): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const value = Number(await readFile(path, "utf8"));
      if (Number.isSafeInteger(value) && value > 1) {
        return value;
      }
    } catch {
      // The child has not written its readiness file yet.
    }
    await delay(10);
  }
  throw new Error(`synthetic child did not become ready within ${timeoutMs}ms`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function killAndWait(pid: number): Promise<void> {
  if (!isAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }
    await delay(10);
  }
  throw new Error(`synthetic child ${String(pid)} survived SIGKILL`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleOrLate(
  run: Promise<unknown>,
  timeoutMs: number,
): Promise<
  { readonly kind: "settled" } | { readonly kind: "rejected"; readonly error: Error } | { readonly kind: "late" }
> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<{ readonly kind: "late" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "late" }), timeoutMs);
  });
  try {
    return await Promise.race([
      run.then(
        () => ({ kind: "settled" as const }),
        (error: unknown) => ({
          kind: "rejected" as const,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      ),
      late,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

test("helper deadline terminates and reaps a child that ignores SIGTERM", async (t) => {
  const directory = await makeTempDir(t, "ae-cli-process-deadline-");
  const pidFile = join(directory, "pid");
  const started = performance.now();
  const run = runCliProcess(t, "-e", [DEADLINE_CHILD], {
    cwd: directory,
    env: { ...process.env, AE_CHILD_PID_FILE: pidFile },
    timeoutMs: 700,
  });
  const pid = await waitForPid(pidFile, 2_000);
  t.after(async () => {
    await killAndWait(pid);
  });

  const outcome = await settleOrLate(run, 3_000);
  if (outcome.kind === "late") {
    const aliveAtDeadline = isAlive(pid);
    await killAndWait(pid);
    assert.fail(`helper did not settle at its deadline; child alive at deadline=${String(aliveAtDeadline)}`);
  }
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") {
    return;
  }
  assert.match(outcome.error.message, /timed out after 700ms/);
  assert.equal(isAlive(pid), false, "child survived the helper deadline");
  assert.ok(performance.now() - started < 3_000, "deadline cleanup took too long");
});

test("an enclosing test deadline cancels the real helper and lets its process exit", async (t) => {
  const directory = await makeTempDir(t, "ae-cli-outer-deadline-");
  const pidFile = join(directory, "pid");
  const marker = join(directory, "terminated");
  const innerTest = join(directory, "inner.test.ts");
  await writeFile(
    innerTest,
    `import { test } from "node:test";
import { runCliProcess } from ${JSON.stringify(new URL("./helpers/cli-process.ts", import.meta.url).href)};
test("inner deadline", { timeout: 600 }, (t) =>
  runCliProcess(t, "-e", [${JSON.stringify(GRACEFUL_CHILD)}], { cwd: process.cwd(), env: process.env, timeoutMs: 10000 }));
`,
  );
  const run = runCliProcess(t, "--test", [innerTest], {
    cwd: directory,
    // Do not inherit NODE_TEST_CONTEXT: the child must actually run node:test.
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      TMPDIR: directory,
      AE_CHILD_PID_FILE: pidFile,
      AE_CHILD_TERM_MARKER: marker,
    },
    timeoutMs: 5_000,
  });
  run.catch(() => {});
  const pid = await waitForPid(pidFile, 2_000);
  t.after(() => killAndWait(pid));
  const result = await run;
  assert.equal(result.code, 1);
  assert.match(result.stdout + result.stderr, /test timed out after 600ms/);
  if (process.platform !== "win32") {
    assert.equal(await readFile(marker, "utf8"), "terminated");
  }
  assert.equal(isAlive(pid), false, "inner test deadline left a live CLI child");
});

test("helper cancellation stops a child gracefully before the test deadline", async (t) => {
  const directory = await makeTempDir(t, "ae-cli-process-cancel-");
  const pidFile = join(directory, "pid");
  const marker = join(directory, "terminated");
  const controller = new AbortController();
  const started = performance.now();
  const run = runCliProcess(t, "-e", [GRACEFUL_CHILD], {
    cwd: directory,
    env: { ...process.env, AE_CHILD_PID_FILE: pidFile, AE_CHILD_TERM_MARKER: marker },
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  const pid = await waitForPid(pidFile, 2_000);
  t.after(async () => {
    await killAndWait(pid);
  });

  controller.abort();
  const outcome = await settleOrLate(run, 2_000);
  if (outcome.kind === "late") {
    const aliveAtCancellation = isAlive(pid);
    await killAndWait(pid);
    assert.fail(`helper ignored cancellation; child alive at cancellation=${String(aliveAtCancellation)}`);
  }
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") {
    return;
  }
  assert.match(outcome.error.message, /cancelled by the test/);
  if (process.platform !== "win32") {
    assert.equal(await readFile(marker, "utf8"), "terminated");
  }
  assert.equal(isAlive(pid), false, "child survived helper cancellation");
  assert.ok(performance.now() - started < 2_000, "cancellation cleanup took too long");
});
