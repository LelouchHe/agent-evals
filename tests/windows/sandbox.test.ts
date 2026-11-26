import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCheckSandbox } from "../../src/engine/check-sandbox.ts";
import { assertWinSandboxAvailable, createSandboxPolicy } from "../../src/platform/windows/policy.ts";
import { spawnSupervised } from "../../src/platform/windows/supervise.ts";

const IS_WINDOWS = process.platform === "win32";

async function collectOutput(stream: NodeJS.ReadableStream | null | undefined): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function makeNeutralRunRoot(prefix: string): Promise<string> {
  const scratchBase = join(process.cwd(), ".win-poc-tmp");
  await mkdir(scratchBase, { recursive: true });
  return mkdtemp(join(scratchBase, prefix));
}

test("Windows sandbox-user preflight probe succeeds", { skip: !IS_WINDOWS }, () => {
  assertWinSandboxAvailable();
});

test(
  "Windows sandbox-user enforces filesystem read/write isolation against real user %USERPROFILE%",
  { skip: !IS_WINDOWS },
  async (t) => {
    const root = await makeNeutralRunRoot("ae-win-fs-");
    const secretRoot = await mkdtemp(join(tmpdir(), "ae-win-secret-"));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(secretRoot, { recursive: true, force: true });
    });

    const workspace = join(root, "workspace");
    const readable = join(root, "readable");
    const engine = join(root, "engine");
    const secretDir = join(secretRoot, "secret");
    await Promise.all([mkdir(workspace), mkdir(readable), mkdir(engine), mkdir(secretDir)]);

    await writeFile(join(readable, "input.txt"), "hello-readable", "utf8");
    await writeFile(join(secretDir, "host-secret.txt"), "top-secret-do-not-read", "utf8");

    const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const results = {};
    try {
      fs.writeFileSync(path.join(process.argv[1], "out.txt"), "written");
      results.workspaceWrite = true;
    } catch (e) { results.workspaceWrite = e.code || String(e); }
    try {
      results.readableRead = fs.readFileSync(path.join(process.argv[2], "input.txt"), "utf8");
    } catch (e) { results.readableRead = e.code || String(e); }
    try {
      fs.writeFileSync(path.join(process.argv[2], "evil.txt"), "nope");
      results.readableWrite = "ALLOWED";
    } catch (e) { results.readableWrite = e.code || "DENIED"; }
    try {
      results.secretRead = fs.readFileSync(path.join(process.argv[3], "host-secret.txt"), "utf8");
    } catch (e) { results.secretRead = e.code || "DENIED"; }
    try {
      fs.writeFileSync(path.join(process.argv[3], "evil-secret.txt"), "nope");
      results.secretWrite = "ALLOWED";
    } catch (e) { results.secretWrite = e.code || "DENIED"; }
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
    proc.child.stdin?.end();
    t.after(() => proc.stop());

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
    assert.notEqual(results.secretWrite, "ALLOWED");
    assert.equal(await readFile(join(workspace, "out.txt"), "utf8"), "written");
  },
);

test(
  "Windows sandbox-user supports piped & ignored child stdio (cmd.exe & PowerShell)",
  { skip: !IS_WINDOWS, timeout: 60_000 },
  async (t) => {
    const root = await makeNeutralRunRoot("ae-win-pipe-");
    t.after(() => rm(root, { recursive: true, force: true }));

    const workspace = join(root, "workspace");
    const engine = join(root, "engine");
    await Promise.all([mkdir(workspace), mkdir(engine)]);

    const script = `
    const { spawn, spawnSync } = require("node:child_process");
    const cmd = process.env.ComSpec || "C:\\\\Windows\\\\System32\\\\cmd.exe";
    const results = {};
    const p = spawn(cmd, ["/d", "/c", "echo piped-ok"], { stdio: "pipe", windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => { results.asyncPipe = { error: e.code || e.message }; next(); });
    p.on("close", (code) => { results.asyncPipe = { code, out: out.trim(), err: err.trim() }; next(); });
    function next() {
      const syncRes = spawnSync(cmd, ["/d", "/c", "echo sync-ok"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      results.syncPipe = {
        status: syncRes.status,
        stdout: (syncRes.stdout || "").trim(),
        error: syncRes.error ? (syncRes.error.code || syncRes.error.message) : null,
      };
      const ignRes = spawnSync(cmd, ["/d", "/c", "exit 0"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
      results.ignoreStdio = {
        status: ignRes.status,
        error: ignRes.error ? (ignRes.error.code || ignRes.error.message) : null,
      };
      const psRes = spawnSync(
        "pwsh.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output ('ps-user=' + [Environment]::UserName)"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 15000 },
      );
      results.powershell = {
        status: psRes.status,
        stdout: (psRes.stdout || "").trim(),
        stderr: (psRes.stderr || "").trim(),
        error: psRes.error ? (psRes.error.code || psRes.error.message) : null,
      };
      process.stdout.write(JSON.stringify(results));
      process.exit(0);
    }
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
    proc.child.stdin?.end();
    t.after(() => proc.stop());

    const [stdout, stderr, code] = await Promise.all([
      collectOutput(proc.child.stdout),
      collectOutput(proc.child.stderr),
      proc.completion,
    ]);

    assert.equal(code, 0, `stderr: ${stderr}`);
    const parsed = JSON.parse(stdout) as {
      asyncPipe: { code: number; out: string; err: string };
      syncPipe: { status: number; stdout: string; error: string | null };
      ignoreStdio: { status: number; error: string | null };
      powershell: { status: number; stdout: string; stderr: string; error: string | null };
    };
    assert.deepEqual(parsed.asyncPipe, { code: 0, out: "piped-ok", err: "" });
    assert.deepEqual(parsed.syncPipe, { status: 0, stdout: "sync-ok", error: null });
    assert.deepEqual(parsed.ignoreStdio, { status: 0, error: null });
    assert.equal(parsed.powershell.error, null, `powershell error: ${JSON.stringify(parsed.powershell)}`);
    assert.equal(parsed.powershell.status, 0, `powershell stderr: ${parsed.powershell.stderr}`);
    assert.equal(parsed.powershell.stdout, "ps-user=agent-evals-offline");
  },
);

test("Windows sandbox-user runs git and fs.realpathSync natively", { skip: !IS_WINDOWS }, async (t) => {
  const root = await makeNeutralRunRoot("ae-win-git-");
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "workspace");
  const engine = join(root, "engine");
  await Promise.all([mkdir(workspace), mkdir(engine)]);

  const script = `
    const fs = require("node:fs");
    const { spawnSync } = require("node:child_process");
    const real = fs.realpathSync(process.cwd());
    const realNative = fs.realpathSync.native(process.cwd());
    const gitInit = spawnSync("git", ["init", "-q"], { encoding: "utf8", windowsHide: true });
    const gitStatus = spawnSync("git", ["status", "--short"], { encoding: "utf8", windowsHide: true });
    process.stdout.write(JSON.stringify({
      realOk: real.length > 0,
      realNativeOk: realNative.length > 0,
      gitInitStatus: gitInit.status,
      gitInitErr: gitInit.error ? String(gitInit.error) : gitInit.stderr,
      gitStatus: gitStatus.status,
    }));
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
    env: { TEMP: workspace, TMP: workspace, PATH: process.env.PATH ?? "" },
    interactive: false,
  });
  proc.child.stdin?.end();
  t.after(() => proc.stop());

  const [stdout, stderr, code] = await Promise.all([
    collectOutput(proc.child.stdout),
    collectOutput(proc.child.stderr),
    proc.completion,
  ]);

  assert.equal(code, 0, `stderr: ${stderr}`);
  const parsed = JSON.parse(stdout) as {
    realOk: boolean;
    realNativeOk: boolean;
    gitInitStatus: number;
    gitInitErr: string;
    gitStatus: number;
  };
  assert.equal(parsed.realOk, true);
  assert.equal(parsed.realNativeOk, true);
  assert.equal(parsed.gitInitStatus, 0, `git init failed: ${parsed.gitInitErr}`);
  assert.equal(parsed.gitStatus, 0);
});

test(
  "Windows sandbox-user blocks outbound network for agent-evals-offline (allowNetwork: false)",
  { skip: !IS_WINDOWS },
  async (t) => {
    const root = await makeNeutralRunRoot("ae-win-net-deny-");
    t.after(() => rm(root, { recursive: true, force: true }));

    const workspace = join(root, "workspace");
    const engine = join(root, "engine");
    await Promise.all([mkdir(workspace), mkdir(engine)]);

    const script = `
    const net = require("node:net");
    const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
    socket.on("connect", () => { process.stdout.write("CONNECTED"); socket.destroy(); process.exit(0); });
    socket.on("error", (err) => { process.stdout.write("ERROR:" + (err.code || err.message)); process.exit(0); });
    socket.on("timeout", () => { process.stdout.write("TIMEOUT"); socket.destroy(); process.exit(0); });
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
    proc.child.stdin?.end();
    t.after(() => proc.stop());

    const [stdout, stderr, code] = await Promise.all([
      collectOutput(proc.child.stdout),
      collectOutput(proc.child.stderr),
      proc.completion,
    ]);

    assert.equal(code, 0, `stderr: ${stderr}`);
    assert.ok(stdout.startsWith("ERROR:") || stdout === "TIMEOUT", `expected network block, got: ${stdout}`);
  },
);

test(
  "Windows sandbox-user allows outbound network for agent-evals-online (allowNetwork: true)",
  { skip: !IS_WINDOWS },
  async (t) => {
    const root = await makeNeutralRunRoot("ae-win-net-allow-");
    t.after(() => rm(root, { recursive: true, force: true }));

    const workspace = join(root, "workspace");
    const engine = join(root, "engine");
    await Promise.all([mkdir(workspace), mkdir(engine)]);

    const script = `
    const net = require("node:net");
    const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 5000 });
    socket.on("connect", () => { process.stdout.write("CONNECTED"); socket.destroy(); process.exit(0); });
    socket.on("error", (err) => { process.stdout.write("ERROR:" + (err.code || err.message)); process.exit(0); });
    socket.on("timeout", () => { process.stdout.write("TIMEOUT"); socket.destroy(); process.exit(0); });
  `;

    const policy = createSandboxPolicy({
      writableRoots: [workspace],
      readableRoots: [],
      readableFiles: [process.execPath],
      allowNetwork: true,
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
    proc.child.stdin?.end();
    t.after(() => proc.stop());

    const [stdout, stderr, code] = await Promise.all([
      collectOutput(proc.child.stdout),
      collectOutput(proc.child.stderr),
      proc.completion,
    ]);

    assert.equal(code, 0, `stderr: ${stderr}`);
    assert.equal(stdout, "CONNECTED", `expected outbound TCP connection, got: ${stdout}`);
  },
);

test("Windows Job Object kills backgrounded descendants on exit", { skip: !IS_WINDOWS }, async (t) => {
  const root = await makeNeutralRunRoot("ae-win-job-");
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "workspace");
  const engine = join(root, "engine");
  await Promise.all([mkdir(workspace), mkdir(engine)]);

  const script = `
    const { spawn } = require("node:child_process");
    const cmd = process.env.ComSpec || "C:\\\\Windows\\\\System32\\\\cmd.exe";
    const child = spawn(cmd, ["/d", "/c", "ping -n 60 127.0.0.1 >nul"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
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
  proc.child.stdin?.end();
  t.after(() => proc.stop());

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

test(
  "Windows sandbox-user runs fake stdio JSON-RPC agent executing PowerShell tool end-to-end",
  { skip: !IS_WINDOWS },
  async (t) => {
    const root = await makeNeutralRunRoot("ae-win-fake-");
    const secretRoot = await mkdtemp(join(tmpdir(), "ae-win-secret-"));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(secretRoot, { recursive: true, force: true });
    });

    const workspace = join(root, "workspace");
    const deps = join(root, "deps");
    const engine = join(root, "engine");
    const secretDir = join(secretRoot, "secret");
    await Promise.all([mkdir(workspace), mkdir(deps), mkdir(engine), mkdir(secretDir)]);

    await writeFile(join(secretDir, "cred.txt"), "do-not-leak", "utf8");
    const fakeAgentPath = join(deps, "fake-agent.mjs");
    await writeFile(
      fakeAgentPath,
      `import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
    const toolOut = execFileSync(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output 'ps-tool-ran-ok'"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    ).trim();
    writeFileSync(join(process.cwd(), "hello.txt"), "Hello from Windows sandbox: " + toolOut + "\\n", "utf8");
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, secretBlocked, toolOut }) + "\\n");
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
      allowNetwork: true,
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
    t.after(() => proc.stop());

    proc.child.stdin?.write(JSON.stringify({ id: 1, type: "prompt", secretPath: join(secretDir, "cred.txt") }) + "\n");
    proc.child.stdin?.end();

    const [stdout, stderr, code] = await Promise.all([
      collectOutput(proc.child.stdout),
      collectOutput(proc.child.stderr),
      proc.completion,
    ]);

    assert.equal(code, 0, `stderr: ${stderr}`);
    const reply = JSON.parse(stdout.trim()) as { id: number; ok: boolean; secretBlocked: boolean; toolOut: string };
    assert.deepEqual(reply, { id: 1, ok: true, secretBlocked: true, toolOut: "ps-tool-ran-ok" });
    assert.equal(await readFile(join(workspace, "hello.txt"), "utf8"), "Hello from Windows sandbox: ps-tool-ran-ok\n");
  },
);

test("Windows sandbox-user revokes NTFS ACLs on graceful stop()", { skip: !IS_WINDOWS }, async (t) => {
  const root = await makeNeutralRunRoot("ae-win-acl-");
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "workspace");
  const engine = join(root, "engine");
  await Promise.all([mkdir(workspace), mkdir(engine)]);

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
    command: [process.execPath, "-e", "process.stdout.write('ready\\n'); setTimeout(() => {}, 60000);"],
    cwd: workspace,
    env: { TEMP: workspace, TMP: workspace },
    interactive: false,
  });

  await new Promise<void>((resolveReady, rejectReady) => {
    let seen = "";
    proc.child.stdout?.on("data", (chunk: Buffer | string) => {
      seen += chunk.toString();
      if (seen.includes("ready")) resolveReady();
    });
    proc.child.once("exit", (code) => rejectReady(new Error(`exited early with code ${code}`)));
  });

  await proc.stop();

  const aclOutput = execFileSync("icacls", [workspace], { encoding: "utf8", windowsHide: true });
  assert.doesNotMatch(aclOutput, /agent-evals-(online|offline)/iu, `leftover sandbox user ACE in ACL:\n${aclOutput}`);
});

test(
  "Windows createCheckSandbox runs check program offline and reports outcome via report pipe",
  { skip: !IS_WINDOWS },
  async (t) => {
    const root = await makeNeutralRunRoot("ae-win-check-");
    t.after(() => rm(root, { recursive: true, force: true }));

    const workspace = join(root, "workspace");
    const engine = join(root, "engine");
    const authoring = join(root, "authoring");
    await Promise.all([mkdir(workspace), mkdir(engine), mkdir(authoring)]);
    await writeFile(join(authoring, "expected.txt"), "hello-check", "utf8");

    const sandbox = createCheckSandbox({
      workspaceDir: workspace,
      engineDir: engine,
      authoringDir: authoring,
      signal: AbortSignal.timeout(15_000),
    });

    const ok = await sandbox.run(
      [process.execPath, "-e", "const fs = require('node:fs'); console.log(fs.readFileSync('staged.txt', 'utf8'));"],
      { files: { "staged.txt": "expected.txt" } },
    );
    assert.equal(ok.kind, "exited", JSON.stringify(ok));
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.output.trim(), "hello-check");

    const fail = await sandbox.run([process.execPath, "-e", "console.error('boom'); process.exit(7);"]);
    assert.equal(fail.kind, "exited", JSON.stringify(fail));
    assert.equal(fail.exitCode, 7);
    assert.match(fail.output, /boom/u);
  },
);
