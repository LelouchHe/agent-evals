import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { makeTempDir } from "../../tests/helpers/fake-pi-control.ts";
import { createCheckSandbox } from "./check-sandbox.ts";
import type { CheckSandboxOutcome } from "./registry.ts";

async function setup(t: TestContext) {
  const root = await makeTempDir(t, "ae-check-sandbox-");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  return {
    root,
    workspace,
    outside,
    run: (command: readonly string[], signal = AbortSignal.timeout(15_000)): Promise<CheckSandboxOutcome> =>
      createCheckSandbox({ workspaceDir: workspace, runRootDir: root, signal }).run(command),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "the check sandbox opens reads but restricts writes to the workspace and private directories",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);

    const readable = await dirs.run(["/bin/cat", "/etc/hosts"]);
    assert.equal(readable.kind, "exited");
    assert.equal(readable.kind === "exited" ? readable.exitCode : 1, 0, readable.output);

    const wrote = await dirs.run([
      "/bin/sh",
      "-c",
      'printf workspace > ws.txt && printf home > "$HOME/private.txt" && printf tmp > "$TMPDIR/private.txt"',
    ]);
    assert.equal(wrote.kind, "exited");
    assert.equal(wrote.kind === "exited" ? wrote.exitCode : 1, 0, wrote.output);
    assert.equal(await readFile(join(dirs.workspace, "ws.txt"), "utf8"), "workspace");

    for (const [label, path] of [
      ["outside the workspace", join(dirs.outside, "denied.txt")],
      ["the operator's home", join(process.env.HOME ?? "/tmp", ".agent-evals-check-sandbox-denied")],
      ["/tmp", join("/tmp", ".agent-evals-check-sandbox-denied")],
    ] as const) {
      const denied = await dirs.run(["/bin/sh", "-c", 'printf denied > "$1"', "sh", path]);
      assert.equal(denied.kind, "exited", label);
      assert.notEqual(denied.kind === "exited" ? denied.exitCode : 0, 0, label);
      assert.match(denied.output, /Operation not permitted/, label);
    }
  },
);

test(
  "the check sandbox passes only the operator PATH and private HOME and TMPDIR",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    const outcome = await dirs.run(["/usr/bin/env"]);
    assert.equal(outcome.kind, "exited");
    assert.equal(outcome.kind === "exited" ? outcome.exitCode : 1, 0, outcome.output);
    const environment = Object.fromEntries(
      outcome.output
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    assert.deepEqual(Object.keys(environment).sort(), ["HOME", "PATH", "TMPDIR"]);
    assert.equal(environment.PATH, process.env.PATH);
    for (const key of ["HOME", "TMPDIR"] as const) {
      assert.notEqual(environment[key], process.env[key]);
      assert.match(environment[key] ?? "", new RegExp(`^${dirs.root}/check-[^/]+/${key === "HOME" ? "home" : "tmp"}$`));
    }
  },
);

test(
  "the check sandbox denies network connections, loopback included",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.close();
    });
    const { port } = server.address() as { port: number };
    const script = [
      "const net = require('node:net');",
      `const socket = net.connect({ host: '127.0.0.1', port: ${port} });`,
      "socket.on('error', (error) => { console.log(error.code); process.exit(error.code === 'EPERM' ? 0 : 1); });",
      "socket.on('connect', () => { console.log('connected'); process.exit(1); });",
      "setTimeout(() => { console.log('timeout'); process.exit(1); }, 5000);",
    ].join(" ");
    const outcome = await dirs.run([process.execPath, "-e", script]);
    assert.equal(outcome.kind, "exited", outcome.output);
    assert.equal(outcome.kind === "exited" ? outcome.exitCode : 1, 0, outcome.output);
    assert.equal(outcome.output.trim(), "EPERM");
  },
);

test(
  "a program that cannot start, dies from a signal or overruns is an error outcome",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);

    const missing = await dirs.run(["agent-evals-definitely-missing"]);
    assert.deepEqual(missing, {
      kind: "failed",
      reason: "could not start agent-evals-definitely-missing: no executable",
      output: "",
    });

    const signalled = await dirs.run(["/bin/sh", "-c", "kill -KILL $$"]);
    assert.equal(signalled.kind, "signalled");
    assert.equal(signalled.kind === "signalled" ? signalled.signal : undefined, "SIGKILL");

    // A background process outlives the leader; the supervisor must still end both at the deadline.
    const pidFile = join(dirs.workspace, "background.pid");
    const timedOut = await dirs.run(
      ["/bin/sh", "-c", '/bin/sleep 30 & printf "%s" $! > background.pid; /bin/sleep 30'],
      AbortSignal.timeout(500),
    );
    assert.equal(timedOut.kind, "failed");
    assert.match(timedOut.kind === "failed" ? timedOut.reason : "", /did not finish before the check deadline/);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    for (let attempt = 0; attempt < 100 && alive(pid); attempt += 1) {
      await delay(50);
    }
    assert.equal(alive(pid), false, "the background process survived the check");
  },
);
