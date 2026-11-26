import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import { createEnvSource } from "./env-source.ts";
import { ConfigError } from "./config.ts";

async function nodeScript(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `${body}\n`);
  return `"${process.execPath}" "${path}"`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 1) {
        return pid;
      }
    } catch {
      // Not written yet.
    }
    await delay(10);
  }
  throw new Error("environment command did not report its process id");
}

async function expectDead(pids: readonly number[]): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) {
      return;
    }
    await delay(10);
  }
  assert.fail(`environment command process survived: ${pids.filter(isAlive).join(", ")}`);
}

test("plain and command environment values are lazy, cached per key, and unused commands do not run", async (t) => {
  const dir = await makeTempDir(t, "ae-credentials-");
  const emitCmd = await nodeScript(dir, "emit.mjs", 'process.stdout.write("synthetic-command-key\\n");');
  const countCmd = await nodeScript(
    dir,
    "count.mjs",
    'import { appendFileSync } from "node:fs"; appendFileSync("count", "x"); process.stdout.write("synthetic-count-key\\n");',
  );
  const unusedCmd = await nodeScript(
    dir,
    "unused.mjs",
    'import { writeFileSync } from "node:fs"; writeFileSync("unused-ran", "1"); process.stdout.write("unused-key\\n");',
  );
  await writeFile(
    join(dir, ".env"),
    [
      "AE_PLAIN_TEST=synthetic-plain-key",
      `AE_COMMAND_TEST='!${emitCmd}'`,
      `AE_COUNT_TEST='!${countCmd}'`,
      `AE_UNUSED_TEST='!${unusedCmd}'`,
    ].join("\n") + "\n",
  );

  const source = createEnvSource(dir);
  assert.equal(await source.require("AE_PLAIN_TEST"), "synthetic-plain-key");
  assert.equal(await source.require("AE_COMMAND_TEST"), "synthetic-command-key");
  assert.equal(await source.require("AE_COUNT_TEST"), "synthetic-count-key");
  assert.equal(await source.require("AE_COUNT_TEST"), "synthetic-count-key");
  assert.equal(await readFile(join(dir, "count"), "utf8"), "x");
  await assert.rejects(() => readFile(join(dir, "unused-ran")), /ENOENT/);
  assert.equal(process.env.AE_PLAIN_TEST, undefined);
});

test("environment-value failures are actionable and do not expose command output", async (t) => {
  const dir = await makeTempDir(t, "ae-credentials-fail-");
  const failCmd = await nodeScript(dir, "fail.mjs", 'process.stderr.write("STDERR-SENTINEL"); process.exit(7);');
  const emptyCmd = await nodeScript(dir, "empty.mjs", "process.exit(0);");
  const largeCmd = await nodeScript(dir, "large.mjs", 'process.stdout.write("x".repeat(70000));');
  await writeFile(
    join(dir, ".env"),
    [`AE_FAIL_TEST='!${failCmd}'`, `AE_EMPTY_TEST='!${emptyCmd}'`, `AE_LARGE_TEST='!${largeCmd}'`].join("\n") + "\n",
  );
  const source = createEnvSource(dir);

  await assert.rejects(
    () => source.require("AE_FAIL_TEST"),
    (error: unknown) =>
      error instanceof ConfigError &&
      /exited with code 7/.test(error.message) &&
      !error.message.includes("STDERR-SENTINEL"),
  );
  await assert.rejects(() => source.require("AE_EMPTY_TEST"), /produced no value/);
  await assert.rejects(() => source.require("AE_LARGE_TEST"), /exceeded 65536 bytes/);
  await assert.rejects(() => source.require("AE_NOT_DEFINED"), /is not defined/);

  const emptyDir = await makeTempDir(t, "ae-credentials-missing-");
  const missing = createEnvSource(emptyDir);
  await assert.rejects(() => missing.require("AE_MISSING_FILE_KEY"), /is unavailable/);

  const parent = await makeTempDir(t, "ae-credentials-parent-");
  await writeFile(join(parent, ".env"), "AE_UPWARD_TEST=parent-key\n");
  const child = join(parent, "child");
  await mkdir(child);
  await assert.rejects(() => createEnvSource(child).require("AE_UPWARD_TEST"), /is unavailable/);

  const previous = process.env.AE_HOST_ONLY_TEST;
  process.env.AE_HOST_ONLY_TEST = "host-secret-value";
  t.after(() => {
    if (previous === undefined) delete process.env.AE_HOST_ONLY_TEST;
    else process.env.AE_HOST_ONLY_TEST = previous;
  });
  const partial = await makeTempDir(t, "ae-credentials-partial-");
  await writeFile(join(partial, ".env"), "AE_OTHER_TEST=other\n");
  await assert.rejects(
    () => createEnvSource(partial).require("AE_HOST_ONLY_TEST"),
    (error: unknown) => error instanceof ConfigError && !error.message.includes("host-secret-value"),
  );
});

test("cancelled and timed-out environment commands terminate the direct command", async (t) => {
  const dir = await makeTempDir(t, "ae-credentials-hang-");
  const hangCmd = await nodeScript(
    dir,
    "hang.mjs",
    'import { writeFileSync } from "node:fs"; writeFileSync("hang.pid", String(process.pid) + "\\n"); setTimeout(() => {}, 30000);',
  );
  await writeFile(join(dir, ".env"), `AE_HANG_TEST='!${hangCmd}'\n`);

  const controller = new AbortController();
  const source = createEnvSource(dir, controller.signal);
  const pending = source.require("AE_HANG_TEST");
  const cancelledPid = await waitForPid(join(dir, "hang.pid"));
  t.after(() => {
    try {
      process.kill(cancelledPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  controller.abort();
  await assert.rejects(() => pending, /was cancelled/);
  await expectDead([cancelledPid]);

  const timeoutCmd = await nodeScript(
    dir,
    "timeout.mjs",
    'import { writeFileSync } from "node:fs"; writeFileSync("timeout.pid", String(process.pid) + "\\n"); setTimeout(() => {}, 30000);',
  );
  await writeFile(join(dir, ".env"), `AE_TIMEOUT_TEST='!${timeoutCmd}'\n`);
  const timeoutSource = createEnvSource(dir);
  const timeoutPending = timeoutSource.require("AE_TIMEOUT_TEST");
  const timeoutPid = await waitForPid(join(dir, "timeout.pid"));
  t.after(() => {
    try {
      process.kill(timeoutPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  await assert.rejects(() => timeoutPending, /timed out after 5000ms/);
  await expectDead([timeoutPid]);
});
