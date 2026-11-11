# M1: Filesystem Evaluation

Status: implemented except for real-model smoke testing and independent review.

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

- [x] Create the minimal package, type-check/test commands, and one self-contained case with an empty initial workspace, an optional fixture field, and a small project-owned skill. Use it to settle the necessary YAML fields.
- [x] Load YAML through a real parser, resolve authoring assets relative to their configuration, discover trusted implementations, and reject invalid configurations before execution.
- [x] Atomically create a unique, neutrally named temporary run directory and copy the fixture without changing its source. Prepare separate per-run HOME, Pi configuration, and scratch directories.
- [x] Apply a deny-default Seatbelt policy: permit fixture-copy writes, read-only system/toolchain access, and explicitly scoped configuration, scratch, process, and model-access permissions. Exclude unrelated operator data, inherited production capabilities, and undeclared agent resources.
- [x] Drive Pi through RPC using the configured skill and input message. Keep case definitions, checkers, rubrics, candidate labels, and result records outside the evaluated agent's permitted data.
- [x] Stop the evaluated agent before checks. Keep the temporary initial baseline needed for `unchanged` outside the evaluated agent's writable area.
- [x] Implement `file` assertions: `exists`, regex-search `matches`, and `unchanged`. Return individual results; invalid regexes are configuration errors. Keep checks bounded, and do not retain an `includes` alias.
- [x] Implement `judge` with an independent Pi invocation over selected task/file context and rubric statements. Preserve per-statement results and distinguish invalid verdicts from failed checks.
- [x] Resolve check paths within the evaluated working directory rather than engine cwd. Reject unsafe paths and do not follow workspace symlinks into unrelated host files.
- [x] Save a small result record and useful failure diagnostics. Always clean up runtime processes and temporary directories on success, startup failure, timeout, cancellation, and checker failure. Never retain copied credentials as results.

## Acceptance

- [x] Write focused tests for each new behavior and prove they can fail with temporary mutations where practical.
- [x] Pass type checking, unit tests, real Seatbelt allow/deny tests, and controlled subprocess timeout/cleanup tests at normal suite concurrency.
- [ ] Confirm runner/judge models, thinking settings, and a small smoke-test budget before any real-model execution. Routine tests do not call models.
- [ ] After approval, verify one end-to-end case with Pi and both checkers. This proves integration, not that a skill improves behavior.
- [ ] Complete one bounded independent read-only review Task, fix confirmed findings, and document the commands actually verified.

## Delivered

- A TypeScript CLI runs one case and candidate: `node src/cli.ts --case <case.yml> --candidate <candidate.yml>`.
- `src/engine` loads and validates YAML, resolves configuration-relative authoring assets, discovers trusted implementations from explicit directories, orchestrates the run, and writes a small result record.
- `src/runners/pi` drives Pi through native RPC with one prompt and autonomous tool turns, bounded command and agent deadlines, process-group termination, and isolated HOME, Pi configuration, and scratch state.
- `src/platform/macos` renders a deny-default Seatbelt profile and launches the sandboxed process group. Reads are limited to declared system/toolchain paths and run state; writes to run state; outbound network is allowed for model access.
- `src/checkers/file` implements `exists`, regex-search `matches`, and `unchanged`, including ancestor and final-component symlink escape rejection.
- `src/checkers/judge` runs an independent, tool-free Pi invocation over the task and one file and preserves one result per rubric statement.
- `examples/write-file` is self-contained: an empty workspace, one English task message, one tiny project-owned skill, a case, and a candidate with placeholder models.
- The `pi` runner and `judge` checker accept an optional `envPassthrough` allowlist so an operator can supply narrowly scoped credentials without inheriting the invoking environment.

Run records are written to `.eval-results/<run-id>/result.json` by default, with bounded diagnostics beside them. The runtime directory is removed after success, failed start, timeout, cancellation, and checker failure; only the initial baseline needed by `unchanged` exists during the run.

## Verification

Run from the repository root:

```sh
npm run typecheck
npm test
```

The same gates passed from a clean clone after `npm ci` on Node 24.22.2 and macOS 15.5.

The suite includes:

- Real macOS Seatbelt probes that allow workspace reads/writes and deny reads, writes, and symlink escapes outside the workspace.
- A real Pi RPC startup and skill-loading probe under the Seatbelt profile, using `get_commands` with no model call.
- Deterministic fake Pi RPC processes for success, invalid protocol data, failed start, timeout, cancellation, owned-child termination, and SIGTERM escalation.
- Integration tests for success, failed checks, checker failures, cleanup, fixture preservation, baseline isolation for `unchanged`, configuration rejection before resource creation, different invocation working directories, and CLI signal cancellation.
- File-checker and judge-checker unit tests for their complete parameter and result behavior.

## Remaining Work

- Select runner and judge models, thinking settings, and a small smoke-test budget. The checked-in example deliberately uses placeholder models.
- Run one approved end-to-end case with real Pi and both checkers. This proves integration, not skill improvement.
- Confirm real model network behavior under the Seatbelt profile. The profile allows outbound network, but no live model traffic has been exercised; additional allowances may be required and should be derived from failure evidence.
- Complete independent read-only review and triage its findings.

### Known Limitations

- macOS only; no Linux or container backend.
- One initial user message and one case/candidate pair per invocation.
- Checks run after the agent stops but before workspace cleanup; full snapshots are not retained and results cannot be regraded after cleanup.
- Judge evidence is limited to one file. There is no generic evidence-reference language.
- The runner timeout bounds agent execution; each check receives the same budget, so total wall time can exceed it.
- Fixture symlinks are copied as symlinks. Checks reject escaping links, but they are not a supported way to share data.

## Trade-offs

- Checks run after the agent stops but before its temporary working directory is removed. Only the initial comparison data and small result records are required; those records alone cannot reconstruct filesystem checks after cleanup.
- One initial message keeps this delivery focused on execution, file changes, checks, and cleanup rather than interactive scenario scheduling.
- Direct Seatbelt keeps this milestone local to macOS and avoids adding a cross-platform execution SDK to the first implementation.
