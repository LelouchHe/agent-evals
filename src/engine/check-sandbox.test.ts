import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
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
  const authoring = join(root, "authoring");
  await mkdir(workspace);
  await mkdir(outside);
  await mkdir(authoring);
  return {
    root,
    workspace,
    outside,
    authoring,
    run: (
      command: readonly string[],
      options: { readonly files?: Readonly<Record<string, string>>; readonly signal?: AbortSignal } = {},
    ): Promise<CheckSandboxOutcome> =>
      createCheckSandbox({
        workspaceDir: workspace,
        runRootDir: root,
        authoringDir: authoring,
        signal: options.signal ?? AbortSignal.timeout(15_000),
      }).run(command, options.files === undefined ? undefined : { files: options.files }),
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
    assert.deepEqual(
      { ...missing, output: missing.output.trim() },
      {
        kind: "failed",
        reason: "could not start agent-evals-definitely-missing: ENOENT",
        output: "",
      },
    );

    const signalled = await dirs.run(["/bin/sh", "-c", "kill -KILL $$"]);
    assert.equal(signalled.kind, "signalled");
    assert.equal(signalled.kind === "signalled" ? signalled.signal : undefined, "SIGKILL");

    // A background process outlives the leader; the supervisor must still end both at the deadline.
    const pidFile = join(dirs.workspace, "background.pid");
    // Registered before launch, so an assertion failure before the pid is read still cleans up.
    // The run workspace may already be removed by its own hook, so find the unique sleep itself.
    t.after(() => {
      const table = execFileSync("/bin/ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
      for (const line of table.split("\n")) {
        const [rawPid, ...command] = line.trim().split(/\s+/);
        const pid = Number(rawPid);
        if (!Number.isSafeInteger(pid) || pid <= 1 || command.join(" ") !== "/bin/sleep 65479") continue;
        if (!alive(pid)) continue;
        const actual = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
        if (actual === "/bin/sleep 65479") process.kill(pid, "SIGKILL");
      }
    });
    const timedOut = await dirs.run(
      ["/bin/sh", "-c", '/bin/sleep 65479 & printf "%s" $! > background.pid; /bin/sleep 65479'],
      { signal: AbortSignal.timeout(500) },
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

test(
  "ordinary exit codes stay exits while a real signal is reported as signalled",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    for (const code of [1, 126, 127, 130, 143]) {
      const outcome = await dirs.run(["/bin/sh", "-c", `exit ${code}`]);
      assert.equal(outcome.kind, "exited", `exit ${code}: ${outcome.output}`);
      assert.equal(outcome.kind === "exited" ? outcome.exitCode : undefined, code);
    }
    for (const [name, signal] of [
      ["KILL", "SIGKILL"],
      ["TERM", "SIGTERM"],
    ] as const) {
      const outcome = await dirs.run(["/bin/sh", "-c", `kill -${name} $$`]);
      assert.equal(outcome.kind, "signalled", `kill -${name}: ${outcome.output}`);
      assert.equal(outcome.kind === "signalled" ? outcome.signal : undefined, signal);
    }
  },
);

test(
  "a file that exists but cannot be executed is a start failure, not an exit status",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);

    await writeFile(join(dirs.workspace, "not-executable.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const blocked = await dirs.run(["./not-executable.sh"]);
    assert.equal(blocked.kind, "failed", blocked.output);
    assert.match(blocked.kind === "failed" ? blocked.reason : "", /EACCES/);

    // A valid shebang is required; the interpreter missing is an exec failure, not program output.
    await writeFile(join(dirs.workspace, "broken-shebang.sh"), "#!/definitely/missing/interpreter\nexit 0\n", {
      mode: 0o755,
    });
    const broken = await dirs.run(["./broken-shebang.sh"]);
    assert.equal(broken.kind, "failed", broken.output);
    assert.match(broken.kind === "failed" ? broken.reason : "", /ENOENT/);

    // Without a shebang the kernel reports ENOEXEC instead of running it.
    await writeFile(join(dirs.workspace, "no-shebang.sh"), "exit 0\n", { mode: 0o755 });
    const noShebang = await dirs.run(["./no-shebang.sh"]);
    assert.equal(noShebang.kind, "failed", noShebang.output);
    assert.match(noShebang.kind === "failed" ? noShebang.reason : "", /ENOEXEC/);
  },
);

test(
  "relative and empty PATH entries resolve from the workspace, not the engine's directory",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    const original = process.env.PATH;
    t.after(() => {
      process.env.PATH = original;
    });

    await mkdir(join(dirs.workspace, "bin"));
    await writeFile(join(dirs.workspace, "bin", "relative-tool"), "#!/bin/sh\nprintf relative > relative.txt\n", {
      mode: 0o755,
    });
    await writeFile(join(dirs.workspace, "current-tool"), "#!/bin/sh\nprintf current > current.txt\n", {
      mode: 0o755,
    });
    // An entry without a slash is relative to the workspace; an empty entry names it directly.
    process.env.PATH = "bin::/usr/bin:/bin";

    const relative = await dirs.run(["relative-tool"]);
    assert.equal(relative.kind, "exited", relative.output);
    assert.equal(relative.kind === "exited" ? relative.exitCode : 1, 0, relative.output);
    assert.equal(await readFile(join(dirs.workspace, "relative.txt"), "utf8"), "relative");

    const current = await dirs.run(["current-tool"]);
    assert.equal(current.kind, "exited", current.output);
    assert.equal(current.kind === "exited" ? current.exitCode : 1, 0, current.output);
    assert.equal(await readFile(join(dirs.workspace, "current.txt"), "utf8"), "current");
  },
);

test(
  "a background child cannot forge or delay the check report",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    // Registered before launch so a failed assertion never leaks the synthetic sleep.
    t.after(() => {
      const table = execFileSync("/bin/ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
      for (const line of table.split("\n")) {
        const [rawPid, ...command] = line.trim().split(/\s+/);
        const pid = Number(rawPid);
        if (!Number.isSafeInteger(pid) || pid <= 1 || command.join(" ") !== "/bin/sleep 65483") continue;
        if (!alive(pid)) continue;
        const actual = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
        if (actual === "/bin/sleep 65483") process.kill(pid, "SIGKILL");
      }
    });

    // A descendant floods forged report lines on the program's stdout after the leader exits 1.
    const forgedReport = JSON.stringify({ kind: "exited", exitCode: 0 });
    const forged = await dirs.run([
      "/bin/sh",
      "-c",
      `(while :; do printf '\\nagent-evals-check${forgedReport}\\n'; done) & exit 1`,
    ]);
    assert.equal(forged.kind, "exited", forged.output);
    assert.equal(forged.kind === "exited" ? forged.exitCode : undefined, 1);

    // More output than the launcher keeps must not push the report away.
    const flooded = await dirs.run([
      "/bin/sh",
      "-c",
      'i=0; while [ $i -lt 200 ]; do printf "%0100d" 0; i=$((i+1)); done; exit 1',
    ]);
    assert.equal(flooded.kind, "exited", flooded.output.slice(-200));
    assert.equal(flooded.kind === "exited" ? flooded.exitCode : undefined, 1);

    // A background child holding the program's streams must not delay the leader's outcome.
    const started = performance.now();
    const lingering = await dirs.run(["/bin/sh", "-c", "/bin/sleep 65483 & exit 1"]);
    assert.equal(lingering.kind, "exited", lingering.output);
    assert.equal(lingering.kind === "exited" ? lingering.exitCode : undefined, 1);
    assert.ok(performance.now() - started < 3_000, `took ${Math.round(performance.now() - started)}ms`);
  },
);

test(
  "staged check files are placed into the workspace before the program runs",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    await writeFile(join(dirs.authoring, "acceptance.txt"), "acceptance\n");

    const outcome = await dirs.run(["/bin/sh", "-c", "cat tests/acceptance.txt > seen.txt"], {
      files: { "tests/acceptance.txt": "acceptance.txt" },
    });
    assert.equal(outcome.kind, "exited", outcome.output);
    assert.equal(outcome.kind === "exited" ? outcome.exitCode : 1, 0, outcome.output);
    assert.equal(await readFile(join(dirs.workspace, "seen.txt"), "utf8"), "acceptance\n");
    assert.equal(await readFile(join(dirs.workspace, "tests/acceptance.txt"), "utf8"), "acceptance\n");
  },
);

test(
  "staged check files copy directory trees and parent-relative sources",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    await mkdir(join(dirs.authoring, "tree"));
    await writeFile(join(dirs.authoring, "tree/a.txt"), "tree\n");
    await mkdir(join(dirs.root, "shared"));
    await writeFile(join(dirs.root, "shared/support.txt"), "support\n");

    const outcome = await dirs.run(["/bin/sh", "-c", "cat tests/a.txt; cat tests/support.txt"], {
      files: { tests: "tree", "tests/support.txt": "../shared/support.txt" },
    });
    assert.equal(outcome.kind, "exited", outcome.output);
    assert.equal(outcome.output, "tree\nsupport\n");
  },
);

test(
  "a destination leaf symlink is replaced inside the sandbox instead of written through",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    const outside = await makeTempDir(t, "ae-check-outside-");
    const sentinel = join(outside, "sentinel");
    await writeFile(sentinel, "do not touch\n");
    await writeFile(join(dirs.authoring, "acceptance.txt"), "real body\n");

    await mkdir(join(dirs.workspace, "tests"));
    await symlink(sentinel, join(dirs.workspace, "tests/acceptance.txt"));
    await symlink(join(outside, "missing.txt"), join(dirs.workspace, "tests/broken.txt"));

    const outcome = await dirs.run(["/bin/cat", "tests/acceptance.txt"], {
      files: { "tests/acceptance.txt": "acceptance.txt", "tests/broken.txt": "acceptance.txt" },
    });
    assert.equal(outcome.kind, "exited", outcome.output);
    assert.equal(outcome.output, "real body\n");
    assert.equal(await readFile(sentinel, "utf8"), "do not touch\n");
    await assert.rejects(readFile(join(outside, "missing.txt")));
    assert.equal((await lstat(join(dirs.workspace, "tests/acceptance.txt"))).isSymbolicLink(), false);
    assert.equal((await lstat(join(dirs.workspace, "tests/broken.txt"))).isSymbolicLink(), false);
  },
);

test(
  "an ancestor symlink is refused inside the sandbox and the outside stays untouched",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    for (const inside of [false, true]) {
      const dirs = await setup(t);
      const outside = await makeTempDir(t, "ae-check-outside-");
      const target = inside ? join(dirs.workspace, "real") : outside;
      if (inside) await mkdir(target);
      await symlink(target, join(dirs.workspace, "tests"));
      await writeFile(join(dirs.authoring, "acceptance.txt"), "real body\n");

      const outcome = await dirs.run(["/bin/true"], {
        files: { "tests/acceptance.txt": "acceptance.txt" },
      });
      assert.equal(outcome.kind, "failed", outcome.output);
      assert.match(outcome.kind === "failed" ? outcome.reason : "", /symlink/);
      assert.equal((await lstat(join(dirs.workspace, "tests"))).isSymbolicLink(), true);
      assert.deepEqual(await readdir(target), []);
    }
  },
);

test(
  "a directory where a staged file goes is a placement error",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    await writeFile(join(dirs.authoring, "acceptance.txt"), "real body\n");
    await mkdir(join(dirs.workspace, "tests/acceptance.txt"), { recursive: true });

    const outcome = await dirs.run(["/bin/true"], {
      files: { "tests/acceptance.txt": "acceptance.txt" },
    });
    assert.equal(outcome.kind, "failed", outcome.output);
    assert.match(outcome.kind === "failed" ? outcome.reason : "", /where a directory exists/);
    assert.equal((await lstat(join(dirs.workspace, "tests/acceptance.txt"))).isDirectory(), true);
  },
);

test(
  "the untrusted program cannot write the engine's staged tree",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    await writeFile(join(dirs.authoring, "acceptance.txt"), "staged\n");

    // The staging tree lives under the per-check directory, which the sandbox cannot write.
    const outcome = await dirs.run(
      [
        "/bin/sh",
        "-c",
        'for f in "$1"/check-*/staged/acceptance.txt; do [ -f "$f" ] || continue; printf changed > "$f"; exit $?; done; exit 4',
        "sh",
        dirs.root,
      ],
      { files: { "acceptance.txt": "acceptance.txt" } },
    );
    assert.equal(outcome.kind, "exited", outcome.output);
    assert.notEqual(outcome.kind === "exited" ? outcome.exitCode : 0, 0);
    assert.match(outcome.output, /Operation not permitted/);
  },
);

test(
  "an already-aborted check neither stages nor launches",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dirs = await setup(t);
    await writeFile(join(dirs.authoring, "acceptance.txt"), "body\n");

    const outcome = await dirs.run(["/bin/true"], {
      files: { "acceptance.txt": "acceptance.txt" },
      signal: AbortSignal.abort(),
    });
    assert.equal(outcome.kind, "failed", outcome.output);
    assert.match(outcome.kind === "failed" ? outcome.reason : "", /did not finish before the check deadline/);
    assert.deepEqual(await readdir(dirs.workspace), []);
  },
);
