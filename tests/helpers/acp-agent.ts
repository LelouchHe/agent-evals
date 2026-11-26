import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { stringify } from "yaml";
import { makeTempDir } from "./fake-pi-control.ts";

/** Model-free native/ACP peer using only the macOS system Perl runtime. */
export async function makeAcpAgent(t: TestContext, scenario = "success") {
  const root = await makeTempDir(t, "ae-acp-test-");
  const deps = join(root, "deps");
  const login = join(root, "login");
  const runtime = join(root, "runtime");
  await Promise.all([
    mkdir(join(deps, "bin"), { recursive: true }),
    mkdir(join(deps, "share"), { recursive: true }),
    mkdir(runtime),
  ]);
  if (process.platform === "win32") {
    const cmdShim = `@echo off\r\n"${process.execPath}" "%~dp0..\\share\\agent.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`;
    await writeFile(join(deps, "bin", "agent.cmd"), cmdShim, "ascii");
    await writeFile(join(deps, "share", "agent.mjs"), WINDOWS_AGENT_MJS, "utf8");
  } else {
    const executable = join(deps, "bin/agent");
    await writeFile(executable, '#!/bin/sh\nexec /usr/bin/perl "$(dirname "$0")/../share/agent.pl" "$@"\n');
    await chmod(executable, 0o755);
  }
  await writeFile(join(root, "agent-settings.json"), '{"model":"synthetic"}\n');
  if (process.platform !== "win32") {
    await writeFile(
      join(deps, "share/agent.pl"),
      `use strict;
use warnings;
use JSON::PP;
use File::Path qw(make_path);
use POSIX qw(mkfifo);
$| = 1;
my ($mode, $scenario, @data) = @ARGV;
my $home = $ENV{HOME};
make_path("$home/.auth");

sub save {
  my ($path, $value) = @_;
  open(my $f, ">", "$home/$path") or die $!;
  print $f $value; close($f);
}
sub save_log {
  my ($name, $value) = @_;
  open(my $f, ">", "$home/.auth/$name") or die $!;
  print $f $value; close($f);
}
if ($mode eq "login") {
  if ($scenario eq "mutate-failure" || $scenario eq "mutate-wait") {
    unlink("$home/.auth/token") or die $!;
    mkfifo("$home/.auth/token", 0600) or die $!;
    if ($scenario eq "mutate-failure") { exit 7; }
    print "login-ready\\n";
    sleep 600;
    exit 0;
  }
  if ($scenario eq "refresh-failure") { save(".auth/token", "refreshed-token"); exit 7; }
  print "login-ready\\n";
  if ($scenario eq "wait") { sleep 600; exit 0; }
  if ($scenario eq "failure") { exit 7; }
  if ($scenario eq "forgery") {
    print "0\\n";
    POSIX::write(3, "0\\n", 2);
    save("status", "0");
    exit 7;
  }
  if ($scenario eq "symlink") {
    symlink($data[0], "$home/.auth/token") or die $!;
  } elsif ($scenario eq "fifo") {
    mkfifo("$home/.auth/token", 0600) or die $!;
  } else {
    save(".auth/token", "synthetic-token");
  }
  save("cache", "must-not-persist");
  exit 0;
}
my @methods;
my $model = "model-a";
while (my $line = <STDIN>) {
  my $request = decode_json($line);
  push @methods, $request->{method};
  save_log("requests", encode_json(\\@methods));
  my $result;
  if ($request->{method} eq "initialize") {
    save_log("environment", ($ENV{AGENT_EVALS_TEST} // "") . "|$ENV{TMPDIR}");
    my $settings = "";
    if (-e "$home/settings.json") {
      open(my $f, "<", "$home/settings.json") or die $!;
      local $/; $settings = <$f>; close($f);
    }
    opendir(my $home_dir, $home) or die $!;
    my @home_entries = sort grep { $_ ne "." && $_ ne ".." } readdir($home_dir);
    closedir($home_dir);
    save_log("home", encode_json({settings => $settings, entries => [@home_entries]}));
    if ($scenario eq "security") {
      my $deps_write = open(my $d, ">>", "$home/../deps/share/agent.pl") ? 1 : 0;
      my $outside_read = open(my $o, "<", $data[0]) ? 1 : 0;
      save(".auth/security", encode_json({deps_write => $deps_write, outside_read => $outside_read}));
    }
    $result = { protocolVersion => 1, agentCapabilities => {}, authMethods => [{id => "interactive", name => "Interactive login"}] };
  } elsif ($request->{method} eq "session/new") {
    if ($scenario eq "auth") {
      print encode_json({jsonrpc => "2.0", id => $request->{id}, error => {code => -32000, message => "Authentication required"}}), "\\n";
      next;
    }
    $result = {
      sessionId => "session-test",
      configOptions => [
        {id => "model_id", category => "model", name => "Model", description => "Select a model", type => "select", currentValue => "model-a", options => [{value => "model-a", name => "Model A"}, {value => "model-b", name => "Model B"}]},
        {id => "custom", name => ($data[0] // "Custom") . ":" . ($data[1] // ""), type => "select", currentValue => "x", options => [{group => "g", name => "Grouped", options => [{value => "x", name => "Choice X"}]}]}
      ]
    };
  } elsif ($request->{method} eq "session/set_config_option") {
    $model = $request->{params}{value};
    $result = {configOptions => []};
  } elsif ($request->{method} eq "session/prompt") {
    open(my $f, ">", "answer.txt") or die $!;
    print $f "$model: $request->{params}{prompt}[0]{text}"; close($f);
    if ($scenario eq "hang") { sleep 600; }
    if ($scenario eq "mocks-refuse") {
      my $probe = q{
hostname >false-out 2>false-err; printf '%s' $? >false-status
/bin/hostname >abs-out 2>abs-err; printf '%s' $? >abs-status
./scripts/only.sh >script-out 2>&1; printf '%s' $? >script-status
};
      system("/bin/sh", "-c", $probe);
    }
    if ($scenario eq "mocks-actions") {
      my $probe = q{
uname -s >pass-out 2>pass-err
printf '%s' $? >pass-status
/usr/bin/uname -s >abs-pass-out 2>&1
whoami >who-out 2>&1
/usr/bin/whoami >abs-out 2>abs-err
printf '%s' $? >abs-status
./scripts/inspect.sh alpha >script-pass-out 2>&1
./scripts/publish.sh >script-return-out 2>&1
printf '%s' $? >script-return-status
};
      system("/bin/sh", "-c", $probe);
    }
    if ($scenario eq "sandbox") {
      my $deps_dir = "$home/../deps";
      my $engine_dir = "$home/../engine";
      my $canary = open(my $c, ">", "$deps_dir/CANARY") ? 1 : 0;
      close($c) if $canary;
      my $engine_read = open(my $e, "<", "$engine_dir/sandbox.sb") ? 1 : 0;
      close($e) if $engine_read;
      my $home_write = open(my $h, ">", "$home/probe-home.txt") ? 1 : 0;
      close($h) if $home_write;
      my $workspace_write = open(my $w, ">", "probe-workspace.txt") ? 1 : 0;
      close($w) if $workspace_write;
      my $tmp_write = open(my $t, ">", "$ENV{TMPDIR}/probe-tmp.txt") ? 1 : 0;
      close($t) if $tmp_write;
      my ($agent_bin) = grep { -x "$_/agent" } split(/:/, $ENV{PATH});
      save_log("sandbox", encode_json({
        path => $ENV{PATH}, home => $home, deps => $deps_dir, engine => $engine_dir,
        canary => $canary, engine_read => $engine_read, home_write => $home_write,
        workspace_write => $workspace_write, tmp_write => $tmp_write,
        agent_bin => ($agent_bin // "") . "/agent"}));
    }
    if ($scenario eq "mocks") {
      my $probe = q{
fwd=$(command -v id)
printf '%s' "$fwd" >where-id
root=$(dirname "$(dirname "$fwd")")
id 'arg with space' >call-out 2>call-err
printf '%s' $? >call-status
publish '' x >call-binary 2>call-binary-err
printf '%s' $? >call-binary-status
od -An -tx1 call-binary >call-binary-hex
ls "$root/engine" >/dev/null 2>&1; printf '%s' $? >probe-list
cat "$fwd" >/dev/null 2>&1; printf '%s' $? >probe-read
printf x >"$(dirname "$fwd")/added" 2>/dev/null; printf '%s' $? >probe-write
};
      system("/bin/sh", "-c", $probe);
    }
    if ($scenario =~ /^usage/) {
      my @usage_updates =
        $scenario eq "usage-cleared"
          ? ({used => 10, size => 100, cost => {amount => 0.01, currency => "USD"}}, {used => 20, size => 200, cost => undef})
          : $scenario eq "usage-malformed"
          ? ({used => 5, size => 50})
          : ({used => 10, size => 100, cost => {amount => 0.01, currency => "USD", _meta => {private => 1}}, _meta => {claude => "state"}}, {used => 20, size => 200});
      for my $u (@usage_updates) {
        print encode_json({jsonrpc => "2.0", method => "session/update", params => {sessionId => "session-test", update => {%$u, sessionUpdate => "usage_update"}}}), "\n";
      }
      if ($scenario eq "usage-timeout") { sleep 600; }
    }
    for my $update (
      {sessionUpdate => "agent_thought_chunk", content => {type => "text", text => "plan "}},
      {sessionUpdate => "agent_thought_chunk", content => {type => "text", text => "it"}},
      {sessionUpdate => "agent_message_chunk", content => {type => "text", text => "draft"}},
      {sessionUpdate => "tool_call", toolCallId => "call-1", title => "Terminal", kind => "execute", rawInput => {}},
      {sessionUpdate => "tool_call_update", toolCallId => "call-1", title => "echo hi", rawInput => {command => "echo hi"}, status => "in_progress"},
      {sessionUpdate => "tool_call_update", toolCallId => "call-1", content => [{type => "content", content => {type => "text", text => "h"}}]},
      {sessionUpdate => "tool_call_update", toolCallId => "call-1", status => "completed", title => undef, content => [{type => "content", content => {type => "text", text => "hi"}}]},
      {sessionUpdate => "agent_message_chunk", content => {type => "text", text => "wrote "}},
      {sessionUpdate => "agent_message_chunk", content => {type => "text", text => "answer"}},
    ) {
      print encode_json({jsonrpc => "2.0", method => "session/update", params => {sessionId => "session-test", update => $update}}), "\n";
    }
    $result = {stopReason => "end_turn"};
    if ($scenario eq "usage") {
      $result->{usage} = {totalTokens => 350, inputTokens => 300, outputTokens => 50, thoughtTokens => 5, cachedReadTokens => 200, cachedWriteTokens => 100, _meta => {ignored => 1}};
    }
    if ($scenario eq "usage-malformed") {
      $result->{usage} = {totalTokens => "lots"};
    }
  } else { die "unexpected method"; }
  print encode_json({jsonrpc => "2.0", id => $request->{id}, result => $result}), "\\n";
}
`,
    );
  }
  const config = {
    acpCommand: ["agent", "acp", scenario],
    deps,
    files: { "~/settings.json": "agent-settings.json" },
    login: {
      command: ["agent", "login", scenario],
      dir: login,
      files: [".auth/token", ".auth/requests", ".auth/environment", ".auth/home", ".auth/security", ".auth/sandbox"],
    },
    environment: { AGENT_EVALS_TEST: "${TMPDIR}/declared" },
  };
  const path = join(root, "agent.yml");
  await writeFile(path, stringify(config));
  return { root, deps, login, runtime, path, config };
}

const WINDOWS_AGENT_MJS = `import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

const [mode, scenario = "success", ...data] = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
mkdirSync(join(home, ".auth"), { recursive: true });

function save(rel, value) {
  writeFileSync(join(home, rel), value);
}
function saveLog(name, value) {
  writeFileSync(join(home, ".auth", name), value);
}

if (mode === "login") {
  if (scenario === "refresh-failure") {
    save(".auth/token", "refreshed-token");
    process.exit(7);
  }
  process.stdout.write("login-ready\\n");
  if (scenario === "wait") {
    setTimeout(() => process.exit(0), 600_000);
  } else if (scenario === "failure") {
    process.exit(7);
  } else if (scenario === "forgery") {
    process.stdout.write("0\\n");
    save("status", "0");
    process.exit(7);
  } else if (scenario === "symlink") {
    symlinkSync(data[0], join(home, ".auth", "token"));
    save("cache", "must-not-persist");
    process.exit(0);
  } else {
    save(".auth/token", "synthetic-token");
    save("cache", "must-not-persist");
    process.exit(0);
  }
} else {
  const methods = [];
  let model = "model-a";
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    methods.push(request.method);
    saveLog("requests", JSON.stringify(methods));
    let result;
    if (request.method === "initialize") {
      saveLog("environment", (process.env.AGENT_EVALS_TEST ?? "") + "|" + (process.env.TMPDIR ?? ""));
      const settingsPath = join(home, "settings.json");
      const settings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
      const entries = readdirSync(home).sort();
      saveLog("home", JSON.stringify({ settings, entries }));
      if (scenario === "security") {
        let depsWrite = 0;
        try {
          appendFileSync(join(home, "..", "deps", "share", "agent.mjs"), "");
          depsWrite = 1;
        } catch {}
        let outsideRead = 0;
        try {
          readFileSync(data[0], "utf8");
          outsideRead = 1;
        } catch {}
        save(".auth/security", JSON.stringify({ deps_write: depsWrite, outside_read: outsideRead }));
      }
      result = {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [{ id: "interactive", name: "Interactive login" }],
      };
    } else if (request.method === "session/new") {
      if (scenario === "auth") {
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required" } }) +
            "\\n",
        );
        continue;
      }
      result = {
        sessionId: "session-test",
        configOptions: [
          {
            id: "model_id",
            category: "model",
            name: "Model",
            description: "Select a model",
            type: "select",
            currentValue: "model-a",
            options: [
              { value: "model-a", name: "Model A" },
              { value: "model-b", name: "Model B" },
            ],
          },
          {
            id: "custom",
            name: (data[0] ?? "Custom") + ":" + (data[1] ?? ""),
            type: "select",
            currentValue: "x",
            options: [{ group: "g", name: "Grouped", options: [{ value: "x", name: "Choice X" }] }],
          },
        ],
      };
    } else if (request.method === "session/set_config_option") {
      model = request.params.value;
      result = { configOptions: [] };
    } else if (request.method === "session/prompt") {
      writeFileSync("answer.txt", model + ": " + request.params.prompt[0].text);
      if (scenario === "hang") {
        await new Promise((r) => setTimeout(r, 600_000));
      }
      if (scenario === "sandbox") {
        const depsDir = join(home, "..", "deps");
        const engineDir = join(home, "..", "engine");
        const tryWrite = (p) => {
          try {
            writeFileSync(p, "1");
            return 1;
          } catch {
            return 0;
          }
        };
        const tryRead = (p) => {
          try {
            readFileSync(p);
            return 1;
          } catch {
            return 0;
          }
        };
        const pathEntries = (process.env.PATH ?? "").split(delimiter);
        const agentDir = pathEntries.find((d) => existsSync(join(d, "agent.cmd"))) ?? "";
        saveLog(
          "sandbox",
          JSON.stringify({
            path: process.env.PATH ?? "",
            home,
            deps: depsDir,
            engine: engineDir,
            canary: tryWrite(join(depsDir, "CANARY")),
            engine_read: tryRead(join(engineDir, "sandbox.sb")),
            home_write: tryWrite(join(home, "probe-home.txt")),
            workspace_write: tryWrite("probe-workspace.txt"),
            tmp_write: tryWrite(join(process.env.TMPDIR || process.env.TEMP || "", "probe-tmp.txt")),
            agent_bin: join(agentDir, "agent.cmd"),
          }),
        );
      }
      if (scenario.startsWith("usage")) {
        const usageUpdates =
          scenario === "usage-cleared"
            ? [
                { used: 10, size: 100, cost: { amount: 0.01, currency: "USD" } },
                { used: 20, size: 200, cost: null },
              ]
            : scenario === "usage-malformed"
              ? [{ used: 5, size: 50 }]
              : [
                  {
                    used: 10,
                    size: 100,
                    cost: { amount: 0.01, currency: "USD", _meta: { private: 1 } },
                    _meta: { claude: "state" },
                  },
                  { used: 20, size: 200 },
                ];
        for (const u of usageUpdates) {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: "session-test", update: { ...u, sessionUpdate: "usage_update" } },
            }) + "\\n",
          );
        }
        if (scenario === "usage-timeout") {
          await new Promise((r) => setTimeout(r, 600_000));
        }
      }
      if (scenario === "mocks") {
        const r1 = spawnSync("cmd.exe", ["/d", "/c", 'id "arg with space"'], { encoding: "utf8", windowsHide: true });
        writeFileSync("call-out", r1.stdout ?? "");
        writeFileSync("call-err", r1.stderr ?? "");
        writeFileSync("call-status", String(r1.status ?? 1));
      }
      for (const update of [
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan " } },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "it" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "draft" } },
        { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Terminal", kind: "execute", rawInput: {} },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          title: "echo hi",
          rawInput: { command: "echo hi" },
          status: "in_progress",
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          content: [{ type: "content", content: { type: "text", text: "h" } }],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          title: null,
          content: [{ type: "content", content: { type: "text", text: "hi" } }],
        },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrote " } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
      ]) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "session-test", update },
          }) + "\\n",
        );
      }
      result = { stopReason: "end_turn" };
      if (scenario === "usage") {
        result.usage = {
          totalTokens: 350,
          inputTokens: 300,
          outputTokens: 50,
          thoughtTokens: 5,
          cachedReadTokens: 200,
          cachedWriteTokens: 100,
          _meta: { ignored: 1 },
        };
      }
      if (scenario === "usage-malformed") {
        result.usage = { totalTokens: "lots" };
      }
    } else {
      throw new Error("unexpected method: " + request.method);
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  }
}
`;
