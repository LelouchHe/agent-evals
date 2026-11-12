import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import { createCredentialSource } from "./credentials.ts";
import { ConfigError } from "./config.ts";

async function script(dir: string, name: string, body: string): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
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

async function waitForPids(path: string): Promise<number[]> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try {
      const [first, second] = (await readFile(path, "utf8")).trim().split(/\s+/).map(Number);
      if (first !== undefined && second !== undefined && first > 1 && second > 1) {
        return [first, second];
      }
    } catch {
      // Not written yet.
    }
    await delay(10);
  }
  throw new Error("credential command did not report its process ids");
}

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function expectGroupDead(pgid: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (!isGroupAlive(pgid)) return;
    await delay(10);
  }
  assert.fail(`credential command process group ${pgid} survived`);
}

function credentialChildSource(script: string, directory: string, key: string): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["--input-type=module", "-e", script, directory], {
    env: { ...process.env, AE_CREDENTIAL_NAME: key },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function expectDead(pids: readonly number[]): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) {
      return;
    }
    await delay(10);
  }
  assert.fail(`credential command process survived: ${pids.filter(isAlive).join(", ")}`);
}

test("plain and command credentials are lazy, cached per key, and unused commands do not run", async (t) => {
  const dir = await makeTempDir(t, "ae-credentials-");
  await script(dir, "emit.sh", "printf 'synthetic-command-key\\n'");
  await script(dir, "count.sh", "printf x >> count\nprintf 'synthetic-count-key\\n'");
  await script(dir, "unused.sh", "touch unused-ran\nprintf 'unused-key\\n'");
  await writeFile(
    join(dir, ".env"),
    [
      "AE_PLAIN_TEST=synthetic-plain-key",
      'AE_COMMAND_TEST="!./emit.sh"',
      'AE_COUNT_TEST="!./count.sh"',
      'AE_UNUSED_TEST="!./unused.sh"',
    ].join("\n") + "\n",
  );

  const source = createCredentialSource(dir);
  assert.equal(await source.require("AE_PLAIN_TEST"), "synthetic-plain-key");
  assert.equal(await source.require("AE_COMMAND_TEST"), "synthetic-command-key");
  assert.equal(await source.require("AE_COUNT_TEST"), "synthetic-count-key");
  assert.equal(await source.require("AE_COUNT_TEST"), "synthetic-count-key");
  assert.equal(await readFile(join(dir, "count"), "utf8"), "x");
  await assert.rejects(() => readFile(join(dir, "unused-ran")), /ENOENT/);
  assert.equal(process.env.AE_PLAIN_TEST, undefined);
});

test("credential failures are actionable and do not expose command output", async (t) => {
  const dir = await makeTempDir(t, "ae-credentials-fail-");
  await script(dir, "fail.sh", "printf 'STDERR-SENTINEL' >&2\nexit 7");
  await script(dir, "empty.sh", "exit 0");
  await script(dir, "large.sh", "node -e 'process.stdout.write(\"x\".repeat(70000))'");
  await writeFile(
    join(dir, ".env"),
    ['AE_FAIL_TEST="!./fail.sh"', 'AE_EMPTY_TEST="!./empty.sh"', 'AE_LARGE_TEST="!./large.sh"'].join("\n") + "\n",
  );
  const source = createCredentialSource(dir);

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
  const missing = createCredentialSource(emptyDir);
  await assert.rejects(() => missing.require("AE_MISSING_FILE_KEY"), /is unavailable/);

  const parent = await makeTempDir(t, "ae-credentials-parent-");
  await writeFile(join(parent, ".env"), "AE_UPWARD_TEST=parent-key\n");
  const child = join(parent, "child");
  await mkdir(child);
  await assert.rejects(() => createCredentialSource(child).require("AE_UPWARD_TEST"), /is unavailable/);

  const previous = process.env.AE_HOST_ONLY_TEST;
  process.env.AE_HOST_ONLY_TEST = "host-secret-value";
  t.after(() => {
    if (previous === undefined) delete process.env.AE_HOST_ONLY_TEST;
    else process.env.AE_HOST_ONLY_TEST = previous;
  });
  const partial = await makeTempDir(t, "ae-credentials-partial-");
  await writeFile(join(partial, ".env"), "AE_OTHER_TEST=other\n");
  await assert.rejects(
    () => createCredentialSource(partial).require("AE_HOST_ONLY_TEST"),
    (error: unknown) => error instanceof ConfigError && !error.message.includes("host-secret-value"),
  );
});

test("cancelled and timed-out credential commands kill and reap their owned processes", async (t) => {
  const dir = await makeTempDir(t, "ae-credentials-hang-");
  await script(
    dir,
    "hang.sh",
    'node -e \'setInterval(() => {}, 1000)\' &\nchild=$!\nprintf \'%s %s\\n\' "$$" "$child" > hang.pids\nwait "$child"',
  );
  await writeFile(join(dir, ".env"), 'AE_HANG_TEST="!./hang.sh"\n');

  const controller = new AbortController();
  const source = createCredentialSource(dir, controller.signal);
  const pending = source.require("AE_HANG_TEST");
  const cancelledPids = await waitForPids(join(dir, "hang.pids"));
  t.after(() => {
    for (const pid of cancelledPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  controller.abort();
  await assert.rejects(() => pending, /was cancelled/);
  await expectDead(cancelledPids);

  const timeoutPidsFile = join(dir, "timeout.pids");
  await script(
    dir,
    "timeout.sh",
    'node -e \'setInterval(() => {}, 1000)\' &\nchild=$!\nprintf \'%s %s\\n\' "$$" "$child" > timeout.pids\nwait "$child"',
  );
  await writeFile(join(dir, ".env"), 'AE_TIMEOUT_TEST="!./timeout.sh"\n');
  const timeoutSource = createCredentialSource(dir);
  const timeoutPending = timeoutSource.require("AE_TIMEOUT_TEST");
  const timeoutPids = await waitForPids(timeoutPidsFile);
  t.after(() => {
    for (const pid of timeoutPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  await assert.rejects(() => timeoutPending, /timed out after 5000ms/);
  await expectDead(timeoutPids);
});

test("credential commands clean up ordinary background children after leader exit", async (t) => {
  const dir = await makeTempDir(t, "ae-credentials-background-");
  await script(
    dir,
    "success.sh",
    [
      "/bin/sleep 30 &",
      "bg=$!",
      'echo "$bg" > success-bg.pid',
      'ps -o pgid= -p "$bg" | tr -d " " > success-group.pid',
      "printf 'synthetic-proof-key\\n'",
    ].join("\n"),
  );
  await script(
    dir,
    "failure.sh",
    [
      "/bin/sleep 30 &",
      "bg=$!",
      'echo "$bg" > failure-bg.pid',
      'ps -o pgid= -p "$bg" | tr -d " " > failure-group.pid',
      "printf 'synthetic-proof-key\\n'",
      "exit 7",
    ].join("\n"),
  );
  await writeFile(join(dir, ".env"), ['AE_SUCCESS="!./success.sh"', 'AE_FAILURE="!./failure.sh"'].join("\n") + "\n");

  const cleanup = async (): Promise<void> => {
    for (const name of ["success", "failure"]) {
      try {
        const pgid = Number((await readFile(join(dir, `${name}-group.pid`), "utf8")).trim());
        if (Number.isSafeInteger(pgid) && pgid > 1) {
          try {
            process.kill(-pgid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      } catch {
        // No group file.
      }
      try {
        const pid = Number((await readFile(join(dir, `${name}-bg.pid`), "utf8")).trim());
        if (Number.isSafeInteger(pid) && pid > 1) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      } catch {
        // No pid file.
      }
    }
  };
  t.after(cleanup);

  const credentialsHref = new URL("./credentials.ts", import.meta.url).href;
  const childScript = `import { createCredentialSource } from ${JSON.stringify(credentialsHref)};
const source = createCredentialSource(process.argv[1]);
try {
  const value = await source.require(process.env.AE_CREDENTIAL_NAME);
  process.exit(value === "synthetic-proof-key" ? 0 : 2);
} catch {
  process.exit(1);
}`;

  for (const [name, key, expectedCode] of [
    ["success", "AE_SUCCESS", 0],
    ["failure", "AE_FAILURE", 1],
  ] as const) {
    const started = performance.now();
    const child = credentialChildSource(childScript, dir, key);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 4_000);
    const code = await new Promise<number | null>((resolve) => child.on("exit", (value) => resolve(value)));
    clearTimeout(timer);
    assert.equal(timedOut, false, `${name} credential child did not exit: ${stderr}`);
    assert.equal(code, expectedCode, stderr);
    assert.ok(performance.now() - started < 4_000, `${name} credential child exceeded the command budget`);
    assert.doesNotMatch(stdout, /synthetic-proof-key/);
    const bg = Number((await readFile(join(dir, `${name}-bg.pid`), "utf8")).trim());
    const pgid = Number((await readFile(join(dir, `${name}-group.pid`), "utf8")).trim());
    assert.equal(isAlive(bg), false, `${name} background process survived`);
    await expectGroupDead(pgid);
  }
});
