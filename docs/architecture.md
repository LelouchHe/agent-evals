# Architecture

Agent Evals executes configured tests against agent systems. The engine is generic; the current runtime is deliberately narrow: one input message, a filesystem workspace, a Pi RPC runner, and file/judge checks on macOS.

This page explains how the implemented modules cooperate. [Configuration](configuration.md) owns the authoring/reference rules; [Roadmap](roadmap.md) owns the target shape and planned capabilities.

## Components and Connections

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
                                   Engine: Zod validation -> factories
                                             |                 |
                                             |                 +-> run-scoped credentials
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

Runner and checker definitions each expose a `type`, a Zod `params` schema, and a `create(params, context)` factory. They are separate contracts, not subclasses of one universal plugin.

1. The registry returns the selected definition.
2. The engine removes `$type` and validates the remaining record with that definition's schema, once.
3. The factory receives the inferred schema output plus an `ImplementationContext`: the declaring directory and run-scoped credential access.
4. The factory checks operational prerequisites and returns an instance that keeps its parameters and setup state.
5. The engine supplies only runtime context to the instance:

```text
Runner.run(RunnerContext)   -> RunnerOutcome
Runner.stop()              -> completion, safe to call again
Checker.check(CheckerContext) -> CheckResult[]
```

Schema validation handles parameter types, constraints, transformations and defaults. Factories handle readiness such as tool availability, skill accessibility and credential resolution. Execution does not reparse the original record. The engine never switches on a runner's business fields.

Built-ins and trusted extensions follow the same path. A runner module exports `runner`; a checker module exports `checker`. Dynamic imports cross a localized runtime/type-erasure boundary; module authors remain responsible for schema/factory type consistency. Definitions and instances keep their method receivers. Full TypeScript contracts live in [`registry.ts`](../src/engine/registry.ts).

## One Run, in Order

1. **Resolve and prepare.** Load one case and preserve its declared configuration. Select definitions, validate schemas, create instances and validate the fixture before allocating the evaluated runtime. A shared, lazy credential source serves factories; the Pi implementation chooses which provider key to request. Its source and command rules are in [Credentials](../README.md#credentials).
2. **Create independent state.** Make an atomic, neutrally named temporary root. Copy the fixture into `workspace` or start empty. Capture an initial `baseline`, and prepare separate `home`, `config`, and `scratch` directories. Source fixtures are not modified.
3. **Execute.** The runner receives the task, directories, deadline and cancellation signal. Pi-specific preparation stages explicitly selected skills and launches the isolated session under Seatbelt. The agent may make autonomous tool calls after the single initial message.
4. **Stop before observing.** Await runner teardown before checks. A timeout, cancellation or execution failure is not an ordinary failed assertion. The supported process-cleanup boundary is documented in [M1 limits](m1-plan.md#known-limitations).
5. **Check while state exists.** Each checker gets the task, prepared workspace/baseline roots, and its own budget/signal. The file checker reads regular files safely and evaluates regexes in a terminable worker. The judge reads selected evidence, then starts an independent tool-free Pi invocation.
6. **Clean and record.** Remove the temporary root, include cleanup status, and write the small run record. Configuration/preparation errors can occur before a runtime or result record exists. Checks are not rerun after teardown.

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

The host sandbox is a deliberate execution choice: real platform behavior is part of the subject being measured. Seatbelt is the current backend, not a claim that every OS has identical isolation guarantees.

## State and Trust Boundaries

- **Authoring assets:** operator-owned YAML, fixtures, skills and extensions. Config-relative resources resolve from the declaring file; executable extensions are not discovered from the agent-writable workspace. Extension code and `.env` lookup commands are trusted host code, not sandboxed test subjects.
- **Evaluated runtime:** writable workspace and explicitly permitted per-run state. The initial baseline, case/check definitions, rubric and retained results stay outside the evaluated agent's intended access.
- **Observations:** directory identity and path/symlink containment are checked before file reads. Non-regular and oversized evidence is an error, not a vacuous pass. A missing observation cannot prove a restraint was respected.
- **Results:** declared non-sensitive configuration, source path/case identity, runner outcome, individual checks, diagnostics and cleanup status. Schema defaults/output and credential values do not replace the declaration. No full resource snapshot is retained.

Messages are invocation input/output; files, environment variables and service state are environment observations. Current checkers consume task/file state; the runner's final text is retained in the result but is not a general message/event evidence interface. Planned evidence collection belongs in the [Roadmap](roadmap.md#evidence-and-measurements).

## Source Map

| Area                          | Main source                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Entry point and display       | [`cli.ts`](../src/cli.ts), [`view.ts`](../src/engine/view.ts)                                                                    |
| Resolution and contracts      | [`authoring.ts`](../src/engine/authoring.ts), [`config.ts`](../src/engine/config.ts), [`registry.ts`](../src/engine/registry.ts) |
| Preparation and lifecycle     | [`params.ts`](../src/engine/params.ts), [`credentials.ts`](../src/engine/credentials.ts), [`run.ts`](../src/engine/run.ts)       |
| Files and retained records    | [`workspace.ts`](../src/engine/workspace.ts), [`results.ts`](../src/engine/results.ts)                                           |
| Harness adapter and transport | [`runners/pi/`](../src/runners/pi/)                                                                                              |
| Assertions and model judgment | [`checkers/file/`](../src/checkers/file/), [`checkers/judge/`](../src/checkers/judge/)                                           |
| OS enforcement and packaging  | [`platform/macos/`](../src/platform/macos/), [`build.mjs`](../scripts/build.mjs)                                                 |
