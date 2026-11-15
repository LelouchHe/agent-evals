# Mocks

A mock is a case-owned substitute for a collaborator at the environment boundary: a case declares it, the run arranges it, and every call that reaches it is recorded. This page owns mock usage — what mocks do, how they relate to checks and the trace, the supported configuration, matching, the three actions, a complete case, `mocks.json`, and current limitations. [M3](m3-plan.md) owns the design decisions; [Configuration Reference](configuration.md) owns the rest of the case format. Asserting on recorded calls is [M4](m4-plan.md); MCP collaborators are M5.

Implemented: shell collaborators — bare `PATH` commands and workspace scripts — with `return`, `run` and `pass`, argument matching and Seatbelt denial, wired by the `acp` runner on macOS.

## What a Mock Does

For each declared target the engine writes a thin forwarder into the run. A bare command name gets a forwarder in a per-run directory that the runner puts first on `PATH`; a workspace-relative path gets a forwarder at that path. The forwarder reports the call over a per-run socket and prints the reply, which may itself be a decision to run the real command inside the sandbox.

- The forwarder is the only mock code inside the sandbox. Matching, actions, call records and the author's `run` programs stay on the host; a `pass` runs the real command in the sandbox.
- A call is intercepted at command lookup, or at a declared workspace path, so a call from a script is caught too, because children inherit `PATH` and the declared path is the forwarder. Undeclared commands resolve as usual and are not recorded.
- Paths nobody declared are not intercepted, for example `/usr/bin/make` or a script outside the workspace. For a mocked `PATH` target without any `pass` rule the real binary is _denied_ in the sandbox, so that bypass fails instead of running.
- Shell builtins, harness-internal tools and undeclared paths are outside this boundary; a declared workspace script is covered at exactly its declared path.
- Nothing hides the substitution: `which` and reading the forwarder reveal it, never the declared rules, results or records. Any process in the sandbox can cause a record by calling a mocked command, or by writing to the forwarder's socket directly; it cannot read, change or remove one.

## Mocks, Checks and the Trace

`mocks` and `checks` are separate. `mocks` arranges the run, answers calls and records them; it never produces a pass or fail. `checks` inspect evidence afterwards, and today they cannot inspect mock records.

- [`mocks.json`](#mocksjson) is the evidence a mock produces: what actually reached the mock boundary, in arrival order.
- [`trace.json`](configuration.md#inspecting-and-recording) is what the harness reported: messages, reasoning and requested tool calls. A requested call in the trace does not prove its effect, and the trace may omit calls a script made; a recorded mock call is the boundary evidence for those.
- No call checker exists yet. Asserting on recorded calls is planned in [M4](m4-plan.md); until then `mocks.json` is retained evidence to read, and `judge` does not take it.

Use a mock to control what a collaborator answers, to supply a fake implementation, and to keep real effects from happening; use a check on the workspace, the trace or a judge for the outcome that matters.

## How a Run Uses Mocks

Mocks are prepared with the other run state and answered while the harness runs; the host closes only after the harness has stopped:

```text
 1. load      resolve the case; compile every mock rule and RE2 pattern
              `-- a bad shape or pattern stops here: no run root, no result

 2. prepare   create the run root and prepare its directories
              |-- fixture, then files         -> workspace/
              |-- workspace-script forwarders -> at their target path;
              |                                  real scripts moved out
              |-- PATH forwarders and script  -> outside the workspace
              |-- host sockets opened         -> outside the sandbox
              |-- baseline snapshot           -> after the forwarders
              `-- runner starts the harness   -> forwarder dir first on PATH

 3. act       the harness works; every mocked call is answered and recorded
              `-- calls from processes that outlive the turn are still answered

 4. stop      the harness sandbox is stopped first
              `-- then the host closes and returns records and faults
                  `-- any fault marks the run "error"

 5. assert    checks read workspace/ and baseline/ (no call checker yet: M4)

 6. teardown  the run root is removed
              `-- retained: result.json, plus trace.json when the runner
                  records one and mocks.json when the case declares mocks
```

## One Mocked Call

```text
 INSIDE THE SANDBOX (agent)                        |  OUTSIDE THE SANDBOX (host)
                                                   |
  agent shell or script                            |
    $ make deploy                                  |
        |                                          |
        v                                          |
  forwarder (PATH dir or workspace path)           |
    canonicalise own path, base64 path + argv      |
        |                                          |
        +-- Unix socket, one per run ------------->|
                                                   |  host service
                                                   |   1. record {target, arguments}
                                                   |      before choosing a rule
                                                   |   2. first matching rule from
                                                   |      the ordered list
                                                   |      (no match -> reply 126)
                                                   |
                                                   |   3. action
                                                   |      return -> fixed result
                                                   |      run    -> author program
                                                   |                on the host
                                                   |      pass: true -> hand the call
                                                   |                   back
                                                   |      pass: false -> refuse here:
                                                   |                   recorded, 126
                                                   |      run+pass -> hand back only
                                                   |      when the program's output
                                                   |      is exactly its marker
        <-- reply: result | pass | 126 ------------+
        |
        |-- result: write the reply's stdout/stderr,
        |   exit with its code
        |
        |-- 126: "<target>: Operation not permitted"
        |   (no matching rule, an explicit pass:false,
        |    or a mock fault that also ends the run)
        |
        `-- pass: exec the real command here
            * next PATH entry for the name, skipping
              this forwarder
            * or, for a workspace script, its .name
              sibling
            then stdin, output, signals and exit
            status are the real command's own
```

The two regions are the trust boundary. Inside the sandbox there is only a forwarder — a readable `sh` script — plus, for a `pass`, the real command it starts; rules, actions, call records and the author's `run` programs stay on the host. `which` and `cat` reveal the forwarder, never the rules or the records.

The host records the call **before** it chooses a rule, so evidence does not depend on which action ran or whether one matched. A `return` or `run` reply is data for the caller; a `run` program is trusted author code on the host, started without a shell with the call's arguments appended, never agent code and never executed in the sandbox. A `pass` reply is a decision: the real command runs only in the sandbox, from the forwarder, so its stdin, output, signals and exit status stay its own and the host never runs it. An unmatched call is refused with `126` and still recorded; that refusal is a normal decision, not a fault. A mock fault looks the same to the caller but is different in the record: transport failure (the forwarder prints `Service unavailable` and reports the target in the run's scratch directory, which the engine reads at close), and a `run` program that cannot start, dies or overruns, or prints the reserved marker where the rule does not allow it. Any fault ends the run as `error`: checks may still run and their results are retained, but they cannot make the run pass. `mocks.json` is written whenever the case declares mocks, so a faulting run still shows the calls that did arrive, possibly none. `mocks.json` holds these calls — target and arguments, in arrival order — as evidence: no output, exit status or judgment.

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

| Action        | Behavior                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `return`      | A fixed result: `exitCode` (0–255, default `0`), `stdout` and `stderr` (default empty strings), written byte for byte.                                                                                                                                                                                  |
| `run`         | An author-supplied host program, started without a shell in the case file's directory with the call's arguments appended and empty standard input, returning its stdout, stderr and exit status unchanged. Its arguments are agent-controlled, so it treats them as untrusted.                          |
| `pass: true`  | The real command runs inside the sandbox: the forwarder finds the next executable of that name on `PATH`, skipping its own entry, and `exec`s it; a workspace script `exec`s its dot-named sibling. Standard input, output, signals and the exit status are the real program's. The host never runs it. |
| `pass: false` | The matched call is refused: recorded, exit `126` with `<target>: Operation not permitted`, and the real command does not run. A normal refusal, not a fault. Beside `run` it is the default: the program's own output is returned and it simply cannot authorize delegation.                           |

A refusal is per rule: `pass: false` refuses the calls it matches, while a later or earlier `pass: true` rule still handles its own calls:

```yaml
docker:
  - args: [push]
    pass: false # recorded refusal, 126, no fault, no real command
  - pass: true
```

`run` can decide between a result and a pass by setting `pass: true` beside it. Only one complete stdout value is a control value: the single line `agent-evals:pass`, with at most one trailing line feed. With exit `0` and a rule that sets `pass: true`, the call passes, none of the program's output reaches the agent and the real command runs in the sandbox. The same complete value from a rule without `pass`, or with a nonzero exit, is a mock fault, so the marker can never reach the agent and a missing `pass` is noticed. Stdout and stderr are otherwise opaque bytes, returned unchanged: a marker embedded in other output is ordinary data, and a crashed program cannot print the complete value by accident. The same holds for a `return`'s YAML text, which is UTF-8 by construction.

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
- **Ordered per target.** The first matching rule wins; a rule without `args` is the fallback. When no rule matches, the call is still recorded, the real command does not run, and the forwarder exits `126` with `<target>: Operation not permitted` on stderr — the shape of a Seatbelt denial, without naming mocks. An explicit `pass: false` rule refuses the same way.

Not expressible yet: repeated options (`-e A=1 -e B=2`), exact argument lists (a bare `make`), combined short options (`-rf`) and regex flags.

## Regexes

Every pattern in a case is RE2: mock `args` patterns here, and the [`file` checker's](configuration.md#file-checker-type-file) `matches`. RE2 has no lookaround or backreferences, and such a pattern is a configuration error at load time; every accepted pattern runs in linear time, so matching cannot be driven into catastrophic backtracking by agent-controlled input. One dialect covers both places; the `file` checker searches within the file while mock patterns must match a whole token. Patterns that rely on JavaScript-only syntax need rewriting, for example asserting the absence of a substring with an anchored pattern over the allowed shapes instead of `(?!…)`.

## Faults

Mock faults make the run finish as `error`, whatever the checks say; their individual results are still retained, so a fault cannot turn into a pass:

- a `run` program that cannot start, dies from a signal, or exceeds the run's `timeoutMs`;
- a `run` program that prints the complete pass marker where the rule does not allow it, or with a nonzero exit;
- a forwarder that cannot reach the host: it prints `<target>: Service unavailable` and reports the target in the run's scratch directory, which the engine reads when the host closes.

The agent only sees the failed command (exit `126`), never a fault detail. An unmatched rule or a broken rule condition is ordinary denial instead: `126` with `<target>: Operation not permitted`, recorded, and not a fault. A `run` program's ordinary nonzero exit is a returned response, not a fault. Programs are started in their own process group and killed with their descendants on timeout, cancellation and teardown, including descendants that outlive a program which exited normally.

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
- **`PATH` interception and denial are not a proof of absence.** A target with any `pass: true` rule keeps its real binary runnable, so an absolute-path call still runs it; the case can prove a `PATH` call, not that no other call happened. A target that cannot `pass` has its resolved real binary denied, which turns an absolute-path bypass into a failure.
- **Only bare names and workspace files.** Shell builtins, harness-internal tools, `PATH` entries added by the agent, and a script executed from outside its declared workspace path are not covered.
- **Standard input is not forwarded** to `return` or `run`; a mock downstream of a pipe answers without seeing the piped data. `pass` inherits it.
- **Output is returned after the call completes**, not streamed; the original interleaving of stdout and stderr is lost.
- **No call checker**, so mock records are not assertable yet ([M4](m4-plan.md)); MCP collaborators (M5) are unavailable.
- **Records cannot be read, altered or erased from inside the sandbox**, but any process there can cause one by calling a mocked command, or by writing to the forwarder's socket directly. Records prove that a call was made, not that only the harness made it.
- **Transport-fault reporting is ordinary, not tamper-proof.** The marker a lost connection leaves in the run scratch directory is in agent-writable space, so a process that deliberately clears it hides the fault from the run status; `trace.json` is there for investigation, though it does not necessarily record every indirect operation.
