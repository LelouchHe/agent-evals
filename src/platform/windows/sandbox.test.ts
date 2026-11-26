import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertWinSandboxAvailable, createSandboxPolicy } from "./policy.ts";
import { spawnSupervised } from "./supervise.ts";

const IS_WINDOWS = process.platform === "win32";

async function collectOutput(stream: NodeJS.ReadableStream | null | undefined): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

test("Windows AppContainer preflight probe succeeds", { skip: !IS_WINDOWS }, () => {
  assertWinSandboxAvailable();
});

test("Windows AppContainer enforces filesystem read/write isolation", { skip: !IS_WINDOWS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ae-win-fs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "workspace");
  const readable = join(root, "readable");
  const engine = join(root, "engine");
  const secretDir = join(root, "secret");
  await Promise.all([mkdir(workspace), mkdir(readable), mkdir(engine), mkdir(secretDir)]);

  await writeFile(join(readable, "input.txt"), "hello-readable", "utf8");
  await writeFile(join(secretDir, "host-secret.txt"), "top-secret-do-not-read", "utf8");

  const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const results = {};
    // 1. Write inside writable workspace
    try {
      fs.writeFileSync(path.join(process.argv[1], "out.txt"), "written");
      results.workspaceWrite = true;
    } catch (e) { results.workspaceWrite = e.code || String(e); }
    // 2. Read inside readable root
    try {
      results.readableRead = fs.readFileSync(path.join(process.argv[2], "input.txt"), "utf8");
    } catch (e) { results.readableRead = e.code || String(e); }
    // 3. Write inside readable root (must fail)
    try {
      fs.writeFileSync(path.join(process.argv[2], "evil.txt"), "nope");
      results.readableWrite = "ALLOWED";
    } catch (e) { results.readableWrite = e.code || "DENIED"; }
    // 4. Read outside secret file (must fail)
    try {
      results.secretRead = fs.readFileSync(path.join(process.argv[3], "host-secret.txt"), "utf8");
    } catch (e) { results.secretRead = e.code || "DENIED"; }
    process.stdout.write(JSON.stringify(results));
  `;

  const policy = createSandboxPolicy({
    writableRoots: [workspace],
    readableRoots: [readable],
    readableFiles: [process.execPath],
    allowNetwork: false,
    interactive: false,
  });

  const proc = await spawnSupervised({
    policy,
    policyDirectory: engine,
    command: [process.execPath, "-e", script, workspace, readable, secretDir],
    cwd: workspace,
    env: { TEMP: workspace, TMP: workspace },
    interactive: false,
  });

  const [stdout, stderr, code] = await Promise.all([
    collectOutput(proc.child.stdout),
    collectOutput(proc.child.stderr),
    proc.completion,
  ]);

  assert.equal(code, 0, `stderr: ${stderr}`);
  const results = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(results.workspaceWrite, true);
  assert.equal(results.readableRead, "hello-readable");
  assert.notEqual(results.readableWrite, "ALLOWED");
  assert.notEqual(results.secretRead, "top-secret-do-not-read");
  assert.equal(await readFile(join(workspace, "out.txt"), "utf8"), "written");
});

test("Windows AppContainer blocks outbound network when allowNetwork is false", { skip: !IS_WINDOWS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ae-win-net-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "workspace");
  const engine = join(root, "engine");
  await Promise.all([mkdir(workspace), mkdir(engine)]);

  const script = `
    const net = require("node:net");
    const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
    socket.on("connect", () => {
      process.stdout.write("CONNECTED");
      socket.destroy();
      process.exit(0);
    });
    socket.on("error", (err) => {
      process.stdout.write("ERROR:" + (err.code || err.message));
      process.exit(0);
    });
    socket.on("timeout", () => {
      process.stdout.write("TIMEOUT");
      socket.destroy();
      process.exit(0);
    });
  `;

  const policy = createSandboxPolicy({
    writableRoots: [workspace],
    readableRoots: [],
    readableFiles: [process.execPath],
    allowNetwork: false,
    interactive: false,
  });

  const proc = await spawnSupervised({
    policy,
    policyDirectory: engine,
    command: [process.execPath, "-e", script],
    cwd: workspace,
    env: { TEMP: workspace, TMP: workspace },
    interactive: false,
  });

  const [stdout, stderr, code] = await Promise.all([
    collectOutput(proc.child.stdout),
    collectOutput(proc.child.stderr),
    proc.completion,
  ]);

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(stdout.startsWith("ERROR:"), `expected network denial error, got: ${stdout}`);
});

test("Windows Job Object kills backgrounded descendants on exit", { skip: !IS_WINDOWS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ae-win-job-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "workspace");
  const engine = join(root, "engine");
  await Promise.all([mkdir(workspace), mkdir(engine)]);

  const script = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    process.stdout.write(String(child.pid));
  `;

  const policy = createSandboxPolicy({
    writableRoots: [workspace],
    readableRoots: [],
    readableFiles: [process.execPath],
    allowNetwork: false,
    interactive: false,
  });

  const proc = await spawnSupervised({
    policy,
    policyDirectory: engine,
    command: [process.execPath, "-e", script],
    cwd: workspace,
    env: { TEMP: workspace, TMP: workspace },
    interactive: false,
  });

  const [stdout, stderr, code] = await Promise.all([
    collectOutput(proc.child.stdout),
    collectOutput(proc.child.stderr),
    proc.completion,
  ]);

  assert.equal(code, 0, `stderr: ${stderr}`);
  const childPid = Number(stdout.trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0, `expected valid child pid, got: ${stdout}`);

  await delay(200);
  let alive: boolean;
  try {
    process.kill(childPid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `descendant pid ${childPid} survived after sandbox exit`);
});

test("Windows AppContainer runs fake stdio JSON-RPC agent end-to-end", { skip: !IS_WINDOWS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ae-win-fake-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "workspace");
  const deps = join(root, "deps");
  const engine = join(root, "engine");
  const secretDir = join(root, "secret");
  await Promise.all([mkdir(workspace), mkdir(deps), mkdir(engine), mkdir(secretDir)]);

  await writeFile(join(secretDir, "cred.txt"), "do-not-leak", "utf8");
  const fakeAgentPath = join(deps, "fake-agent.mjs");
  await writeFile(
    fakeAgentPath,
    `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    let secretBlocked = false;
    try {
      readFileSync(msg.secretPath, "utf8");
    } catch {
      secretBlocked = true;
    }
    writeFileSync(join(process.cwd(), "hello.txt"), "Hello from Windows sandbox!\\n", "utf8");
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, secretBlocked }) + "\\n");
    break;
  }
}
`,
    "utf8",
  );

  const policy = createSandboxPolicy({
    writableRoots: [workspace],
    readableRoots: [deps],
    readableFiles: [process.execPath],
    allowNetwork: false,
    interactive: false,
  });

  const proc = await spawnSupervised({
    policy,
    policyDirectory: engine,
    command: [process.execPath, fakeAgentPath],
    cwd: workspace,
    env: { TEMP: workspace, TMP: workspace },
    interactive: false,
  });

  proc.child.stdin?.write(JSON.stringify({ id: 1, type: "prompt", secretPath: join(secretDir, "cred.txt") }) + "\n");
  proc.child.stdin?.end();

  const [stdout, stderr, code] = await Promise.all([
    collectOutput(proc.child.stdout),
    collectOutput(proc.child.stderr),
    proc.completion,
  ]);

  assert.equal(code, 0, `stderr: ${stderr}`);
  const reply = JSON.parse(stdout.trim()) as { id: number; ok: boolean; secretBlocked: boolean };
  assert.deepEqual(reply, { id: 1, ok: true, secretBlocked: true });
  assert.equal(await readFile(join(workspace, "hello.txt"), "utf8"), "Hello from Windows sandbox!\n");
});
