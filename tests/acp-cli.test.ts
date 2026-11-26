import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { makeAcpAgent } from "./helpers/acp-agent.ts";
import { runCliProcess } from "./helpers/cli-process.ts";
import { isSandboxPlatformSupported } from "../src/platform/index.ts";

const cli = join(import.meta.dirname, "../src/cli.ts");

test(
  "config queries actual ACP values without prompting and copies back only original login files",
  { skip: !isSandboxPlatformSupported },
  async (t) => {
    const fixture = await makeAcpAgent(t);
    await mkdir(join(fixture.login, ".auth"), { recursive: true });
    await writeFile(join(fixture.login, ".auth/requests"), "[]");
    const result = await runCliProcess(t, cli, ["config", fixture.path], {
      cwd: fixture.root,
      env: { ...process.env, TMPDIR: fixture.runtime },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /model_id/);
    assert.match(result.stdout, /model-a/);
    assert.match(result.stdout, /Model B/);
    assert.match(result.stdout, /Choice X/);
    assert.match(result.stdout, /interactive/);
    assert.deepEqual(JSON.parse(await readFile(join(fixture.login, ".auth/requests"), "utf8")), [
      "initialize",
      "session/new",
    ]);
    assert.deepEqual(await readdir(fixture.runtime), []);
  },
);

test(
  "login exports declared files from a first login, not arbitrary new HOME state",
  { skip: !isSandboxPlatformSupported },
  async (t) => {
    const fixture = await makeAcpAgent(t);
    const result = await runCliProcess(t, cli, ["login", fixture.path], {
      cwd: fixture.root,
      env: { ...process.env, TMPDIR: fixture.runtime },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(fixture.login, ".auth/token"), "utf8"), "synthetic-token");
    assert.deepEqual(await readdir(fixture.login), [".auth"]);
    assert.deepEqual(await readdir(join(fixture.login, ".auth")), ["token"]);
    assert.deepEqual(await readdir(fixture.runtime), []);
    assert.doesNotMatch(result.stdout, /synthetic-token/);
  },
);

test(
  "invalid configured directories are configuration errors before launching",
  { skip: !isSandboxPlatformSupported },
  async (t) => {
    const fixture = await makeAcpAgent(t);
    for (const [change, field] of [
      [{ deps: join(fixture.root, "missing-deps") }, "deps"],
      [{ deps: fixture.path }, "deps"],
      [{ login: { ...fixture.config.login, dir: fixture.path } }, "login.dir"],
      [{ login: { ...fixture.config.login, dir: join(fixture.path, "child") } }, "login.dir"],
    ] as const) {
      await writeFile(fixture.path, stringify({ ...fixture.config, ...change }));
      const result = await runCliProcess(t, cli, ["config", fixture.path], {
        cwd: fixture.root,
        env: { ...process.env, TMPDIR: fixture.runtime },
      });
      assert.equal(result.code, 2);
      assert.ok(result.stderr.startsWith("configuration error: " + field), result.stderr);
      assert.match(result.stderr, /directory/);
      assert.deepEqual(await readdir(fixture.runtime), []);
    }
  },
);

test(
  "re-login failure remains visible when copy-back rejects mutated original credentials",
  { skip: !isSandboxPlatformSupported },
  async (t) => {
    const fixture = await makeAcpAgent(t, "mutate-failure");
    await mkdir(join(fixture.login, ".auth"), { recursive: true });
    await writeFile(join(fixture.login, ".auth/token"), "original-token");
    const result = await runCliProcess(t, cli, ["login", fixture.path], {
      cwd: fixture.root,
      env: { ...process.env, TMPDIR: fixture.runtime },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /login command exited with code 7/);
    assert.match(result.stderr, /cleanup failed.*regular file/);
    assert.equal(await readFile(join(fixture.login, ".auth/token"), "utf8"), "original-token");
    assert.deepEqual(await readdir(fixture.runtime), []);
  },
);

test(
  "failed re-login still preserves a refreshed original credential",
  { skip: !isSandboxPlatformSupported },
  async (t) => {
    const fixture = await makeAcpAgent(t, "refresh-failure");
    await mkdir(join(fixture.login, ".auth"), { recursive: true });
    await writeFile(join(fixture.login, ".auth/token"), "original-token");
    const result = await runCliProcess(t, cli, ["login", fixture.path], {
      cwd: fixture.root,
      env: { ...process.env, TMPDIR: fixture.runtime },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /login command exited with code 7/);
    assert.equal(await readFile(join(fixture.login, ".auth/token"), "utf8"), "refreshed-token");
    assert.deepEqual(await readdir(fixture.runtime), []);
  },
);

for (const scenario of ["failure", "forgery", "symlink", "fifo"]) {
  test(`login rejects ${scenario} without saving credentials`, { skip: !isSandboxPlatformSupported }, async (t) => {
    const fixture = await makeAcpAgent(t, scenario);
    const outside = join(fixture.root, "outside-token");
    await writeFile(outside, "outside-secret");
    await writeFile(
      fixture.path,
      stringify({
        ...fixture.config,
        login: { ...fixture.config.login, command: [...fixture.config.login.command, outside] },
      }),
    );
    const result = await runCliProcess(t, cli, ["login", fixture.path], {
      cwd: fixture.root,
      env: { ...process.env, TMPDIR: fixture.runtime },
    });
    assert.equal(result.code, 2, result.stdout);
    assert.match(
      result.stderr,
      scenario === "failure" || scenario === "forgery" ? /exited with code 7/ : /outside|regular file/,
    );
    await assert.rejects(readdir(fixture.login), { code: "ENOENT" });
    assert.equal(await readFile(outside, "utf8"), "outside-secret");
    assert.deepEqual(await readdir(fixture.runtime), []);
  });
}

test(
  "config denies deps writes and operator file reads while retaining refreshed login state",
  { skip: !isSandboxPlatformSupported },
  async (t) => {
    const fixture = await makeAcpAgent(t, "security");
    const outside = join(fixture.root, "operator-file");
    await writeFile(outside, "operator-secret");
    await mkdir(join(fixture.login, ".auth"), { recursive: true });
    await writeFile(join(fixture.login, ".auth/security"), "{}");
    await writeFile(
      fixture.path,
      stringify({ ...fixture.config, acpCommand: [...fixture.config.acpCommand, outside] }),
    );
    const result = await runCliProcess(t, cli, ["config", fixture.path], {
      cwd: fixture.root,
      env: { ...process.env, TMPDIR: fixture.runtime },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(fixture.login, ".auth/security"), "utf8")), {
      deps_write: 0,
      outside_read: 0,
    });
    assert.equal(await readFile(outside, "utf8"), "operator-secret");
    assert.deepEqual(await readdir(join(fixture.login, ".auth")), ["security"]);
  },
);

test(
  "config reports ACP authentication requirements without a prompt",
  { skip: !isSandboxPlatformSupported },
  async (t) => {
    const fixture = await makeAcpAgent(t, "auth");
    const result = await runCliProcess(t, cli, ["config", fixture.path], {
      cwd: fixture.root,
      env: { ...process.env, TMPDIR: fixture.runtime },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /authentication required; run login/i);
    assert.deepEqual(await readdir(fixture.runtime), []);
  },
);

test(
  "agent YAML shares invocation .env expansion, quoted literals, caching and declaring-file paths",
  { skip: !isSandboxPlatformSupported },
  async (t) => {
    const fixture = await makeAcpAgent(t);
    const definitions = join(fixture.root, "definitions");
    await mkdir(definitions);
    await writeFile(join(definitions, "agent-settings.json"), '{"model":"synthetic"}\n');
    const path = join(definitions, "agent.yml");
    await writeFile(join(fixture.root, ".env"), 'SELECT="!printf x >> count; printf success"\n');
    await writeFile(
      path,
      stringify({
        ...fixture.config,
        deps: "../deps",
        login: { ...fixture.config.login, dir: "../login" },
        acpCommand: undefined,
      }) + "acpCommand:\n  - agent\n  - acp\n  - ${env:SELECT}\n  - ${env:SELECT}\n  - $${env:MISSING}\n",
    );
    const result = await runCliProcess(t, cli, ["config", path], {
      cwd: fixture.root,
      env: { ...process.env, TMPDIR: fixture.runtime },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /success:\${env:MISSING}/);
    assert.equal(await readFile(join(fixture.root, "count"), "utf8"), "x");
  },
);

test("helpers reject invalid schemas, YAML reuse and run-only flags before launching", async (t) => {
  const fixture = await makeAcpAgent(t);
  for (const [source, error] of [
    [stringify({ ...fixture.config, acpCommand: [] }), /acpCommand/],
    [stringify({ ...fixture.config, login: ["../escape"] }), /login/],
    [stringify({ ...fixture.config, unknown: true }), /unknown/],
    [stringify({ ...fixture.config, env: { EXTRA: "unsupported" } }), /Unrecognized key.*env/],
    [stringify({ ...fixture.config, environment: { PATH: "/elsewhere" } }), /environment\.PATH.*set by ACP setup/],
    [
      "__proto__:\n" +
        stringify(fixture.config)
          .split("\n")
          .map((line) => "  " + line)
          .join("\n"),
      /Unrecognized key.*__proto__/,
    ],
    ["acpCommand: &cmd [agent]\ncommand: *cmd\n", /anchors|aliases/],
    ["acpCommand: !include foo\n", /unsupported YAML/],
    ["acpCommand: [agent]\nacpCommand: [other]\n", /invalid YAML/],
    ["acpCommand: [agent]\nhome: ${env:MISSING}\n", /not defined/],
  ] as const) {
    await writeFile(join(fixture.root, ".env"), "OTHER=value\n");
    await writeFile(fixture.path, source);
    const result = await runCliProcess(t, cli, ["config", fixture.path], {
      cwd: fixture.root,
      env: { ...process.env, MISSING: "ambient-must-not-be-used", TMPDIR: fixture.runtime },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, error);
    assert.deepEqual(await readdir(fixture.runtime), []);
  }
  for (const command of ["config", "login"]) {
    const result = await runCliProcess(t, cli, [command, fixture.path, "--case", "ignored"], { cwd: fixture.root });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /accepts only an agent configuration/);
  }
});

test(
  "helpers reject overlapping software/login roots and a run directory inside deps",
  { skip: !isSandboxPlatformSupported },
  async (t) => {
    const fixture = await makeAcpAgent(t);
    for (const [change, message] of [
      [{ login: { ...fixture.config.login, dir: fixture.deps } }, /non-overlapping/],
      [{ deps: fixture.root }, /non-overlapping/],
      [{ deps: fixture.runtime }, /must not contain the temporary/],
    ] as const) {
      await writeFile(fixture.path, stringify({ ...fixture.config, ...change }));
      const result = await runCliProcess(t, cli, ["config", fixture.path], {
        cwd: fixture.root,
        env: { ...process.env, TMPDIR: fixture.runtime },
      });
      assert.equal(result.code, 2);
      assert.match(result.stderr, message);
      assert.deepEqual(await readdir(fixture.runtime), []);
    }
  },
);

for (const scenario of ["wait", "mutate-wait"]) {
  test(
    scenario === "wait"
      ? "login cancellation stops the workload without exporting files"
      : "re-login cancellation remains visible when original credentials become unsafe",
    { skip: !isSandboxPlatformSupported, timeout: 15000 },
    async (t) => {
      const fixture = await makeAcpAgent(t, scenario);
      if (scenario === "mutate-wait") {
        await mkdir(join(fixture.login, ".auth"), { recursive: true });
        await writeFile(join(fixture.login, ".auth/token"), "original-token");
      }
      const child = spawn(process.execPath, [cli, "login", fixture.path], {
        cwd: fixture.root,
        env: { ...process.env, TMPDIR: fixture.runtime },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let exited = false;
      const force = () => {
        if (!exited && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already gone. */
          }
        }
      };
      t.after(force);
      const timer = setTimeout(force, 8000);
      t.after(() => clearTimeout(timer));
      let output = "";
      let stderr = "";
      let cancelled = false;
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (!cancelled && output.includes("login-ready")) {
          cancelled = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const [code] = await once(child, "close");
      exited = true;
      clearTimeout(timer);
      assert.ok(cancelled, output);
      assert.equal(code, 2, stderr);
      assert.match(stderr, /cancelled/);
      if (scenario === "wait") await assert.rejects(readdir(fixture.login), { code: "ENOENT" });
      else {
        assert.match(stderr, /cleanup failed.*regular file/);
        assert.equal(await readFile(join(fixture.login, ".auth/token"), "utf8"), "original-token");
      }
      assert.deepEqual(await readdir(fixture.runtime), []);
    },
  );
}

test(
  "login receives a real terminal and forwards interactive input",
  { skip: process.platform !== "darwin", timeout: 15000 },
  async (t) => {
    const fixture = await makeAcpAgent(t);
    await copyFile(process.execPath, join(fixture.deps, "bin/node"), constants.COPYFILE_FICLONE);
    await writeFile(
      fixture.path,
      stringify({
        ...fixture.config,
        login: {
          ...fixture.config.login,
          command: [
            "node",
            "-e",
            `
const fs = require("node:fs");
process.stdin.setRawMode(true);
// Darwin sys/ttycom.h: TIOCSWINSZ = _IOW('t', 103, struct winsize),
// TIOCSETA = _IOW('t', 20, struct termios). Test both filter dimensions.
for (const probe of [
  'my $arg = pack("S4", 24, 80, 0, 0); $! = 0; my $result = ioctl(STDIN, 0x80087467, $arg); die "window resize unexpectedly allowed or wrong denial: $!" if defined($result) || !$!{EPERM};',
  'open(my $f, "+<", "/dev/null") or die $!; my $arg = chr(0) x 72; $! = 0; my $result = ioctl($f, 0x80487414, $arg); die "unrelated device unexpectedly allowed or wrong denial: $!" if defined($result) || !$!{EPERM};',
]) {
  const result = require("node:child_process").spawnSync("/usr/bin/perl", ["-e", probe], { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
console.log("ioctl boundaries verified");
console.log("login-ready");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  if (!input.includes("confirm")) return;
  process.stdin.setRawMode(false);
  fs.mkdirSync(process.env.HOME + "/.auth", { recursive: true });
  fs.writeFileSync(process.env.HOME + "/.auth/token", "synthetic-token");
  process.exit(0);
});
`,
          ],
        },
      }),
    );
    const driver = join(fixture.root, "login.exp");
    await writeFile(
      driver,
      `set timeout 6
spawn {*}$argv
expect {
  "login-ready" { send -- "confirm\\r" }
  timeout { exec /bin/kill -TERM -- [exp_pid]; expect eof; exit 124 }
  eof { exit 125 }
}
expect {
  eof {}
  timeout { exec /bin/kill -TERM -- [exp_pid]; expect eof; exit 124 }
}
catch wait result
exit [lindex $result 3]
`,
    );
    const child = spawn("/usr/bin/expect", [driver, process.execPath, cli, "login", fixture.path], {
      cwd: fixture.root,
      env: { ...process.env, TMPDIR: fixture.runtime },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let exited = false;
    const stop = () => {
      if (!exited && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* Already gone. */
        }
      }
    };
    t.after(stop);
    const timer = setTimeout(stop, 8000);
    t.after(() => clearTimeout(timer));
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const [code] = await once(child, "close");
    exited = true;
    clearTimeout(timer);
    child.stdin.destroy();
    assert.equal(code, 0, output);
    assert.match(output, /login-ready/);
    assert.match(output, /ioctl boundaries verified/);
    assert.equal(await readFile(join(fixture.login, ".auth/token"), "utf8"), "synthetic-token");
    assert.deepEqual(await readdir(fixture.runtime), []);
  },
);
