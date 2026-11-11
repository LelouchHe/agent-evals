# MVP Implementation

Build the smallest complete filesystem evaluation described by the [design principles](design.md). Start from scratch; reference earlier skill-eval lessons without importing its package or WebAgent machinery.

## Goal and Flow

Run one small skill case, check its filesystem changes, report the result, and clean up:

```text
Create a unique temporary directory
    -> Copy the fixture and prepare isolated runtime configuration
    -> Run Pi under Seatbelt
    -> Stop the evaluated agent and its owned child processes
    -> Run checks against the temporary working directory
    -> Save the result and clean up
```

Keep the repository private until this path is usable. Publication requires a separate user decision.

## Fixed Scope

- TypeScript on Node.js 24+, with Node's built-in test runner.
- Approved project-local dependencies: `yaml`, `typescript`, and `@types/node`. Commit a lockfile; no global installation.
- One Pi runner using native RPC, with no WebAgent dependency.
- macOS Seatbelt via `sandbox-exec`, with platform-specific launch code kept separate.
- Two checkers: `file` and `judge`. Use `$type` discovery and implementation-owned parameters, without a larger plugin framework.

## Work Items

- [ ] Create the minimal package, type-check/test commands, and one self-contained case with a fixture and a small project-owned skill. Use it to settle the necessary YAML fields.
- [ ] Load YAML through a real parser, resolve case-relative assets, discover trusted implementations, and reject invalid configurations before execution.
- [ ] Atomically create a unique, neutrally named temporary run directory and copy the fixture. Never modify the source fixture. Keep per-run HOME, Pi configuration, and scratch data separate from the task files.
- [ ] Apply a deny-default Seatbelt policy. Grant read/write access to the fixture copy, read-only system/toolchain access, and explicitly scoped per-run configuration, scratch, process, and model-access permissions. Do not grant unrelated operator-data access or inherit production capabilities and undeclared agent resources.
- [ ] Drive Pi through RPC using the configured skill and input message. Keep case definitions, checkers, rubrics, and result records outside the evaluated agent's permitted data.
- [ ] Stop the evaluated agent before checking files. Keep only the temporary initial baseline needed for `unchanged`; do not implement a full snapshot archive.
- [ ] Implement `file` assertions: `exists`, regex-search `matches`, and `unchanged`. Return individual results; invalid regexes are configuration errors. Keep checker execution bounded. Do not retain an `includes` alias.
- [ ] Implement `judge` with an independent Pi invocation over selected task/file context and rubric statements. Preserve per-statement results and distinguish invalid verdicts from failed checks.
- [ ] Resolve check paths within the evaluated working directory, not the engine's cwd. Reject unsafe paths and do not follow workspace symlinks into unrelated host files.
- [ ] Save a small result record and useful failure diagnostics. Always clean up runtime processes and temporary directories, including on startup failure, timeout, cancellation, or checker failure. Never retain copied credentials as results.

Checks run before the temporary working directory is removed. Rechecking after cleanup is not an MVP requirement.

## Verification

- [ ] Write focused failing tests before implementation where practical.
- [ ] Run type checking, unit tests, real Seatbelt allow/deny tests, and controlled subprocess timeout/cleanup tests at normal suite concurrency.
- [ ] Before real-model execution, confirm runner/judge models, thinking settings, and a small smoke-test budget. Routine tests do not call models.
- [ ] After approval, verify one end-to-end case with Pi and both checkers. This proves integration, not that a skill improves behavior.
- [ ] Complete one bounded independent read-only review Task, fix confirmed findings, and document the commands actually verified.

## Deferred

- Offline rechecking, full before/after archives, and persistent runtime evidence bundles.
- A unified tracer implementation, custom tracer plugins, and general evidence-reference syntax. Preserve this as a future design concern, not an MVP subsystem.
- Multi-turn scenarios, simulated users, generic ACP support, and WebAgent integration.
- Linux/Windows, MXC, Docker, VM execution, training pipelines, large sweeps, and advanced statistics.

Do not push or change repository visibility without user confirmation.
