# M4: Checks, Usage and a Baseline Runner

Status: delivered. [M3](m3-plan.md) delivers shell collaborator mocks and writes their interaction records. This milestone closes the single-run loop: every evidence source gets a deterministic check, a run records what it cost, and a case can be shown not to pass vacuously.

Implemented as specified below: [`mock`](../src/checkers/mock/checker.ts) and [`shell`](../src/checkers/shell/checker.ts) checkers, the engine's [check sandbox](../src/engine/check-sandbox.ts), `runner.usage` in `result.json`, and the [`noop`](../src/runners/noop/runner.ts) runner. [Configuration](configuration.md) and [Mocks](mocks.md) own the shipped parameter and record details.

## Scope

1. **The `mock` checker.** Asserts on the run's mock records, with the engine plumbing that makes the declaration and the records available to it.
2. **The `shell` checker.** Runs an author's command in the workspace after the run and judges its exit status.
3. **Usage in the result.** The run's duration, context tokens, cost and total tokens, as far as the harness reports them.
4. **The `noop` runner.** A runner that does nothing, as the baseline that shows which checks need the agent.

Not in scope: running several cases or repetitions and summarizing them; assertions on usage; multi-turn input; MCP collaborators, which are milestone M5 (their configuration, input matching and spy behavior stay open in [M3's open questions](m3-plan.md#open-questions)); harness-internal tools, shell builtins, HTTP/network interception, model-provider fault injection, Linux.

## Decisions

Carried from M3 and not reopened:

- **Arrange and Assert stay separate.** M3's top-level `mocks` records calls and never produces pass/fail judgments; a check inspects the records after the run.
- **One record shape.** A call record holds the target and its arguments, with no output or exit code.
- **The engine stays assertion-agnostic.** The engine exposes the declared targets and the raw records and writes `mocks.json` beside `trace.json`. Checking lives in a replaceable `$type` checker.
- **`judge` is unchanged.** It does not take mock records unless a real case later needs qualitative judgment over indirect script calls absent from `trace.json`.

Settled for M4:

- **A check needs a declared observation point, not a substitution.** A target must be declared in `mocks` to be checked, because only a declared target has a forwarder and therefore records. `pass: true` declares one without changing behavior (a spy).
- **A check never arranges.** The `mock` checker does not install a forwarder for a target it names. A forwarder is visible in the sandbox, so an implicit one would make adding or removing a check change the evaluated environment.
- **An undeclared target is a `ConfigError` at load time.** The checker compares its target with the declared ones in `create()`, before any run directory exists, so a misspelled name does not cost an agent run and cannot pass vacuously. A `mock` check in a case without `mocks` fails the same way. This replaces M3's earlier wording of a checker `error` at run time.
- **Checkers are per evidence source; matching is shared.** `mock` is named after its evidence, like `file`, and mirrors the declaration: `mocks.shell.<target>` is checked by `$type: mock` with `shell`. It reuses the mock rules' argument grammar and RE2 engine through one implementation. It cannot see harness-internal tools such as `Read` or `Edit`; those exist only in the trace, which `judge` reads.
- **Usage is a recorded measurement, not evidence for checks.** It goes into `result.json` only; no checker reads it and `CheckerContext` does not carry it. Bounds on tokens or cost vary between runs like call counts do, and comparing them needs the repetition this milestone leaves out.

## The `mock` Checker

`CheckerContext` carries the run's mock records; `ImplementationContext` carries the declared mock targets for the load-time comparison.

```yaml
checks:
  - $type: mock
    shell: [git, push, { /-f|--force/: true }]
    times: 0
```

| Field   | Meaning                                                                                                                                                                                                                                                 | Default       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `shell` | A list. Position 0 is a declared `mocks.shell` target, written as a literal; `./scripts/x` and `scripts/x` name the same target. The remaining elements are a mock rule's [`args`](mocks.md#matching): a positional prefix and one trailing option map. | Required      |
| `times` | A non-negative integer: the exact number of matching calls. `0` asserts that no such call was made.                                                                                                                                                     | At least once |

- **One result per check.** `pass` or `fail`; a failure's reason gives the number of matching calls and their arguments, truncated.
- **It counts calls that reached the mock, not calls that succeeded.** A record is written before a rule is chosen, so a refused or unmatched call counts. `times: 0` means the call was not even attempted through the mock.
- **Independent of the mock rules.** The check's pattern is matched against the records and need not equal any rule's `args`. The pattern is also the content assertion: a commit message format or a deploy target is checked by matching the argument that carries it.
- **Strict parameters.** Unknown fields are errors. Position 0 cannot be a regex, since a pattern cannot be validated against the declared targets.
- **Placeholders.** Checker parameters are substituted (`${env:NAME}`) and the top-level `mocks` declaration is not, so a pattern containing `${...}` means different things in the two places.

### What a `mock` Check Can Prove

- **A matching record proves a call was made** through `PATH` or the declared workspace path. Any process in the sandbox can cause one.
- **Absence is enforced by the sandbox, not by the record.** For a `PATH` target without any `pass: true` rule the real binary is denied, so `times: 0` together with that denial shows the command had no effect.
- **A target that can pass cannot prove absence.** Its real binary stays executable, so a call by absolute path runs unrecorded. A target that passes some calls and refuses others therefore neither proves nor prevents the refused call. Seatbelt decides execution by path alone and cannot tell a forwarder's `exec` from a direct one, and placing the forwarder at the real path only moves the real program elsewhere. This is accepted, not solved: the trace through `judge` is the supplementary evidence, and a Linux backend with mount namespaces may revisit it.

## The `shell` Checker

For outcomes only execution can show: the project's tests pass, a generated script runs, a tool accepts a written configuration.

```yaml
checks:
  - $type: file
    path: tests/cart.test.js
    unchanged: true
  - $type: shell
    files:
      tests/acceptance.test.js: checks/acceptance.test.js
    run: [node, --test, tests/acceptance.test.js]
```

- **`shell` means a shell-level command, as in `mocks.shell`.** `run` is a program and its arguments, the same form as a mock's `run`, and is not handed to a shell interpreter; a pipeline is written as `[sh, -c, "…"]`.
- **Exit status is the judgment.** The program starts in the workspace root. Exit `0` is `pass`; any other exit is `fail`, with the tail of its output as the reason. A program that cannot start, dies from a signal or exceeds the check's deadline is an `error`.
- **It never runs on the host.** The workspace holds whatever the agent wrote, so the command is untrusted code. The checker starts it only through the engine's [check sandbox](#the-check-sandbox) and assembles no policy of its own.
- **It does not share the evaluated agent's environment.** Like the judge, it never reuses the runner's HOME or session, so it works the same for every runner.
- **`files` supplies tests the agent never saw.** An optional map of workspace-relative destination to authoring-relative source. The engine validates every source when the case loads, and the check sandbox stages the map into the live workspace right before this check's program starts; the files stay for later checks and disappear with the run root. Missing or inaccessible sources, invalid spellings and two entries producing one file are configuration errors.
- **Placement runs inside the check sandbox.** Every destination walk, unlink and copy executes under Seatbelt's write policy, so even a concurrent workspace process cannot make it reach outside the workspace. It also refuses a symlinked ancestor, and unlinks whatever is at a file's destination before copying, so the agent cannot redirect the write or keep a fake at the path. A directory where a file goes is an error. The agent can still edit tests that are already in the workspace; use `files` for what it should never see, and `file` `unchanged` for anything it must not edit.
- **Mocks are gone at check time.** The mock host is closed, so a command that reaches a mocked workspace script fails at its forwarder. Mocked `PATH` commands are not on the check's `PATH` at all.
- **It runs in the live workspace.** Checks run in declaration order and a command may write caches or reports, so a `file` check that must see the agent's result unchanged is declared before it. A copy would cost a copy and break absolute paths written during the run.

## The Check Sandbox

Running a program at check time is an engine capability, not a property of one checker. The engine builds the Seatbelt policy and hands the checker a launcher on `CheckerContext`; `shell` is its first user and a trusted extension checker gets the same one.

- **The policy is fixed and has no configuration.** Reads are not limited; writes are limited to the workspace and a private HOME and temporary directory; the network is denied; the existing sandbox-wide cleanup supervisor ends every process.
- **The operator's toolchain works as it is.** The program is found through the operator's own `PATH`, like a mock's `run` program, and can read wherever that toolchain lives (`node` under a version manager, `python3` under `/opt/homebrew`). The rest of the operator's environment is not passed on, since it may hold credentials.
- **Why reads are open at check time.** The agent's sandbox hides the case files, the baseline and the operator's files so that nothing reaches the agent, and at check time the agent has stopped. What still matters is that the program cannot change the host or the evidence and cannot send anything out, and the write and network limits give that.
- **Retained output can disclose what was read.** A checker that keeps a program's output, as `shell` does in a failure's reason, lets a hostile workspace print any file the operator can read into `result.json`, which stays on the operator's machine.
- **`judge` keeps its own sandbox.** It runs no workspace code and needs the network to reach its model, so it does not use the launcher.
- **To be replaced in M6.** The open-read policy is fixed in code and invisible in the case, and no `$sandbox` key exists, so that M4 leaves no syntax behind. [M6](roadmap.md#open-questions) redesigns sandbox configuration as a whole and replaces this fixed policy with a declared one.

## Usage in the Result

`result.json` gains the runner's reported usage beside the `durationMs` it already records:

| Value          | Source                                                                                               | Pi  | Claude |
| -------------- | ---------------------------------------------------------------------------------------------------- | --- | ------ |
| Duration       | The engine's own clock; recorded today as `runner.durationMs`.                                       | yes | yes    |
| Context tokens | The last ACP `usage_update`: tokens in context and the context window size.                          | yes | yes    |
| Cost           | The same update's optional cumulative session cost, with its currency.                               | yes | yes    |
| Total tokens   | The prompt response's `usage`, from ACP's unstable part: total, input, output, cache read and write. | no  | yes    |

- **Context tokens and total tokens are different values and are named apart.** Context tokens are the context's size at the end of the run, not what the run consumed. Total tokens are the sum over the turn's model calls and exist only where the harness sends the unstable field.
- **Each value is optional.** A harness that omits one leaves it out; nothing is estimated from another value, and there is no price table or conversion. A runner that reports nothing, such as native Pi or `noop`, has no usage.
- **Reported like the trace.** A runner exposes its usage whether or not the run completed, so a timed-out run still shows the last context size and cost it saw. Total tokens arrive with the turn's end and are absent from a run that did not finish.
- **The unstable field is validated where it arrives.** The stable SDK client passes it through untyped, so the runner parses it with its own schema and drops it when the shape does not match, instead of failing the run over a field the protocol may change.
- **`_meta` is not recorded.** Claude attaches account rate-limit state to its usage updates; only the documented fields are kept.

## The `noop` Runner

```yaml
runner:
  $type: noop
```

It starts no harness and no sandbox and completes at once with no final text and an empty trace. Run against a case, it gives the baseline: a check that passes here does not depend on the agent.

- **A sound case fails under `noop`.** Checks that require the agent to have done something (`file` `matches`, `mock` with its default count, `shell` over a broken fixture) must fail. One that passes is vacuous for that purpose.
- **Restraint checks pass by construction.** `times: 0` and `unchanged` hold when nothing ran; the baseline says nothing about them.
- **It accepts `mocks`.** It declares mock support so a case with `mocks` loads; the forwarders are written and nothing calls them, so the records are empty.
- **It records an empty trace**, so a `judge` asking for the trace is evaluated instead of ending as an error.
- **A case selects it like any runner.** `run` gains no override: a file that wants a baseline declares `runner` per named case and adds one with `$type: noop`, as `deploy-runbook` already does for its harnesses.

## End-to-End Example

[`deploy-runbook`](../examples/cases/deploy-runbook/case.yml) gains a refused `make` (`pass: false`), a `mock` check with `times: 0` beside the trace judge that asks the same question (so the deterministic and the judged answer to "no fix command was run" can be compared), and a `baseline` case on the `noop` runner.

It also exercises both kinds of `shell` check:

- **A fixture script.** `file` `unchanged` on `fixture/checks/check-diagnosis.sh` runs before the `shell` check that executes it, so the agent cannot edit its way to a pass. The script asserts only public facts — `diagnosis.md` is non-empty and repeats the `E4127` code `deploy.log` already shows — because the fixture is shared with `deploy-runbook-native` and must not leak the skill's private cause or fix.
- **A check-time acceptance script.** `checks/acceptance.sh` sits outside `fixture/` and is placed into the workspace through `shell.files` only when the check runs, so the agent never sees the private fix commands and combined facts it asserts.

## Verified

One real single-turn run of each harness through the `acp` environment (2026-11-15), with `pi-acp` 0.0.34 and `claude-agent-acp` 0.107.0, capturing the wire messages:

- **Both send `usage_update`** with the context size and a cumulative cost in USD: Pi ended at 1,710 context tokens and Claude at 17,640. Claude's cost under a subscription token is a notional figure.
- **Only Claude sends the unstable `usage`** on the prompt response (35,246 total tokens, almost all cache reads and writes). Pi answers with the stop reason alone.
- **The stable SDK client delivers the unstable field unchanged**, so reading it needs no change of SDK entry point.

The `shell` sandbox against real toolchains (2026-11-15), through `/usr/bin/sandbox-exec` on macOS 15.5 with a deny-default profile: open reads, writes limited to the workspace, a private `HOME` and a private `TMPDIR`, no `network` clause, and exactly `PATH`, `HOME` and `TMPDIR` in the environment.

- **`npm test` passes as it is.** `npm test` → `node --test` in a Node 24 project exited 0 under the private `HOME`, and 1 with the assertion in its tail when a test failed. npm wrote only beneath the private `HOME` (`.npm/_logs`, `_update-notifier-last-checked`) and its update check's `registry.npmjs.org` fetch failed with `ENOTFOUND` without failing the command; Node's compile cache went under the private `TMPDIR`. `clang`, `make`, `swiftc`, `git` and `python3` ran from the operator's `PATH` and also wrote only there.
- **A redirected `HOME` withholds configuration, silently.** `git` finds no `~/.gitconfig`: `git config --get user.name` exits 1, and a commit without `-c user.name` and `-c user.email` fails with "Author identity unknown" (exit 128) in an otherwise writable repository. npm needed no copy, because it reaches its global configuration through the Node installation rather than `HOME`.
- **Reads are open and writes end at `EPERM`.** A check read the operator's `.zshrc` and `/etc/passwd`, while every write outside the three directories failed with `EPERM`: the operator's home, the repository and `/tmp`. `mktemp` used the private `TMPDIR` and failed with `Operation not permitted` for `mktemp -p /tmp`.
- **The network denial covers loopback and Unix sockets.** With no `network` clause, `listen` on `127.0.0.1:0`, `0.0.0.0:0` and `::1:0` all failed with `EPERM`; so did `connect` to a host process's loopback port, to `1.1.1.1:443`, and to an `AF_UNIX` server, whose own `listen` in the private `TMPDIR` failed with `EPERM` first. Name resolution still works from `/etc/hosts` (`localhost` → `::1`) and fails `ENOTFOUND` for external names.
- **A loopback exception is not a loopback exception.** Seatbelt parses only `localhost` or `*` as an `ip` filter host and rejects `127.0.0.1` with "host must be * or localhost" (exit 65). Adding `(allow network-inbound (local ip "localhost:*"))` with its `remote` counterpart made loopback listen and connect pass and kept `1.1.1.1:443` at `EPERM`, but also let the sandbox listen on `0.0.0.0:45999`.

So a check suite that binds an ephemeral port or uses a Unix socket for IPC fails at check time, as does anything that activates credentials kept in the operator's `HOME`. Nothing measured contradicts the fixed policy; whether `shell` ever admits loopback is part of the sandbox configuration [M6](roadmap.md#open-questions) designs.

## Deferred

Added only for a real case:

- **Count ranges** (`min`, `max`). Agent call counts vary between runs, so bounds are brittle; an exact count stays for calls whose repetition is itself the defect.
- **Order between calls.** Records are already in arrival order; no assertion uses it yet.
- **More in a record**: working directory, standard input, environment, or which action answered. Each needs a record change.
- **A `kind` on `MockRecord`.** Decided with M5's MCP records.
- **A scalar shorthand** for `shell: [git]`.
- The argument grammar's M3 gaps: exact argument lists, repeated and combined options, regex flags.
- **Network access for `shell`.**
