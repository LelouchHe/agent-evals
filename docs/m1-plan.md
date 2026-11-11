# M1: Filesystem Evaluation

Status: implemented. The bounded independent review, repairs, and focused closure verification are complete. Real-model smoke testing remains pending.

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
- Runtime dependency: `yaml`. Development dependencies: TypeScript, Node types, ESLint with its JavaScript/TypeScript configuration and Node globals, Prettier, and Husky. Keep installations project-local and commit the lockfile.
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
- [x] Complete one bounded independent read-only review Task, fix confirmed findings, and document the commands actually verified.

## Delivered

- A TypeScript CLI runs one case and candidate: `node src/cli.ts --case <case.yml> --candidate <candidate.yml>`.
- `src/engine` loads and validates YAML, resolves configuration-relative authoring assets, discovers trusted implementations from explicit directories, orchestrates the run, and writes a small result record.
- `src/runners/pi` drives Pi through native RPC with one prompt and autonomous tool turns, bounded command and agent deadlines, process-group termination, and isolated HOME, Pi configuration, and scratch state.
- `src/platform/macos` renders a deny-default Seatbelt profile and launches the sandboxed process group. Reads are limited to declared system/toolchain paths and run state; writes to run state; outbound network is allowed for model access.
- `src/checkers/file` implements `exists`, regex-search `matches`, and `unchanged`, including ancestor and final-component symlink escape rejection. Runs record the workspace directory's device and inode and reject a replaced root. Only regular files are evidence; FIFO and other non-regular paths are errors without a blocking open. Regex matching runs in a worker that is terminated on the check deadline or an internal 5-second ceiling. `unchanged` may only be `true` or omitted.
- `src/checkers/judge` runs an independent, tool-free Pi invocation over the task and one regular file and preserves one result per rubric statement.
- The Pi runner classifies a final assistant `stopReason: error` as an execution failure, including with pre-satisfied files, while ignoring recoverable intermediate retry errors.
- Pi bash commands use a generated custom shell wrapper. Ordinary background jobs stay in a tracked shell process group; the wrapper kills them before the command returns. A sandbox-resident Node supervisor wraps Pi, reads the agent-writable tracked-group registry, and terminates groups on timeout, cancellation, early Pi exit, and normal teardown. The supervisor runs inside Seatbelt, so forged registry entries can target only same-sandbox processes; the host never signals groups from registry data.
- `examples/write-file` is self-contained: an empty workspace, one English task message, one tiny project-owned skill, a case, and a candidate with placeholder models.
- The `pi` runner and `judge` checker accept an optional `envPassthrough` allowlist so an operator can supply narrowly scoped credentials without inheriting the invoking environment.

Run records are written to `.eval-results/<run-id>/result.json` by default, with bounded diagnostics beside them. The runtime directory is removed after success, failed start, timeout, cancellation, and checker failure; only the initial baseline needed by `unchanged` exists during the run.

## Verification

Run the complete development gate from the repository root:

```sh
npm run check
```

This runs ESLint, Prettier checks, TypeScript checking, and tests. Husky checks lint/format before commits and the complete gate before pushes; see [Development](../README.md#development) for the hook boundaries.

On Node 24.22.2 and macOS 15.5, implementation `fc2b131` passed type checking and all 83 tests, including from a clean clone. Tooling commit `9d5e31b` subsequently passed the complete development gate with 91 tests and no failures or skips, both locally and after `npm ci` in an external clean clone. The clean install automatically configured repository-local Husky hooks, and dependency resolution was verified to stay within that installation.

### Review Closure

- Independent read-only review covered `98d0b83..f44d29b`. Its six concrete findings were repaired in `c28bcd3`: replaced-root containment, ordinary background-process cleanup, FIFO evidence, final provider-error classification, regex execution bounds, and `unchanged: false` rejection.
- Focused independent closure confirmed those original reproducers were addressed and identified a repair-introduced host-signaling capability through the writable process-group registry. `fc2b131` removed that host consumer and moved cleanup into the same Seatbelt instance as Pi.
- Parent verification inspected the final authority boundary and reran `npm run typecheck` and `npm test`. A separate real Pi RPC/Seatbelt probe confirmed that a forged registry entry neither killed nor stopped an unrelated synthetic process: its heartbeat continued after teardown, while the owned shell was terminated. No model, network, or credentials were used.
- Independent review of tooling range `d84cc23..9d5e31b` found no material introduced defects and independently passed all eight real Git-hook tests. The temporary, reviewed `minimatch` advisory treatment and its reassessment triggers are recorded in [Development](../README.md#development).
- This closes the reviewed concrete mechanisms, not universal containment of arbitrary child processes. The limitations below and real-model smoke acceptance remain separate.

### Test Coverage

The suite includes:

- Real macOS Seatbelt probes that allow workspace reads/writes and deny reads, writes, and symlink escapes outside the workspace.
- A real Pi RPC startup and skill-loading probe under the Seatbelt profile, using `get_commands` with no model call.
- Real installed-Pi RPC bash probes under Seatbelt: ordinary background jobs are terminated before the command returns; an active wrapper shell group is terminated on session stop; output and exit status survive the wrapper; an early Pi death still cleans tracked groups. No prompt, model, network, or credentials are used.
- A real installed-Pi RPC bash registry-forgery probe: the agent writes an unrelated synthetic detached group's id into the state directory; the external victim survives teardown, while owned groups are still cleaned. Special/broadcast numeric names are rejected by validation, not by sending real signals.
- Real Seatbelt root-replacement and FIFO probes through file and judge checks.
- Deterministic fake Pi RPC processes for success, invalid protocol data, failed start, final provider error, error-then-success retry, timeout, cancellation, owned-child termination, and SIGTERM escalation.
- Integration tests for success, failed checks, checker failures, cleanup, fixture preservation, baseline isolation for `unchanged`, a replaced workspace root, FIFO evidence, pathological regex bounds, configuration rejection before resource creation, different invocation working directories, and CLI signal cancellation.
- File-checker and judge-checker unit tests for their complete parameter and result behavior.
- Real Git/Husky hook tests with isolated local bare remotes: valid commit/push, lint and formatting rejection without rewriting files, type and runtime-test failure rejection, and safeguards against validating a dirty worktree or a different outgoing commit.

## Remaining Work

- Select runner and judge models, thinking settings, and a small smoke-test budget. The checked-in example deliberately uses placeholder models.
- Run one approved end-to-end case with real Pi and both checkers. This proves integration, not skill improvement.
- Confirm real model network behavior under the Seatbelt profile. The profile allows outbound network, but no live model traffic has been exercised; additional allowances may be required and should be derived from failure evidence.

### Known Limitations

- macOS only; no Linux or container backend.
- One initial user message and one case/candidate pair per invocation.
- Checks run after the agent stops but before workspace cleanup; full snapshots are not retained and results cannot be regraded after cleanup.
- Judge evidence is limited to one file. There is no generic evidence-reference language.
- The runner timeout bounds agent execution; each check receives the same budget, so total wall time can exceed it.
- Fixture symlinks are copied as symlinks. Checks reject escaping links, but they are not a supported way to share data.
- Background-process cleanup covers ordinary jobs in the Pi shell's tracked process groups. A child that deliberately creates a new session or process group (`setsid` or equivalent) is outside this contract.
- If the in-sandbox supervisor is itself killed with `SIGKILL` before cleanup, tracked-group cleanup is not guaranteed. The host does not fall back to signaling groups from untrusted registry data.
- The shell-group registry is not an authorization boundary. It is agent-writable input to the in-sandbox supervisor, whose signals are restricted by Seatbelt to the same sandbox; special/broadcast targets are rejected before signaling.
- Regex evaluation is bounded by worker termination, not by proving a pattern's complexity. The accepted semantics remain JavaScript regex search.

## Trade-offs

- Checks run after the agent stops but before its temporary working directory is removed. Only the initial comparison data and small result records are required; those records alone cannot reconstruct filesystem checks after cleanup.
- One initial message keeps this delivery focused on execution, file changes, checks, and cleanup rather than interactive scenario scheduling.
- Direct Seatbelt keeps this milestone local to macOS and avoids adding a cross-platform execution SDK to the first implementation.
