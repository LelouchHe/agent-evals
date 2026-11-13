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
    mkdir(join(deps, ".local/bin"), { recursive: true }),
    mkdir(join(deps, ".local/share"), { recursive: true }),
    mkdir(runtime),
  ]);
  const executable = join(deps, ".local/bin/agent");
  await writeFile(executable, '#!/bin/sh\nexec /usr/bin/perl "$HOME/.local/share/agent.pl" "$@"\n');
  await chmod(executable, 0o755);
  await writeFile(
    join(deps, ".local/share/agent.pl"),
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
while (my $line = <STDIN>) {
  my $request = decode_json($line);
  push @methods, $request->{method};
  save(".auth/requests", encode_json(\\@methods));
  my $result;
  if ($request->{method} eq "initialize") {
    if ($scenario eq "security") {
      my $deps_write = open(my $d, ">>", "$home/.local/share/agent.pl") ? 1 : 0;
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
  } elsif ($request->{method} eq "session/prompt") {
    $result = {stopReason => "end_turn"};
  } else { die "unexpected method"; }
  print encode_json({jsonrpc => "2.0", id => $request->{id}, result => $result}), "\\n";
}
`,
  );
  const config = {
    command: ["agent", "login", scenario],
    acpCommand: ["agent", "acp", scenario],
    home: { deps, login, path: [".local/bin"] },
    login: [".auth/token"],
  };
  const path = join(root, "agent.yml");
  await writeFile(path, stringify(config));
  return { root, deps, login, runtime, path, config };
}
