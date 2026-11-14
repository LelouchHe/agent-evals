# Architecture

Agent Evals executes configured tests against agent systems. The engine is generic; the current evaluation runtime is deliberately narrow: one input message, a filesystem workspace, a native Pi RPC runner or the generic ACP runner, and file/judge checks on macOS. Standalone ACP configuration-query and login helpers share the ACP runner's environment setup.

This page explains how the implemented modules cooperate. [Configuration](configuration.md) owns the authoring/reference rules; [Roadmap](roadmap.md) owns the target shape and planned capabilities.

## Components and Connections

Evaluation commands (`run` / `view`):

```text
CLI: agent-evals / npm run eval (same dist/cli.js)
  |
  v
Authoring resolver: YAML + optional case selection -> ResolvedCase + origins
  |                                          |
  | view                                     | run
  v                                          v
Resolved configuration display            Registry: select runner/checkers by $type
(no harness or credentials)                  |
                                             v
                                   Engine: .env values -> Zod -> factories
                                             |
                                             v
                                   Independent runtime directories
                                             |
                                             v
                                   Runner -> harness -> file changes
                                             |
                                   Stop supported runtime processes
                                             |
                                             v
                                   Checkers -> individual judgments
                                             |
                                   Remove runtime -> save run record
```

Preparation commands (`config` / `login`) take standalone agent YAML and bypass case selection and the registry:

```text
CLI config/login
  -> Shared YAML + invocation .env expansion + ACP-owned Zod schema
  -> ACP helpers: HOME/login assembly and workflow
  -> macOS backend: policy, terminal permissions and supervised process
```

| Component          | Owns                                                                                             | Does not own                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| CLI                | Commands, arguments, built-in registration, trusted extension paths, signals, exit codes.        | Harness protocols or checker logic.                                           |
| Authoring resolver | Case selection, disjoint top-level composition, common structure, source annotations.            | Runtime readiness or provider authentication.                                 |
| Registry           | Mapping `$type` to a trusted definition.                                                         | Skill-specific modes or parameter interpretation.                             |
| Engine             | Parameter validation, preparation, runtime state, sequencing, cancellation, results and cleanup. | The business meaning of model, skill, rubric, or other implementation fields. |
| Runner             | Driving a harness and stopping its supported owned processes.                                    | Judging whether the task succeeded.                                           |
| Checker            | Reading available run evidence and producing checks.                                             | Driving the evaluated session.                                                |
| Platform module    | Seatbelt policy and sandboxed process launch.                                                    | YAML, tasks or rubric semantics.                                              |

## Definitions, Factories, and Instances

Definitions expose a `type`, a Zod `params` schema, and `create(params, context)`. Runner and checker are separate contracts.

1. The registry selects the definition by `$type`.
2. The engine substitutes parameter [placeholders](configuration.md#placeholders), then runs the declared schema once.
3. The factory receives ordinary typed fields plus the YAML declaring directory. It does not receive an environment-source or credential-lookup interface.
4. The instance keeps its parameters; execution receives only runtime state:

```text
Runner.run(RunnerContext)     -> RunnerOutcome
Runner.stop()                -> completion, safe to call again
Checker.check(CheckerContext) -> CheckResult[]
```

**The engine owns sourcing, declared-schema validation and lifecycle—not business meaning.** Schemas define parameter types, defaults and declared constraints. Implementations own their logic, operational requirements, authentication and outputs. The engine does not infer extra rules from names such as `apiKey`, proactively verify credentials, or automatically redact values.

Built-ins and trusted extensions share this path. Dynamic modules cross a localized type-erasure boundary; module authors own schema/factory consistency. Source interfaces live in [`registry.ts`](../src/engine/registry.ts).

## One Run, in Order

A run follows the test lifecycle in [Writing Cases](cases.md#the-test-model): set up the environment, act, collect observations, assert, tear down. Teardown runs even after failure. Today the runner stops its processes and the engine removes the single runtime root; components added later, such as mocks, pair their own setup and teardown.

1. **Load.** Resolve one case and preserve its declaration. Choose the run root's path without creating it. Select definitions; substitute placeholders from the invocation `.env` and the chosen run directories, validate schemas, create instances and validate the fixture. The engine never interprets provider/key names. [Configuration](configuration.md#placeholders) owns placeholder semantics.
2. **Set up.** Create the chosen root exclusively; an existing path is an error. The engine copies the fixture into `workspace` or starts empty, places each `files` entry on top, captures an initial `baseline`, and prepares independent `home`, `config` and `scratch`; source fixtures remain unchanged. The runner assembles its harness configuration, for Pi by staging selected skills with discovery disabled. The platform module builds the Seatbelt policy.
3. **Act.** The runner receives the input, directories, deadline and cancellation signal, and drives the harness. Pi runs its isolated RPC session under Seatbelt, with autonomous tool calls after one initial message.
4. **Collect.** Await supported runner teardown before checks; the runner returns its final text. Timeouts, cancellation and execution failures are not negative judgments. See [M1 limits](m1-plan.md#known-limitations).
5. **Assert.** Checkers inspect the still-live workspace/baseline. File regex work runs in a terminable worker; the judge reads selected evidence and starts a separate tool-free Pi invocation.
6. **Tear down and record.** Remove runtime state, then save outcomes, declared configuration and cleanup status. Early load errors need not produce a run record.

## Pi and Platform Composition

```text
Pi Runner --------------------+
                              v
                         Pi session helper -> JSONL RPC client
                              |
Judge Checker -> evidence ----+    (separate invocation, no tools)
                              |
                              v
                   macOS policy + sandbox-exec
                              |
                   in-sandbox supervisor -> Pi
                                             |
                                      shell wrapper -> shell tools
```

The judge reuses Pi transport/session mechanics, not the evaluated runner's session or the engine's full execution loop. The supervisor and shell wrapper cover tracked shell-process teardown inside the same Seatbelt instance. Registry files writable by the agent never authorize unsandboxed host signals.

The ACP runner and the standalone `config` and `login` preparation helpers live in [`runners/acp/`](../src/runners/acp/) and share one agent schema, HOME/login assembly and ACP session setup. These are implementation-owned; generic authoring/value-source/schema utilities are shared with cases. macOS system read roots, default command paths, terminal discovery and Seatbelt policy preparation stay in `platform/macos/`. Both use a sandbox-wide supervisor with a private completion pipe, not the native Pi shell registry. The runner assembles into the engine's run HOME and workspace; the helpers allocate their own temporary directory.

The host sandbox is a deliberate execution choice: real platform behavior is part of the subject being measured. Seatbelt is the current backend, not a claim that every OS has identical isolation guarantees.

## State and Trust Boundaries

- **Authoring assets:** operator-owned YAML, fixtures, skills and extensions. Config-relative resources resolve from the declaring file; executable extensions are not discovered from the agent-writable workspace. Extension code and `.env` lookup commands are trusted host code, not sandboxed test subjects.
- **Evaluated runtime:** writable workspace and explicitly permitted per-run state. The initial baseline, case/check definitions, rubric and retained results stay outside the evaluated agent's intended access.
- **Observations:** directory identity and path/symlink containment are checked before file reads. Non-regular and oversized evidence is an error, not a vacuous pass. A missing observation cannot prove a restraint was respected.
- **Results:** declarations, source/case identity, outcomes, diagnostics and cleanup. Expanded parameters do not replace the declaration; runtime outputs remain the implementation's responsibility. No full resource snapshot is retained.

Observations come from three sources defined in [Writing Cases](cases.md#why-the-trace-matters): the runner's trace (with output as its user-facing view), mock interaction records, and environment side effects. Currently the runner returns only final text, retained in the result but not checkable, and checkers observe files only. Trace and mocks are planned in the [Roadmap](roadmap.md#evidence-and-measurements).

## Source Map

| Area                          | Main source                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Entry point and display       | [`cli.ts`](../src/cli.ts), [`view.ts`](../src/engine/view.ts)                                                                    |
| Resolution and contracts      | [`authoring.ts`](../src/engine/authoring.ts), [`config.ts`](../src/engine/config.ts), [`registry.ts`](../src/engine/registry.ts) |
| Preparation and lifecycle     | [`params.ts`](../src/engine/params.ts), [`env-source.ts`](../src/engine/env-source.ts), [`run.ts`](../src/engine/run.ts)         |
| Files and retained records    | [`workspace.ts`](../src/engine/workspace.ts), [`results.ts`](../src/engine/results.ts)                                           |
| Harness adapter and transport | [`runners/pi/`](../src/runners/pi/)                                                                                              |
| ACP runner and helpers        | [`runners/acp/`](../src/runners/acp/)                                                                                            |
| Assertions and model judgment | [`checkers/file/`](../src/checkers/file/), [`checkers/judge/`](../src/checkers/judge/)                                           |
| OS enforcement and packaging  | [`platform/macos/`](../src/platform/macos/), [`build.mjs`](../scripts/build.mjs)                                                 |
