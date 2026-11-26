import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runCli(args: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["src/cli.ts", ...args], {
      cwd: process.cwd(),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

test("setup rejects missing or unknown targets and mismatched flags", async () => {
  const missing = await runCli(["setup"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /setup target is required/i);

  const unknown = await runCli(["setup", "bogus"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown setup target/i);

  const wrongFlag = await runCli(["setup", "sandbox", "--reps", "2"]);
  assert.equal(wrongFlag.code, 2);
  assert.match(wrongFlag.stderr, /setup accepts only/i);

  const misplacedTeardown = await runCli(["view", "case.yml", "--teardown"]);
  assert.equal(misplacedTeardown.code, 2);
  assert.match(misplacedTeardown.stderr, /--teardown applies only to setup/i);
});

test(
  "setup sandbox reports readiness and teardown is a no-op on POSIX",
  { skip: process.platform === "win32" },
  async () => {
    const ready = await runCli(["setup", "sandbox"]);
    assert.equal(ready.code, 0, ready.stderr);
    assert.match(ready.stdout, /sandbox is ready/i);

    const teardown = await runCli(["setup", "sandbox", "--teardown"]);
    assert.equal(teardown.code, 0, teardown.stderr);
    assert.match(teardown.stdout, /no host teardown/i);
  },
);
