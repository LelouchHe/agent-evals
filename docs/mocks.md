# Mocks

A mock is a case-owned substitute for a collaborator at the environment boundary: a case declares it, the run arranges it, and every call that reaches it is recorded. This page owns mock usage — what mocks do, how they relate to checks and the trace, the supported configuration, matching, the three actions, a complete case, `mocks.json`, and current limitations. [M3](m3-plan.md) owns the design decisions; [Configuration Reference](configuration.md) owns the rest of the case format. Asserting on recorded calls is [M4](m4-plan.md); MCP collaborators are M5.

Implemented: shell collaborators — bare `PATH` commands and workspace scripts — with `return`, `run` and `pass`, argument matching and Seatbelt denial, wired by the `acp` runner on macOS.

## What a Mock Does

For each declared target the engine writes a thin forwarder into the run. A bare command name gets a forwarder in a per-run directory that the runner puts first on `PATH`; a workspace-relative path gets a forwarder at that path. The forwarder reports the call over a per-run socket and prints the reply, which may itself be a decision to run the real command inside the sandbox.

- The forwarder is the only mock code inside the sandbox. Matching, actions, real programs and call records stay on the host.
- Calls are intercepted at command lookup, so a call from a script is caught too, because children inherit `PATH`. Undeclared commands resolve as usual and are not recorded.
- Commands run by path instead of through `PATH` (for example `/usr/bin/make`) are not intercepted; for a mocked `PATH` target without any `pass` rule the real binary is _denied_ in the sandbox, so the bypass fails instead of running.
- Shell builtins, harness-internal tools and a script executed by path are outside this boundary.
- Nothing hides the substitution: `which` and reading the forwarder reveal it, never the declared rules, results or records. Any process in the sandbox can cause a record by calling a mocked command, or by writing to the forwarder's socket directly; it cannot read, change or remove one.

## Mocks, Checks and the Trace

`mocks` and `checks` are separate. `mocks` arranges the run, answers calls and records them; it never produces a pass or fail. `checks` inspect evidence afterwards, and today they cannot inspect mock records.

- [`mocks.json`](#mocksjson) is the evidence a mock produces: what actually reached the mock boundary, in arrival order.
- [`trace.json`](configuration.md#inspecting-and-recording) is what the harness reported: messages, reasoning and requested tool calls. A requested call in the trace does not prove its effect, and the trace may omit calls a script made; a recorded mock call is the boundary evidence for those.
- No call checker exists yet. Asserting on recorded calls is planned in [M4](m4-plan.md); until then `mocks.json` is retained evidence to read, and `judge` does not take it.

Use a mock to control what a collaborator answers, to supply a fake implementation, and to keep real effects from happening; use a check on the workspace, the trace or a judge for the outcome that matters.

## Targets

`mocks.shell` is a mapping from a target to one rule or an ordered list of rules.

| Target              | Placement                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make`, `git`, …    | A bare command name. The forwarder goes into the run's forwarder directory, first on `PATH`. When no rule of that target can `pass`, the resolved real binary is denied by absolute path. |
| `scripts/deploy.sh` | A workspace-relative path containing `/`. The forwarder replaces that workspace file before the baseline snapshot is taken.                                                               |

A workspace-script target's real script leaves the agent's reach unless a rule can `pass`:

- With no `pass` rule the real file is moved out of the workspace, so only the forwarder is runnable.
- When any rule can `pass`, the real script stays beside its forwarder under the same name with a leading dot (`scripts/deploy.sh` becomes `scripts/.deploy.sh`), so `dirname "$0"` and `BASH_SOURCE`-style lookups keep working. An existing file of that name is a configuration error; a `pass` rule without a real script is one too.
- The forwarder is written before the baseline snapshot, so `file` `unchanged` compares forwarder with forwarder.

Workspace scripts are executed, not sourced: a sourced script would see the calling shell as `$0`, so the forwarder could not identify itself.

## Actions

A rule declares exactly one of three actions. Every call is recorded before its action runs.

| Action   | Behavior                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `return` | A fixed result: `exitCode` (0–255, default `0`), `stdout` and `stderr` (default empty strings), written byte for byte.                                                                                                                                                                                  |
| `run`    | An author-supplied host program, started without a shell in the case file's directory with the call's arguments appended and empty standard input, returning its stdout, stderr and exit status unchanged. Its arguments are agent-controlled, so it treats them as untrusted.                          |
| `pass`   | The real command runs inside the sandbox: the forwarder finds the next executable of that name on `PATH`, skipping its own entry, and `exec`s it; a workspace script `exec`s its dot-named sibling. Standard input, output, signals and the exit status are the real program's. The host never runs it. |

`run` can decide between a result and a pass by setting `pass: true` beside it. When the program exits `0` and its whole stdout is the single line `agent-evals:pass`, the call passes, nothing of the program's output reaches the agent and the real command runs in the sandbox; any other output is returned as the result. The marker is reserved: the same output from a rule without `pass`, with a nonzero exit or with anything else on stdout is a mock fault, so it can never reach the agent and a missing `pass` is noticed. A crashed program cannot print it by accident.

A forwarder's command line is never interpreted by a shell and never interpolated into one.

## Matching

A rule's optional `args` decides whether it applies to a call. It compares whole argv tokens and knows nothing about a particular CLI's grammar.

```yaml
git:
  - args: [push, { /-f|--force/: true }]
    return: { exitCode: 1, stderr: "force push is disabled\n" }
  - args: [push]
    return: { exitCode: 0, stdout: "Everything up-to-date\n" }
  - pass: true
gh:
  - args: { pr: true, create: true, /-R|--repo/: foo/bar, --web: false }
    return: { stdout: "https://example.test/foo/bar/pull/1\n" }
npm:
  - args: [{ --registry: https://r.example }]
    return: { stdout: "published\n" }
```

- **Array for fixed positions, map for any position.** An array's scalars match `argv[0]`, `argv[1]`, … in order; positions not written accept anything, so the scalars are a prefix. The last element may be one map, matched without order against the arguments after that prefix. A bare map is an array holding only that map.
- **Map entries are options.** A key names a token: `true` requires it, `false` forbids it, and a string requires it with that value, given either as the next token (`--repo foo/bar`) or after `=` (`--repo=foo/bar`).
- **Literal by default, `/…/` for a regex.** A scalar, key or value is compared for equality unless the whole string starts and ends with `/`; then it is a regular expression matched against the whole token, so `/-f|--force/` matches `--force` but not `--force-with-lease`. No flags. A literal that itself starts and ends with `/`, such as `/tmp/`, must be written as a regex.
- **Scalars are strings.** A YAML number is compared as its text, so `-n: 5` matches `-n 5`. A literal `true` or `false` must be quoted, since unquoted booleans mean required and forbidden.
- **No `and`/`or`/`not` operators.** Entries written together must all hold; alternatives are a regex alternation or another rule, exclusion is `false` or an earlier rule.
- **Options before the subcommand break the prefix.** `gh --repo foo/bar pr create` does not match `[pr, create]`; use a bare map, which gives up the order between those tokens.
- **Ordered per target.** The first matching rule wins; a rule without `args` is the fallback. When no rule matches, the call is still recorded, the real command does not run, and the forwarder exits `126` with `<target>: Operation not permitted` on stderr — the shape of a Seatbelt denial, without naming mocks.

Not expressible yet: repeated options (`-e A=1 -e B=2`), exact argument lists (a bare `make`), combined short options (`-rf`) and regex flags.

## Regexes

Every pattern in a case is RE2: mock `args` patterns here, and the [`file` checker's](configuration.md#file-checker-type-file) `matches`. RE2 has no lookaround or backreferences, and such a pattern is a configuration error at load time; every accepted pattern runs in linear time, so matching cannot be driven into catastrophic backtracking by agent-controlled input. One dialect covers both places; the `file` checker searches within the file while mock patterns must match a whole token. Patterns that rely on JavaScript-only syntax need rewriting, for example asserting the absence of a substring with an anchored pattern over the allowed shapes instead of `(?!…)`.

## Faults

Mock faults end the run as `error` instead of letting checks judge unreliable evidence:

- a `run` program that cannot start, dies from a signal, or exceeds the run's `timeoutMs`;
- a `run` program that prints the reserved pass marker where the rule does not allow it;
- a forwarder that cannot reach the host.

The agent sees a failed command (`126` and `<target>: Operation not permitted`), never a fault detail. A `run` program's ordinary nonzero exit is a returned response, not a fault. Programs are started in their own process group and killed with their descendants on timeout, cancellation and teardown.

## A Complete Case

The example substitutes a read-only release command, an author program and the real platform command, then checks what the agent reports:

```yaml
input: Our deploy failed. Read deploy.log, confirm the release state with `deployctl status`, read the build facts with `release-facts`, check the platform with `uname -s`, then write the cause, the certificate serial, the build id, the platform and the commands to fix it into diagnosis.md.
timeoutMs: 120000
mocks:
  shell:
    deployctl:
      return:
        stdout: |
          signing-cert: serial 41A7
    release-facts:
      run: [sh, ./mocks/release-facts.sh]
    uname:
      - args: ["-s"]
        pass: true
      - return:
          exitCode: 1
          stderr: "uname: unsupported query\n"
checks:
  - $type: file
    path: diagnosis.md
    matches: "41A7"
  - $type: file
    path: diagnosis.md
    matches: "Darwin"
runner:
  $type: acp
  agent:
    acpCommand: [pi-acp]
    home:
      deps: ${env:PI_DEPS}
      login: ${env:PI_LOGIN}
      path: [.local/bin]
    login:
      - .pi/agent/auth.json
```

`./mocks/release-facts.sh` is the author's own program next to the case file, for example `printf 'build: 2.8.1-b41\n'`; the case's working directory for `run` programs is the case file's directory. The inline agent needs prepared `deps` and `login` directories ([ACP preparation](configuration.md#acp-preparation-helpers)). `agent-evals view case.yml` shows the resolved case and every field's origin.

The repository's [`deploy-runbook`](../examples/cases/deploy-runbook/case.yml) example applies all of this end to end: a mocked release-status command, a hosted facts program, a passing `uname`, and checks for the serial, build id and platform that only those responses contain.

## `mocks.json`

`run` writes `mocks.json` into the run's result directory, beside `result.json` and `trace.json`:

```json
[
  { "target": "uname", "arguments": ["-s"] },
  { "target": "scripts/inspect.sh", "arguments": ["alpha"] }
]
```

- **When it exists.** Only when the case declares `mocks`. A run that reaches the runner writes it even if the run then fails, times out or is cancelled; a case that declares no mocks has no such file. With mocks declared and no call made, the file holds an empty list.
- **Content.** The calls that reached the mock boundary in arrival order, each with the `target` (a command name or workspace-relative path) and the `arguments` it passed. Arguments are whole tokens, so an empty argument appears as `""`.
- **Not included.** No output, exit code or standard input, and no judgment; all three actions keep this one record shape.
- **What it is not.** It is run evidence, not the case's `mocks` declaration; the declaration stays in `result.json` under `resolvedConfig` and in the case file.

## Current Limitations

- **Only the `acp` runner**, and only inside its macOS Seatbelt sandbox; Linux is unsupported.
- **`PATH` interception and denial are not a proof of absence.** A target that can `pass` keeps its real binary runnable, so an absolute-path call still runs it; the case can prove a `PATH` call, not that no other call happened. A target that cannot `pass` has its resolved real binary denied, which turns an absolute-path bypass into a failure.
- **Only bare names and workspace files.** Shell builtins, harness-internal tools, `PATH` entries added by the agent, and a script executed from outside its declared workspace path are not covered.
- **Standard input is not forwarded** to `return` or `run`; a mock downstream of a pipe answers without seeing the piped data. `pass` inherits it.
- **Output is returned after the call completes**, not streamed; the original interleaving of stdout and stderr is lost.
- **No call checker**, so mock records are not assertable yet ([M4](m4-plan.md)); MCP collaborators (M5) are unavailable.
- **Records cannot be read, altered or erased from inside the sandbox**, but any process there can cause one by calling a mocked command, or by writing to the forwarder's socket directly. Records prove that a call was made, not that only the harness made it.
