# Architecture

Agent Evals executes configured tests against agent systems. The engine is generic; the current evaluation runtime is deliberately narrow: one input message, a filesystem workspace, a native Pi RPC runner or the generic ACP runner plus a `noop` baseline, and file/mock/shell/trace/judge checks on macOS. Standalone ACP configuration-query and login helpers share the ACP runner's environment setup.

This page explains how the implemented modules cooperate. [Configuration](configuration.md) owns the authoring/reference rules; [Roadmap](roadmap.md) owns the target shape and planned capabilities.

## Components and Connections

Responsibility and wiring, not execution order ([One Run in Order](#one-run-in-order) covers that):

```text
                        agent-evals CLI
          view /            |  run                \  config, login
              v             v                      v
      +----------------------------------+   +---------------------------+
      | case resolver                    |   | ACP preparation helpers   |
      | YAML, selection, field origins   |   | agent schema, HOME/login  |
      +-----------+------------------+---+   | assembly, queries         |
                  | view             | run   +-------------+-------------+
                  v                  v                   |
      +------------------+  +---------------------+      | shares the ACP
      | resolved display |  | engine              |      | environment code
      | no runtime       |  | validate, prepare,  |      |
      +------------------+  | run, stop, check,   |      |
                            | record, clean up    |      |
                            +--+------+------+----+      |
                               |      |      |           |
                               v      v      v           |
                  +------------+ +--------+ +-----------+|
                  | runner     | | mock   | | checkers  ||
                  | harness or | | host   | | file/mock ||
                  | noop       | | rules, | | trace/    ||
                  |            | | actions| | shell,    ||
                  +-----+------+ | records| | judge: Pi ||
                        |        +--------+       |      |
      +-----------------+-+                       +--> separate, tool-free
      v                   v                             Pi run; never the
  native Pi             ACP                             evaluated session
  route                 route
  no mocks:             mocks supported
  rejects them          (forwarder dir first on PATH)
      |                   |
      +---------+---------+
                |
  +-------------+----------------------------------------------------------+
  | HOST: the engine starts the platform launcher                          |
  |   sandbox-exec -f <policy> -- <supervisor> <harness> ...               |
  |   policy file: native Pi in run/scratch/, ACP in run/config/           |
  +-------------+----------------------------------------------------------+
                |  Seatbelt boundary
  +-------------+----------------------------------------------------------+
  | SANDBOX: the cleanup supervisor starts the harness and its tools       |
  |   ACP:  /bin/sh supervisor; the workload's exit status returns on      |
  |         fd 3, a private pipe to the host; then it kills the sandbox    |
  |   Pi:   node supervisor; Pi's shell wrapper records each process       |
  |         group it starts, and the supervisor signals those at exit      |
  |   control: harness stdio (ACP messages, or Pi JSONL RPC)               |
  |   stop: the host signals the sandbox (native: its process group; ACP:  |
  |   a stop the supervisor turns into a sandbox-wide kill)                |
  +-------------+----------------------------------------------------------+
                |
                v
        harness + its tool processes

  authors' run programs and the call records stay on the host, outside the sandbox
```

The check-time path from the same checkers box, after the harness stopped:

```text
  LOAD TIME: checker.create(params, context)
    `-- ImplementationContext.validateFiles(files) -> ConfigError on invalid

  CHECK TIME: checkers, after the harness stopped

  checker ($type: shell, or extension)
    |  CheckerContext.checkSandbox.run(run, { files })
    v
  engine: stages files into check-*/staged/ (read-only inside the sandbox)
    v
  HOST: sandbox-exec -f check-*/sandbox.sb -- /bin/sh -c <supervisor.sh>
    |     open reads; writes only workspace/, private home/ and tmp/
    v  Seatbelt boundary
  SANDBOX: supervisor.sh starts check-runner.ts
    |  1. place check-*/staged/ into workspace/ (files only at check time)
    |     refuse symlinked ancestors; unlink a leaf before copying
    |  2. spawn the command with exactly PATH, HOME and TMPDIR
    |  3. report exit, signal or placement failure on private FD 5
    v
  HOST: checkSandbox reads FD 5 -> CheckSandboxOutcome (exited/signalled/failed)
    `-- shell checker maps exit 0 pass, other exit fail, signal/failure error

  $type: judge -> separate tool-free Pi invocation in its own sandbox
```

- **CLI** parses commands and flags, registers built-ins, loads each implementation beneath the trusted extension roots and maps outcomes to exit codes. `view` stops at the resolver and prints the resolved declaration; it starts no runtime. `run` resolves the selected case—or every case of a `cases` document when `--case` is omitted—and hands them to the engine serially. `config` and `login` take a standalone agent file and use the ACP preparation helpers instead.
- **Engine** validates parameters, prepares the run root, sequences the runner, checks and cleanup, and retains the result. It owns the mock host's lifecycle and the retained records.
- **Runner** drives one harness and stops its owned processes. The native Pi route is an isolated JSONL RPC session under Seatbelt; the generic route speaks ACP with a caller-prepared harness home.
- **Mock host** owns mock rules, actions and call records, plus authors' `run` programs. It lives outside the evaluated sandbox; [Mocks](mocks.md#how-a-run-uses-mocks) owns the mechanism.
- **Checkers** read evidence and produce judgments. The `file` checker reads one file and evaluates literal substrings and `/…/` RE2 patterns in-process; `mock` matches the run's recorded mock calls with the same argument grammar and RE2 engine the mock rules use; `trace` derives skill consultations from the runner's trace, the workspace and the baseline and asserts on their names and counts; `shell` passes its check-time `files` to `CheckerContext.checkSandbox.run(run, { files })`, and the engine stages them into the workspace inside the sandbox; the judge starts its own tool-free Pi invocation from selected evidence and never shares the evaluated agent's session or tools.
- **Check sandbox** is an engine capability on `CheckerContext`, not a checker's own policy. `run(command, { files })` validates and stages any `files` (the same validation is offered at load through `ImplementationContext.validateFiles`), launches `sandbox-exec` -> `supervisor.sh` -> `check-runner.ts`, and that runner places `check-*/staged/` into the workspace before starting the command with open reads, writes only beneath the workspace and a private HOME and temporary directory, no network, and a minimal environment. `check-runner.ts` reports the exit status, signal or placement failure on a private FD 5 pipe back to the engine. `judge` does not use it because it needs the network for its model.
- **ACP preparation helpers** reuse the same agent schema and HOME/login assembly for `config` and `login`; they do not run a case.

The judge reuses Pi transport/session mechanics, not the evaluated runner's session or the engine's full execution loop. The supervisor and shell wrapper cover tracked shell-process teardown inside the same Seatbelt instance. Registry files writable by the agent never authorize unsandboxed host signals.

## Definitions, Factories, and Instances

Definitions expose a `type`, a Zod `params` schema, and `create(params, context)`. Runner and checker are separate contracts.

1. The registry selects the definition by `$type`.
2. The engine substitutes parameter [placeholders](configuration.md#placeholders), then runs the declared schema once.
3. The factory receives an `ImplementationContext`: the YAML declaring directory (`authoringDir`), the run's placeholder `values`, declared `mockTargets` when the case has mocks, and `validateFiles`, which validates and stages a checker's check-time `files` against `authoringDir`. It does not receive an environment-source or credential-lookup interface.
4. The instance keeps its parameters; execution receives only runtime state:

```text
Runner.run(RunnerContext)     -> RunnerOutcome
Runner.stop()                -> completion, safe to call again
Checker.check(CheckerContext) -> CheckResult[]

ImplementationContext: authoringDir, values, mockTargets?, validateFiles
CheckerContext:        workspace, baseline, trace?, mockRecords?,
                       checkSandbox, input, runRootDir, timeoutMs, signal
```

**The engine owns sourcing, declared-schema validation and lifecycle—not business meaning.** Schemas define parameter types, defaults and declared constraints. Implementations own their logic, operational requirements, authentication and outputs. The engine does not infer extra rules from names such as `apiKey`, proactively verify credentials, or automatically redact values.

Built-ins and trusted extensions share this path and layout: one implementation is one directory whose `index.ts`, `index.js` or `index.mjs` exports `runner`, `checker`, or both. [Extensions](extensions.md#discovery) owns discovery. Dynamic modules cross a localized type-erasure boundary; module authors own schema/factory consistency. [Extensions](extensions.md) lists every contract field for implementers; the source interfaces live in [`registry.ts`](../src/engine/registry.ts).

## One Run, in Order

A run follows the test lifecycle in [Writing Cases](cases.md#the-test-model): set up the environment, act, collect observations, assert, tear down. Teardown runs even after failure. Today the runner stops its processes and the engine removes the single runtime root; the engine also starts and stops the mock host that answers declared collaborator substitutes.

1. **Load.** Resolve the selected case or cases and preserve their declarations. Every selected case is validated first: choose each run root's path without creating it, select definitions, substitute placeholders from the invocation `.env` and the chosen run directories, validate schemas, create instances and validate the fixture. A configuration error in any selected case runs none. The engine never interprets provider/key names. [Configuration](configuration.md#placeholders) owns placeholder semantics.
2. **Set up.** Create the chosen root exclusively; an existing path is an error. The engine copies the fixture into `workspace` or starts empty, places each `files` entry on top, and prepares independent `home`, `config` and `scratch`; source fixtures remain unchanged. For a case declaring [`mocks`](mocks.md), the engine writes the forwarders, workspace scripts included, starts the host service that answers them, and only afterwards captures the initial `baseline` snapshot, so a replaced script compares forwarder with forwarder. The runner assembles its harness configuration, for Pi by staging selected skills with discovery disabled. The platform module builds the Seatbelt policy; a runner that wires mocks adds the forwarder directory as a readable, non-writable root and first on `PATH`.
3. **Act.** The runner receives the input, directories, deadline, cancellation signal and optional mock wiring, and drives the harness. Pi runs its isolated RPC session under Seatbelt, with autonomous tool calls after one initial message.
4. **Collect.** Await supported runner teardown before checks; the runner returns its final text, its trace and its reported usage. The mock host closes only after that teardown, so a call from a process that outlived the turn is still answered and recorded. Timeouts, cancellation and execution failures are not negative judgments. See [Known Limitations](#known-limitations).
5. **Assert.** Checkers inspect the still-live workspace/baseline, the recorded mock calls and the runner's trace. File, mock and trace name patterns share the linear-time RE2 engine; `trace` derives skill consultations from the trace, the workspace and the baseline; `shell` runs its program in the engine's check sandbox, after the harness stopped and the mock host closed; the judge reads selected evidence and starts a separate tool-free Pi invocation.
6. **Tear down and record.** Remove runtime state, then save outcomes, declared configuration and cleanup status. Early load errors need not produce a run record.

The ACP runner and the standalone `config` and `login` preparation helpers live in [`runners/acp/`](../src/runners/acp/) and share one agent schema, HOME/login assembly and ACP session setup. These are implementation-owned; generic authoring/value-source/schema utilities are shared with cases. macOS system read roots, default command paths, terminal discovery and Seatbelt policy preparation stay in `platform/macos/`. Both use a sandbox-wide supervisor with a private completion pipe, not the native Pi shell registry. The runner assembles into the engine's run HOME and workspace; the helpers allocate their own temporary directory.

The host sandbox is a deliberate execution choice: real platform behavior is part of the subject being measured. Seatbelt is the current backend, not a claim that every OS has identical isolation guarantees.

## State and Trust Boundaries

What the sandbox can reach, prepared before the evaluated agent starts and torn down after it stops:

```text
CASE AUTHORING (operator-owned, in the case YAML's directory)
  <case>.yml
  fixture/            base tree, copied first
  <asset>             any files source, read from this directory

ACP AGENT CONFIGURATION (its own file and directory)
  home.deps           harness software, linked read-only into the run HOME
  home.login          login state, copied into the run HOME

PREPARATION (host, before the sandbox starts)
  fixture/      --copy-------------->  workspace/
  <asset>       --place at key------>  workspace/<key>     overlay, after the fixture
  a files key is a destination relative to the prepared workspace root
  a files value is a source relative to the case YAML's directory, not the
  fixture directory and not the invocation directory
  entries are combined in an internal run/files stage, then copied over the
  workspace; the stage is removed before the harness starts and is never the
  public base for resolution

  workspace scripts --replace----->  workspace/<target>   mock forwarder; the real
                                                           script moves out, or to
                                                           .<name> for a pass rule
  PATH forwarders and script ----->  run/bin/ and run/forward
  snapshot ---------------------->  baseline/             after the lines above

RUN ROOT  <tempParent>/run-<id>/                       temporary, removed after
  workspace/   agent-writable     fixture, then files, then mock forwarders
  baseline/    host-read only     the snapshot above; not readable in the sandbox
  home/        agent-writable     ACP: deps as read-only links, login as copies
                                  native Pi: Pi's isolated HOME
  config/      ACP: unreadable    ACP: Seatbelt policy
               native: writable   native Pi: isolated settings, staged skills
  scratch/     agent-writable     temporary state; native Pi policy; the
                                  forwarder fault marker
  tools/       native Pi only     the sandbox-resident supervisor and wrapper
  bin/         ACP mocks only     forwarders first on PATH; readable, not writable
  forward                         the shared forwarder script text
  replaced/                       real workspace scripts moved out of reach
  files/       internal           transient files staging, gone before launch
  check-*/     one per check      home/ and tmp/ private; sandbox.sb policy;
                                  staged/ read-only check-time files, placed
                                  into workspace/ by the sandboxed
                                  check-runner; removed after the check

HOST STATE OUTSIDE THE SANDBOX
  engine        case, checks, rubric, policy, run bookkeeping, cancellation
  mock host     rules, actions, call records, authors' run programs
  socket        <system temp>/run-<id>.sock, outside the run root and the sandbox
  results       <results-dir>/<run-id>/: result.json, trace.json when recorded,
                mocks.json when declared, diagnostics.log when non-empty

AFTER THE RUN
  the run root and the socket are removed; the results directory is retained
```

- **Authoring assets:** operator-owned YAML, fixtures, skills and extensions. Config-relative resources resolve from the declaring file; executable extensions are not discovered from the agent-writable workspace. Extension code and `.env` lookup commands are trusted host code, not sandboxed test subjects.
- **Evaluated runtime:** writable workspace and explicitly permitted per-run state. The initial baseline, case/check definitions, rubric and retained results stay outside the evaluated agent's intended access.
- **Observations:** directory identity and path/symlink containment are checked before file reads. Non-regular and oversized evidence is an error, not a vacuous pass. A missing observation cannot prove a restraint was respected.
- **Results:** declarations, source/case identity, outcomes, reported usage, diagnostics and cleanup. Expanded parameters do not replace the declaration; runtime outputs remain the implementation's responsibility. No full resource snapshot is retained.

Observations come from three sources defined in [Writing Cases](cases.md#why-the-trace-matters): the runner's trace (with output as its user-facing view), mock call records, and environment side effects. Today the ACP runner retains `trace.json` (which `judge` can take as evidence), a case declaring [shell mocks](mocks.md) retains `mocks.json` (which `mock` asserts on), `file`/`shell` inspect the workspace, `trace` derives skill consultations from `trace.json`, the workspace and the baseline, and `judge` reads selected evidence. Recorded usage is a measurement in `result.json`, not check evidence.

## Source Map

| Area                          | Main source                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry point and display       | [`cli.ts`](../src/cli.ts), [`view.ts`](../src/engine/view.ts)                                                                                                                                                                                                                                                                                                                        |
| Resolution and contracts      | [`authoring.ts`](../src/engine/authoring.ts), [`config.ts`](../src/engine/config.ts), [`registry.ts`](../src/engine/registry.ts)                                                                                                                                                                                                                                                     |
| Preparation and lifecycle     | [`params.ts`](../src/engine/params.ts), [`env-source.ts`](../src/engine/env-source.ts), [`run.ts`](../src/engine/run.ts), [`mocks.ts`](../src/engine/mocks.ts), [`mock-match.ts`](../src/engine/mock-match.ts), [`regex.ts`](../src/engine/regex.ts), [`forwarder.sh`](../src/engine/forwarder.sh)                                                                                   |
| Files and retained records    | [`workspace.ts`](../src/engine/workspace.ts), [`results.ts`](../src/engine/results.ts)                                                                                                                                                                                                                                                                                               |
| Harness adapter and transport | [`runners/pi/`](../src/runners/pi/), [`runners/noop/`](../src/runners/noop/)                                                                                                                                                                                                                                                                                                         |
| ACP runner and helpers        | [`runners/acp/`](../src/runners/acp/)                                                                                                                                                                                                                                                                                                                                                |
| Assertions and model judgment | [`checkers/file/`](../src/checkers/file/), [`checkers/mock/`](../src/checkers/mock/), [`checkers/shell/`](../src/checkers/shell/), [`checkers/trace/`](../src/checkers/trace/), [`engine/skills.ts`](../src/engine/skills.ts), [`checkers/judge/`](../src/checkers/judge/), [`check-sandbox.ts`](../src/engine/check-sandbox.ts), [`check-runner.ts`](../src/engine/check-runner.ts) |
| OS enforcement and packaging  | [`platform/macos/`](../src/platform/macos/) ([`supervisor.sh`](../src/platform/macos/supervisor.sh)), [`build.mjs`](../scripts/build.mjs)                                                                                                                                                                                                                                            |

## Known Limitations

### Runtime

- **Platform.** macOS only (`/usr/bin/sandbox-exec`), Node.js 24+, no standalone single-file binary.
- **Conversation and execution.** One initial user message per case. A `cases` document runs its entries serially in one invocation without repetition or statistical aggregation; `--case` selects one. `timeoutMs` bounds runner execution and is also each individual check's budget, not a whole-run wall-clock or cost cap.
- **Workspace and retention.** Checks run after the harness stops and before the run root is removed; no full workspace snapshot, resource hash or general offline regrading is retained. Fixture symlinks are not a supported sharing mechanism; checks reject unsafe escapes, and file content reads are capped at 1 MiB.
- **Credentials and network.** Network egress is open during agent runs so harnesses reach their model providers; `check` sandboxes deny all network access. Credentials supplied to a run (in `login` files or process `environment`) are readable inside that run's sandbox and can appear in retained output if a tool prints them; a host-side credential proxy was verified for API keys (never subscription OAuth tokens) and remains deferred.
- **Process cleanup.** ACP and check sandboxes terminate all processes in the Seatbelt instance via a supervisor broadcast; the native `pi` runner tracks shell process groups rather than new-session escapes. Forced supervisor death (`SIGKILL` from outside) is not recoverable.
- **Extensions.** Extensions execute as trusted host code. Run-time resolution of `agent-evals` from an external `--extension-dir` is not automatic yet; see [Extensions](extensions.md#current-limits).

### Development and Build

- **Non-atomic checkout builds.** `npm run build` (invoked by `npm test`, `npm run check`, `npm run eval` and `npm pack`) replaces `dist/` in place. Serialize checkout build/test/eval/pack commands; for concurrent evaluations, install a packed tarball into a separate prefix ([Setup](setup.md#install-the-cli)).
- **Git hooks.** `npm ci` configures Husky: pre-commit checks ESLint and Prettier without rewriting files; pre-push runs `npm run check` against a clean worktree and outgoing `HEAD`.
- **Toolchain audit note.** Pinned dev dependency `minimatch@10.2.6` carries [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), accepted for reviewed level-1-only lint call paths (`optimizationLevel >= 2` with attacker-controlled patterns is unreachable). Reassess when an upstream fix lands without forcing a major override.
