# M1: Filesystem Evaluation

Status: planned.

## Goal

Complete one local skill-evaluation run: copy a fixture, let Pi modify it under Seatbelt, inspect the result with `file` and `judge`, report the checks, and clean up.

```text
Create a unique temporary directory
    -> Copy the fixture and prepare isolated runtime configuration
    -> Run Pi under Seatbelt
    -> Stop the evaluated agent and its owned child processes
    -> Check the temporary working directory
    -> Save the result and clean up
```

The overall model is described in [architecture](architecture.md); case authoring conventions are in [cases](cases.md).

## Implementation Choices

- TypeScript on Node.js 24+, with Node's built-in test runner.
- Approved project-local dependencies: `yaml`, `typescript`, and `@types/node`. Commit a lockfile; no global installation.
- A Pi runner using native RPC, with one initial user message and autonomous agent execution.
- Direct macOS Seatbelt enforcement through `sandbox-exec`, with platform-specific launch code kept separate.
- Two checkers: `file` and `judge`, selected through `$type` discovery with implementation-owned parameters.

## Implementation Steps

- [ ] Create the minimal package, type-check/test commands, and one self-contained case with a fixture and a small project-owned skill. Use it to settle the necessary YAML fields.
- [ ] Load YAML through a real parser, resolve authoring assets relative to their configuration, discover trusted implementations, and reject invalid configurations before execution.
- [ ] Atomically create a unique, neutrally named temporary run directory and copy the fixture without changing its source. Prepare separate per-run HOME, Pi configuration, and scratch directories.
- [ ] Apply a deny-default Seatbelt policy: permit fixture-copy writes, read-only system/toolchain access, and explicitly scoped configuration, scratch, process, and model-access permissions. Exclude unrelated operator data, inherited production capabilities, and undeclared agent resources.
- [ ] Drive Pi through RPC using the configured skill and input message. Keep case definitions, checkers, rubrics, candidate labels, and result records outside the evaluated agent's permitted data.
- [ ] Stop the evaluated agent before checks. Keep the temporary initial baseline needed for `unchanged` outside the evaluated agent's writable area.
- [ ] Implement `file` assertions: `exists`, regex-search `matches`, and `unchanged`. Return individual results; invalid regexes are configuration errors. Keep checks bounded, and do not retain an `includes` alias.
- [ ] Implement `judge` with an independent Pi invocation over selected task/file context and rubric statements. Preserve per-statement results and distinguish invalid verdicts from failed checks.
- [ ] Resolve check paths within the evaluated working directory rather than engine cwd. Reject unsafe paths and do not follow workspace symlinks into unrelated host files.
- [ ] Save a small result record and useful failure diagnostics. Always clean up runtime processes and temporary directories on success, startup failure, timeout, cancellation, and checker failure. Never retain copied credentials as results.

## Acceptance

- [ ] Write focused failing tests before implementation where practical.
- [ ] Pass type checking, unit tests, real Seatbelt allow/deny tests, and controlled subprocess timeout/cleanup tests at normal suite concurrency.
- [ ] Confirm runner/judge models, thinking settings, and a small smoke-test budget before any real-model execution. Routine tests do not call models.
- [ ] After approval, verify one end-to-end case with Pi and both checkers. This proves integration, not that a skill improves behavior.
- [ ] Complete one bounded independent read-only review Task, fix confirmed findings, and document the commands actually verified.

## Trade-offs

- Checks run after the agent stops but before its temporary working directory is removed. Only the initial comparison data and small result records are required; those records alone cannot reconstruct filesystem checks after cleanup.
- One initial message keeps this delivery focused on execution, file changes, checks, and cleanup rather than interactive scenario scheduling.
- Direct Seatbelt keeps this milestone local to macOS and avoids adding a cross-platform execution SDK to the first implementation.
