# M3: Controlled Collaborators

Status: implemented. Mocks and interaction checks moved out of [M2](m2-plan.md) into this milestone so M2 closes cleanly on ACP execution and trace evidence. This milestone covers shell collaborators only; the call checker moved to [M4](m4-plan.md) and MCP collaborators are M5. Delivered: `return`, `run` and `pass` (including the conditional pass marker), ordered per-target rules with argument matching, unmatched-call denial, workspace-script targets, Seatbelt denial of the real binaries a `pass` rule cannot reach, infrastructure faults ending the run as `error`, and `mocks.json`. [Mocks](mocks.md) owns current usage; the decisions below are kept as the design record.

## Scope

Replace or observe shell collaborators at the environment boundary and record every call that reaches them outside the sandbox.

1. **Shell collaborators.** Intercept `PATH` programs and workspace scripts through thin forwarders, run mock actions or delegate to the real target, and retain structured interaction records.

Asserting on those records is [M4](m4-plan.md).

Not in scope: MCP collaborators, which are milestone M5, with their configuration, input matching and spy behavior still open (see [Open Questions](#open-questions)); harness-internal tools (`Read`, `Edit`, `WebFetch` and similar built-ins), shell builtins (`cd`, `export`), HTTP/network interception, model-provider fault injection, Linux.

## Decisions

- **Mocks live at the environment boundary, not in ACP.** ACP session updates are reports rather than interception hooks, and harness-native tool schemas vary across harnesses. Process questions over internal tools belong to a judge reading `trace.json`; deterministic call evidence comes from boundary mocks.
- **Behavior and interaction records stay outside the sandbox.** Inside the sandbox, a mock is only a thin forwarder to the engine host; mock handlers, static responses and call logs live outside everything the agent can read or write. Mocks are not assumed undetectable (`which`, reading the forwarder or a denied direct exec can still reveal substitution), so the goal is records the sandbox cannot read, alter or erase, plus hidden mock logic, rather than stealth. Any process in the sandbox can cause a record by making a call, either through a forwarder or by writing to its socket directly; it cannot read, change or remove one.
- **Arrange (`mocks`) and Assert (`checks`) are separate.** Top-level `mocks` owns runtime interception, actions and call recording (like gMock `ON_CALL`) and never produces pass/fail judgments; `checks` inspects recorded interactions after the run (like `EXPECT_CALL`). Shared `mocks` can be reused across named cases with different inputs or checks.
- **Stub, fake and spy are three actions of one mechanism.** Every call reaching a declared mock is recorded before its action runs:
  - `return`: fixed `exitCode`, `stdout` and `stderr` (stub).
  - `run`: invoke an author-supplied host program with the call's arguments and return its output and exit code (fake; trusted authoring code, like extensions).
  - `pass`: delegate to the real executable or script inside the sandbox so real execution never escapes Seatbelt (spy).
- **`run` returns a result, and passes only when the rule allows it.** The declared command is any program the host can start, in any language, found through the operator's own `PATH`. The host starts it with the call's arguments appended, without a shell, in the case file's directory and with empty stdin, and returns its stdout, stderr and exit code to the agent unchanged. Arguments come from the agent, so the program treats them as untrusted. A rule that sets `pass: true` beside `run` lets the program decide: when it exits `0` and its whole stdout is the single line `agent-evals:pass`, the call passes, nothing of the program's output reaches the agent and the real program runs in the sandbox. The same output from a rule without `pass` is a mock fault that ends the run as `error`, so the marker never reaches the agent and a missing `pass` is noticed. A crashed program cannot produce the marker by accident, and no exit code is reserved. Whether a target can ever run its real program therefore stays visible in the rules at load time, which is what Seatbelt denial and keeping a real script out of the sandbox depend on.
- **Ordered per-target rules, fail closed when unmatched.** A target takes one rule or an ordered list of rules; the first matching rule wins, and a rule without a condition acts as the fallback. When no rule matches, the call is still recorded and the real command does not run: the forwarder exits `126` with `<target>: Operation not permitted` on stderr, the shape of a Seatbelt-denied exec, without naming mocks.
- **A failing mock fails the run.** A forwarder that cannot reach the host, or a `run` program that cannot start, dies from a signal or exceeds the run deadline, is an infrastructure fault rather than agent behavior. The agent sees a failed command, and the run ends as `error` instead of checks judging an unreliable record. A `run` program's ordinary nonzero exit is a returned response.
- **Seatbelt denial follows `pass`.** Denial also covers what a shim resolves to: `/usr/bin/make` and `/usr/bin/git` are shims for binaries under the active developer directory. When no rule for a `PATH` target uses `pass`, Seatbelt denies executing the resolved real binary by absolute path; when `pass` is present, the real path stays executable so the forwarder can run it in-sandbox, which means `pass` can prove a command was called with given arguments through `PATH` but cannot prove absence against direct absolute-path execution.
- **Shell targets cover both `PATH` commands and workspace scripts.** Under `mocks.shell`, a bare name (such as `make` or `git`) places a forwarder in a per-run directory ahead of `home.path`; a workspace-relative path (such as `scripts/deploy.sh` or a skill script) places the forwarder at that workspace path while keeping any real script outside the agent's reach unless `pass` invokes it.
- **The engine owns mock behavior; the runner owns the wiring.** The engine parses `mocks`, runs the host service, matches rules, performs actions, keeps the records and generates forwarders, so that logic exists once. A runner receives an optional `mocks` value on `RunnerContext` (forwarder directory, socket path, targets whose real binaries to deny) and is responsible for `PATH` and sandbox policy. Forwarder generation stays in the engine until a second platform needs it elsewhere.
- **Runners without mock support fail at load time.** A runner definition declares `mocks: true` when it can wire them. Running a case that declares `mocks` on a runner without it (such as the native `pi` runner) is a `ConfigError` before any run directory exists, never a silent run against real commands.
- **A record holds the target and its arguments.** No output or exit code, since `pass` cannot observe one after `exec` and all three actions keep one record shape.
- **Engine stays assertion-agnostic; `judge` is unchanged.** The engine writes `mocks.json` beside `trace.json` and, once [M4](m4-plan.md) adds the call checker, exposes raw interaction records on `CheckerContext`. Checking lives in a replaceable `$type` checker; asserting on an unmocked target is a checker `error` rather than a vacuous pass. `judge` does not take `mockRecords` unless a real case later needs qualitative judgment over indirect script calls absent from `trace.json`.

### Shell argument matching

A rule's optional `args` decides whether the rule applies to a call. It compares whole argv tokens and knows nothing about a particular CLI's grammar.

- **Array for fixed positions, map for any position.** `args` is an array whose scalars match `argv[0]`, `argv[1]`, ... in order; positions not written accept anything, so the scalars are a prefix. The last element may be one map, matched without order against the arguments after that prefix. A bare map is the same as an array holding only that map.
- **Map entries are options.** A key names a token. `true` requires it, `false` forbids it, and a string requires it with that value, given either as the next token (`--repo foo/bar`) or after `=` (`--repo=foo/bar`).
- **Literal by default, `/…/` for a regex.** A scalar, key or string value is compared for equality unless the whole string starts and ends with `/`; then it is a regular expression anchored to the whole token, so `/-f|--force/` does not match `--force-with-lease`. No flags. A literal that itself starts and ends with `/`, such as `/tmp/`, must be written as a regex.
- **Scalars are strings.** A YAML number is compared as its text, so `-n: 5` matches `-n 5`. A literal value `true` or `false` must be quoted, since the unquoted booleans mean required and forbidden.
- **No `and` / `or` / `not` operators.** Entries written together must all hold; alternatives are a regex alternation or another rule with the same action; exclusion is `false` or an earlier rule that takes the exception.
- **Options before the subcommand break the prefix.** `gh --repo foo/bar pr create` does not match `[pr, create]`, and no generic rule can tell an option's value from a positional. The author falls back to a bare map (`{ pr: true, create: true }`), which gives up the order between those tokens.
- **Regexes run on a linear-time engine.** Argv is agent-controlled and matching runs on the host during the run, so a pattern must not be able to backtrack catastrophically. Patterns compile with `re2js` (RE2 syntax: no lookaround or backreferences), and an unsupported pattern is a `ConfigError` at load time. The `file` checker's `matches` uses the same engine, which removes its worker and timeout and leaves one dialect; the adopted checker now answers a catastrophic `(a+)+$` in linear time instead of timing out.

Not expressible yet, added only for a real case: repeated options (`-e A=1 -e B=2`), exact argument lists (a bare `make`), combined short options (`-rf`) and regex flags.

Rejected: regex over the joined argument string (no token boundaries, so `--draft` matches inside another option's value); a second `has`-style field or container keywords; anchored glob arrays needing `["**", "--flag", "**"]` and boolean operators for unordered options; `$`-operator trees; unordered or order-only arrays, since an array reads as positional; every pattern as a regex, since values such as URLs and globs then fail to match without an error.

### Shell forwarding

Interception relies on command lookup and on nothing else: no hook, injected library or system-call tracing.

- **A forwarder ahead on `PATH`.** For each declared `PATH` target the per-run forwarder directory holds an executable of that name, and the runner puts that directory first on `PATH` and keeps it read-only to the agent. Undeclared commands resolve as usual, unrecorded. Calls made from scripts are caught because children inherit `PATH`; absolute-path calls, shell builtins and harness-internal tools are not.
- **The forwarder only asks the host.** It is a short `/bin/sh` script using `/usr/bin/nc -U`, `/usr/bin/base64` and `/usr/bin/tr`, so it needs nothing in `deps`. It sends its canonical path and each argument, base64-encoded one per line, over a per-run Unix socket. The host derives the target from the path, records the call, matches the rules and replies.
- **`return` and `run` reply with a result.** The reply carries the exit code and base64 stdout and stderr; the forwarder writes them out and exits with that code. Output arrives at once, not streamed, and the order between stdout and stderr is lost.
- **`pass` replies with one word.** The forwarder finds the next executable of that name on `PATH`, skipping its own directory, and `exec`s it. The real program replaces the forwarder process inside the sandbox, so stdin, output, signals and the exit code are its own, and the host never runs it.
- **One forwarder.** The script is written once per run; `PATH` targets are hard links to it in the forwarder directory. A workspace-script target is a separate copy of the same content at that workspace path, because a hard link shared with the writable workspace would let the agent rewrite every forwarder. It is placed before the baseline snapshot, so `file` `unchanged` compares forwarder with forwarder.
- **A passed workspace script stays beside its forwarder.** When a rule for a workspace-script target uses `pass`, the real script keeps its content and directory and takes the same name with a leading dot (`scripts/deploy.sh` becomes `scripts/.deploy.sh`), so lookups through `dirname "$0"` or `BASH_SOURCE` still work; only its base name differs. The agent can read and change it, as it could before mocking. An existing file of that name is a `ConfigError`. Without `pass` the real script never enters the sandbox.
- **Standard input is not forwarded.** `return` and `run` do not read it, so a mock downstream of a pipe answers without seeing the piped data, and the record does not hold it; `pass` inherits it through `exec`. A per-target opt-in can add it when a case needs the piped content.
- **Workspace-script targets must be executed.** A script that is sourced has the calling shell as `$0`, so the forwarder cannot identify itself and its `exit` would end the caller.
- **Not hidden, not advertised.** `which` and `cat` reveal the forwarder and the socket path, never the rules, responses or records. Names, paths and script text avoid words such as mock or eval, and probing leaves commands in `trace.json`, so a run in which the agent noticed can be told apart afterwards. A hidden replacement is not possible on macOS without a virtual machine.

### Agreed outer shape

The agreed shape, implemented as written ([current usage](mocks.md)):

```yaml
mocks:
  shell:
    make:
      return:
        exitCode: 1
        stderr: "deploy commands are disabled\n"
    scripts/deploy.sh:
      run: [sh, ./mocks/fake-deploy.sh]
    npm:
      pass: true
    git:
      - args: [push, { /-f|--force/: true }]
        return:
          exitCode: 1
          stderr: "force push is disabled\n"
      - args: [push]
        return:
          exitCode: 0
          stdout: "Everything up-to-date\n"
      - pass: true
    gh:
      - args: [pr, create, { /-R|--repo/: foo/bar, --web: false }]
        return:
          exitCode: 0
          stdout: "https://example.test/foo/bar/pull/1\n"
```

## Delivered

[Mocks](mocks.md) owns the supported subset, matching grammar, actions, `mocks.json` and limitations; this section records how the delivered pieces fit and what was verified.

- **Engine and runner.** The engine parses `mocks`, compiles the rules, writes the forwarders, runs the host service, matches calls, performs actions, keeps the records and reports faults. The `acp` runner declares `mocks: true`, puts the forwarder directory first on `PATH`, keeps it readable and non-writable, and denies the real binaries of `PATH` targets no rule can pass. The native `pi` runner does not declare mocks, so a case with `mocks` there is a `ConfigError` before any run directory exists.
- **Lifecycle.** The host starts before the runner (and before the workspace baseline, so workspace forwarders are part of it) and closes after `Runner.stop` resolves, so a call from a process that outlives the turn is still answered and recorded. Run programs are killed with their descendants on timeout, cancellation and teardown.
- **Socket and fault channels.** The per-run socket lives directly in the temporary directory as `run-<id>.sock`, not beside the run directories: a Unix socket path is limited to about 104 bytes and the run root's own path plus the socket name can exceed it. A forwarder that cannot reach the host writes its target to a run-scratch marker the engine reads at close, which turns a lost call into a run `error`.
- **Delivered, not planned.** All three actions, ordered rules, the argument grammar, workspace scripts, unmatched-call denial and Seatbelt denial run end to end; the example in [`deploy-runbook`](../examples/cases/deploy-runbook/case.yml) exercises `return`, `run` and `pass` in one case.

## Verified Constraints

From the M2 spikes on Pi 1.5.2 (`pi-acp` fork 0.0.34) and Claude Code 2.1.318 (`claude-agent-acp` 0.101.0) under macOS Seatbelt:

- **Command shim and Seatbelt deny:** a `PATH` shim for `make` ahead of `home.path` recorded both direct shell calls and calls made from inside a script in both harnesses; direct execution of `/usr/bin/make` by absolute path was denied by Seatbelt with exit code `126`. Needs nothing in `deps`.
- **MCP injection:** an MCP mock server injected through `session/new` was called through the harness tool in both harnesses; tool names surfaced as `mcp__<server>__<tool>` in both. Pi through `pi-acp` needed `_meta.directTools: true` on the injected server entry, and any `--tools` allowlist had to include `mcp__<server>__*`.
- **Forwarder transport:** in a standalone Seatbelt test, a `/bin/sh` forwarder using `nc -U` and `base64` returned separate stdout, stderr and exit code from a host process, and an argument containing a space reached the host intact. Allowing only the socket path with `(allow network-outbound (literal ...))` was enough; without a network rule the call failed. The sandbox could neither read the host's record nor write into the forwarder directory.
- **Step 1 in the real runner (2026-11-14):** the same transport now runs inside the `acp` runner's own environment and generated policy: a delegated shell call to a mocked `PATH` command received the declared stdout, stderr and exit code; both calls reached the host as target plus arguments outside the sandbox; an argument containing a space arrived intact, and so did an empty argument; output containing a NUL and a non-ASCII character arrived byte for byte; the command's real binary did not run. The sandbox could neither list the run root nor write to the forwarder, but could read the forwarder itself. Under this project's policy the reply works with the existing `(allow network-outbound)` rule, not a socket-literal rule.
- **Step 2 (2026-11-15):** the completed actions were verified in the model-free ACP peer and one real Pi run: `pass` executed the real command in-sandbox, a `PATH` target without `pass` had its absolute binary denied with 126, workspace scripts ran through their forwarders (with the real script reachable only through `pass`), and `mocks.json` recorded each call. A `run` program that could not start, a marker used without `pass`, and a program that overran its deadline each ended the run as `error` and killed the program's descendants. `file` and mock patterns were migrated to `re2js`; the former worker timeout test now shows a catastrophic `(a+)+$` answered in linear time.
- **Still unverified:** standard-input forwarding (deliberately not implemented), exact-argument matching and repeated/combined option forms (deferred), M5's MCP input matching, and Windows/Linux.
- **Observed agent probing:** during spikes, an unprompted agent listed its run directory, read mock logs and source, recognized the mocks and ran a mock server by hand, producing a false call record when logs lived inside the sandbox.

## Open Questions

- **MCP collaborators (M5).** Exact `mocks.mcp` syntax, how a rule matches a tool's JSON object input (shell `args` does not have to cover it), server naming and harness-specific `_meta` (such as Pi's `_meta.directTools: true`), whether MCP supports `pass` to a real server, and HTTP service mocks / model-provider fault injection (which depend on the deferred proxy).
