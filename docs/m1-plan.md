# M1: Filesystem Evaluation

Status: the original filesystem runtime and its approved real-model smoke are complete. The single-file authoring revision is implemented and covered by model-free tests; it has not been live-model tested.

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
- Runtime dependencies: `yaml` and `zod`. Development dependencies: TypeScript, Node types, ESLint with its JavaScript/TypeScript configuration and Node globals, Prettier, and Husky. Keep installations project-local and commit the lockfile.
- A Pi runner using native RPC, with one initial user message and autonomous agent execution.
- Direct macOS Seatbelt enforcement through `sandbox-exec`, with platform-specific launch code kept separate.
- Two checkers: `file` and `judge`, selected through `$type` discovery with implementation-owned parameters.

## Implementation Steps

- [x] Create the minimal package, type-check/test commands, and one self-contained case with an empty initial workspace, an optional fixture field, and a small project-owned skill. Use it to settle the necessary YAML fields.
- [x] Load YAML through a real parser, resolve authoring assets relative to their configuration, discover trusted implementations, and reject invalid configurations before execution.
- [x] Atomically create a unique, neutrally named temporary run directory and copy the fixture without changing its source. Prepare separate per-run HOME, Pi configuration, and scratch directories.
- [x] Apply a deny-default Seatbelt policy: permit fixture-copy writes, read-only system/toolchain access, and explicitly scoped configuration, scratch, process, and model-access permissions. Exclude unrelated operator data, inherited production capabilities, and undeclared agent resources.
- [x] Drive Pi through RPC using the configured skill and input message. Keep case definitions, checkers, rubrics, case names, and result records outside the evaluated agent's permitted data.
- [x] Stop the evaluated agent before checks. Keep the temporary initial baseline needed for `unchanged` outside the evaluated agent's writable area.
- [x] Implement `file` assertions: `exists`, regex-search `matches`, and `unchanged`. Return individual results; invalid regexes are configuration errors. Keep checks bounded, and do not retain an `includes` alias.
- [x] Implement `judge` with an independent Pi invocation over selected task/file context and rubric statements. Preserve per-statement results and distinguish invalid verdicts from failed checks.
- [x] Resolve check paths within the evaluated working directory rather than engine cwd. Reject unsafe paths and do not follow workspace symlinks into unrelated host files.
- [x] Save a small result record and useful failure diagnostics. Always clean up runtime processes and temporary directories on success, startup failure, timeout, cancellation, and checker failure. Never retain copied credentials as results.

## Acceptance

These completed checks cover the original runtime. The authoring revision has its own pending acceptance below.

- [x] Write focused tests for each new behavior and prove they can fail with temporary mutations where practical.
- [x] Pass type checking, unit tests, real Seatbelt allow/deny tests, and controlled subprocess timeout/cleanup tests at normal suite concurrency.
- [x] Confirm runner/judge models, thinking settings, and a small smoke-test budget before any real-model execution. Routine tests do not call models.
- [x] After approval, verify one end-to-end case with Pi and both checkers. This proves integration, not that a skill improves behavior.
- [x] Complete one bounded independent read-only review Task, fix confirmed findings, and document the commands actually verified.

## Single-File Authoring Revision

Status: implemented. [Case Configuration](configuration.md) is the authoritative behavior specification. The historical smoke below still describes the original two-file format.

Acceptance:

- [x] Load one ordinary case or common fields plus named `cases` from a single file. Reject repeated top-level fields without recursive merging or overrides.
- [x] Reject YAML anchor declarations, alias nodes, and the scalar key `<<` in every mapping, quoted or not. Accept ordinary string values containing reuse-like text. Do not add `extends` or imported collections.
- [x] Require explicit selection for named cases, reject an empty `cases` mapping, and use non-empty string names only as metadata. Identify an ordinary case by its source path without a synthetic name.
- [x] Provide `view` through the execution resolver, annotating each top-level field with its source file, 1-based declaration line, and common/selected-case origin. Per-leaf annotations are not required. Do not start a harness, invoke a model, or require credentials; runtime validation remains separate.
- [x] Retain the resolved non-sensitive configuration, source path, and optional case name per run. Resource/fixture hashing and resource snapshots are not required and complete reproduction is not claimed.
- [x] Migrate the CLI and checked-in example to the single-file contract and update the commands actually supported; do not keep Candidate as a required authoring entity. Label the existing real-model smoke as validation of the original two-file format, not a live-model test of the migrated loader/example. Report the new format's model-free verification separately.
- [x] Add focused parser/resolver/selection/view/result tests and pass the complete model-free gate.
- [x] Complete the bounded independent implementation review of this revision and record its closure.

This revision does not authorize another live-model smoke or renew the earlier invocation budget; any such rerun requires explicit approval.

## Installable CLI

Status: implemented as a private local npm package from the same CLI source; not published, globally installed, or npm-linked.

- [x] `src/cli.ts` is the sole parser and command implementation. `npm run build` emits `dist/cli.js`; `npm run eval` and the installed `agent-evals` bin both execute that built entry point.
- [x] The build includes runtime assets that are executed separately from the main module: the regex worker, sandbox-resident supervisor, safe process-group helper, and shell wrapper.
- [x] The tarball allowlist contains only built runtime files, README, LICENSE, and package metadata; source, tests, docs, results, dev tooling, and generated logs are excluded.
- [x] A clean external checkout built and packed the tarball, and a disposable `npm install --prefix` succeeded without repository metadata, TypeScript, Husky, or global install; runtime dependencies resolved inside that install.
- [x] Complete cumulative independent review of the authoring and packaged-CLI revisions, with focused parent verification of the test-cleanup repair.

## Typed Implementation Parameters

Status: implemented with declarative Zod schemas. Raw YAML records remain unknown at the engine boundary; runner and checker definitions declare schemas that the engine validates once, then pass the inferred output to implementation instances.

- [x] Runner and checker definitions declare a Zod `params` schema and `create(params, authoringDir)` over the schema output type. `run`/`check` accept that inferred output, not raw records.
- [x] The registry and preparation path use one central `safeParseAsync` validation mechanism, translate schema issues into configuration errors with implementation/field paths, and bind the validated output to the matching instance. Built-ins and dynamically discovered definitions use the same path.
- [x] Built-in schemas are strict objects with explicit defaults and constraints. YAML typed scalars remain typed; no blanket coercion or stringify-all behavior. Quoted numbers/booleans and YAML 1.2 on/off/yes/no do not become booleans/numbers; explicit null is distinct from missing.
- [x] Operational readiness remains separate from schema conversion: `create` performs executable/platform/environment-presence/skill-access checks before runtime resources. `view` remains independent of schemas and readiness.
- [x] Result records retain the declared resolved YAML configuration, not schema defaults, compiled regexes, or other parsed output.
- [x] Compile-time fixtures prove schema-output inference/defaulted fields, raw-record rejection, mismatched schema/instance types, and no widening escape; runtime tests prove parse-once binding, independent runner/checker shapes, pre-instance failure, compiled parameter flow, and YAML/Zod compatibility.
- [x] Direct and trusted-discovery definitions invoke schema methods and `create` with the exported definition/schema as receiver, and instance `run`/`check`/`stop` methods retain their instance receiver.
- [ ] Cumulative independent review of this Zod schema-based parameter boundary remains pending.

## Delivered

- A TypeScript CLI resolves and runs or inspects one case. The installed command is `agent-evals run <config.yml> [--case <name>]` or `agent-evals view <config.yml> [--case <name>]`; the development form `npm run eval -- <command>` builds and executes the same `dist/cli.js`.
- `src/engine/authoring.ts` parses one YAML document with the installed `yaml` library, rejects unsupported reuse syntax and duplicate keys from the parsed structure, composes common and selected fields only when their top-level keys are disjoint, and records each final top-level field's source file, declaration line, and common/selected-case origin. Execution and `view` use this one resolver; `view` does not validate implementation parameters or readiness.
- `src/engine/registry.ts` defines typed `RunnerDefinition<P>`/`CheckerDefinition<P>` and `Runner<P>`/`Checker<P>` contracts. Definitions declare a Zod `params` schema and `create`; `src/engine/params.ts` centrally validates once and translates issues into configuration errors. External modules cross one documented runtime-shape/erasure boundary. Built-ins infer precise `pi`, `file`, and `judge` parameter types from their schemas.
- A run result retains the source path, optional case name, and the non-sensitive resolved configuration under `resolvedConfig`. Case names are metadata only and never escape the result-directory layout. Resource contents and environment values are not retained.
- `scripts/build.mjs` emits JavaScript under ignored `dist/` with normal TypeScript, copies the shell wrapper, and verifies the built CLI shebang. The package `bin` points at `dist/cli.js`; generated output is not committed.
- `src/engine` loads and validates YAML, resolves configuration-relative authoring assets, discovers trusted implementations from explicit directories, orchestrates the run, and writes a small result record.
- `src/runners/pi` drives Pi through native RPC with one prompt and autonomous tool turns, bounded command and agent deadlines, process-group termination, and isolated HOME, Pi configuration, and scratch state.
- `src/platform/macos` renders a deny-default Seatbelt profile and launches the sandboxed process group. Reads are limited to declared system/toolchain paths and run state; writes to run state; outbound network is allowed for model access.
- `src/checkers/file` implements `exists`, regex-search `matches`, and `unchanged`, including ancestor and final-component symlink escape rejection. Runs record the workspace directory's device and inode and reject a replaced root. Only regular files are evidence; FIFO and other non-regular paths are errors without a blocking open. Regex matching runs in a worker that is terminated on the check deadline or an internal 5-second ceiling. `unchanged` may only be `true` or omitted.
- `src/checkers/judge` runs an independent, tool-free Pi invocation over the task and one regular file and preserves one result per rubric statement.
- The Pi runner classifies a final assistant `stopReason: error` as an execution failure, including with pre-satisfied files, while ignoring recoverable intermediate retry errors.
- Pi bash commands use a generated custom shell wrapper. Ordinary background jobs stay in a tracked shell process group; the wrapper kills them before the command returns. A sandbox-resident Node supervisor wraps Pi, reads the agent-writable tracked-group registry, and terminates groups on timeout, cancellation, early Pi exit, and normal teardown. The supervisor runs inside Seatbelt, so forged registry entries can target only same-sandbox processes; the host never signals groups from registry data.
- `examples/write-file` is self-contained: an empty workspace, one English task message, one tiny project-owned skill, and one configuration file with `with-skill` and `without-skill` named cases. Both cases supply complete runner records, intentionally repeating the shared parameters, so neither depends on the common part for `runner`. Both model invocations select `opencode-go/deepseek-v4.1-flash`, omit thinking to use the default `medium`, and explicitly forward only `OPENCODE_API_KEY` as the provider credential.
- The `pi` runner and `judge` checker accept an optional `envPassthrough` allowlist so an operator can supply narrowly scoped credentials without inheriting the invoking environment.

Run records are written to `.eval-results/<run-id>/result.json` by default, with bounded diagnostics beside them. The runtime directory is removed after success, failed start, timeout, cancellation, and checker failure; only the initial baseline needed by `unchanged` exists during the run.

## Verification

Run the complete development gate from the repository root:

```sh
npm run check
```

This runs ESLint, Prettier checks, TypeScript checking, and tests. Husky checks lint/format before commits and the complete gate before pushes; see [Development](../README.md#development) for the hook boundaries.

On Node 24.22.2 and macOS 15.5, implementation `fc2b131` passed type checking and all 83 tests, including from a clean clone. Tooling commit `9d5e31b` subsequently passed the complete development gate with 91 tests and no failures or skips, both locally and after `npm ci` in an external clean clone. The clean install automatically configured repository-local Husky hooks, and dependency resolution was verified to stay within that installation.

Single-file implementation commit `dbb7b34` passed the complete gate with 104 tests and no failures or skips at normal suite concurrency. The same commit was cloned to an external `/tmp` checkout outside the repository's module-resolution ancestry; `npm ci` and `npm run check` both exited 0 with the same 104 passing tests. The resolved `yaml` module path was inside that checkout's own `node_modules`, so the run did not fall back to the source worktree. No model, remote provider, or credential value was used.

Packaged-CLI commit `9accfad` passed the complete gate with 107 tests and no failures or skips at normal concurrency. A clean external clone of that commit passed `npm ci` (including repository-local Husky setup) and `npm run check`, then built and packed the package. A disposable `npm install --prefix` of the local tarball succeeded without repository metadata, TypeScript, Husky, dev dependencies, or global install. The installed `agent-evals` command ran `--help`, `view` with no provider credential or `pi` on `PATH`, and a deterministic fake-runtime `run`; `yaml` resolved inside that installation, and packaged supervisor/helper/worker/wrapper assets were exercised by the run. Installed and `npm run eval` help/view output matched exactly. No model, remote provider, or credential value was used.

CLI test-cleanup repair `eefdff0` passed the complete gate with 109 tests and no failures or skips. The shared authoring/package CLI test helper now registers cleanup at child creation, observes the enclosing test signal by default, enforces a local deadline, and stops the child process group with SIGTERM then SIGKILL before settling. A synthetic child kept alive until the deadline proved a timed-out helper leaves no live child and lets the test process exit promptly; another synthetic child verified graceful SIGTERM cancellation. An external outer-deadline probe with a 600ms test timeout exited in under a second with its synthetic child reaped. The repair is test-only; production CLI and package behavior are unchanged. A clean external clone of the final documentation commit passed `npm ci` and `npm run check` with the same 109 tests.

Typed-parameter refactor `4856ad3` passed the complete gate with 112 tests and no failures or skips. The compile-time contract fixtures reject raw records, missing or wrong parsed fields, mismatched parse/instance types, and accidental widening to `unknown`; weakening runner/checker parameter variance makes those checks fail. Runtime tests show synchronous and asynchronous parsing, one parse per runner/checker, distinct parsed shapes bound to their own instances, parse failure before instance creation, and compiled file/parser values reaching execution. Mutation proofs reintroduced reparse calls in the file, Pi, and judge built-ins and normalized a result configuration; each was rejected by the focused tests. Declared `resolvedConfig` retains no `resolvedExecutable` or compiled parser fields. A clean external clone of the final documentation commit passed `npm ci` and `npm run check` with the same 112 tests.

External-definition receiver repair `d701b86` passed the complete gate with 114 tests and no failures or skips. Trusted discovery now invokes `parse` and `create` as methods of the exported definition, matching direct registration. Regressions load actual trusted-directory `.mjs` modules for both runner and checker stages, assert the definition itself is the receiver, check parse/create are called once, and verify instance `run`/`check`/`stop` receivers. The same receiver-dependent module also runs through the final tarball's disposable external install. A clean external clone of the final documentation commit passed `npm ci` and `npm run check` with the same 114 tests.

Zod parameter-schema revision `ddd9c87` passed the complete gate with 120 tests and no failures or skips. It pins `zod@4.6.7` as a runtime dependency. Built-in and external definitions now declare `params` schemas plus `create(params, authoringDir)`; the engine validates each raw YAML-derived record once through the central `safeParseAsync` path, translates issues with implementation/field paths, and binds only inferred output to instances. Real YAML-to-Zod tests cover ordinary and named cases, typed scalars, quoted numbers/booleans, YAML 1.2 on/off/yes/no, false/zero/empty arrays, missing versus explicit null, strict unknown fields, nested paths, enum/default behavior, and `.nan`/`.inf` rejection. Mutation proofs removed type/constraint enforcement, coercion guards, defaults, strictness, validation-once, raw result retention, and schema/create receivers; each mutation failed the focused tests. A clean external clone of the implementation commit passed `npm ci` and `npm run check` with 120 tests. The final tarball installed with `yaml` and `zod` resolving inside the disposable prefix; installed built-in file/regex/judge execution passed, and a schema-defined external runner/checker using a separate copied Zod module preserved schema/create/instance receivers, validated typed values, and raw declared `resolvedConfig`. No model or credential was used.

### Review Closure

- Independent read-only review covered `98d0b83..f44d29b`. Its six concrete findings were repaired in `c28bcd3`: replaced-root containment, ordinary background-process cleanup, FIFO evidence, final provider-error classification, regex execution bounds, and `unchanged: false` rejection.
- Focused independent closure confirmed those original reproducers were addressed and identified a repair-introduced host-signaling capability through the writable process-group registry. `fc2b131` removed that host consumer and moved cleanup into the same Seatbelt instance as Pi.
- Parent verification inspected the final authority boundary and reran `npm run typecheck` and `npm test`. A separate real Pi RPC/Seatbelt probe confirmed that a forged registry entry neither killed nor stopped an unrelated synthetic process: its heartbeat continued after teardown, while the owned shell was terminated. No model, network, or credentials were used.
- Independent review of tooling range `d84cc23..9d5e31b` found no material introduced defects and independently passed all eight real Git-hook tests. The temporary, reviewed `minimatch` advisory treatment and its reassessment triggers are recorded in [Development](../README.md#development).
- The independent Claude implementation review covered `71c9fdc..a87347f` and found no push-blocking issue. The parent separately reviewed the test-only repair `a87347f..a656ff8`, reran both focused cleanup regressions, and repeated the actual-helper outer-timeout probe: a 600ms test deadline exited in approximately 705ms with its synthetic child reaped.
- Parent artifact verification at `a656ff8` used a fresh external checkout, local tarball, and production-only disposable installation. All 25 tarball entries were runtime/package files; `yaml` resolved inside the install; installed and npm help/view output matched; direct installed view needed only Node on PATH; and an installed fake-runtime run passed all eight file/worker/judge checks with cleanup and no retained synthetic secret.
- Review dispositions: the range-introduced non-atomic development build is accepted as an M1 operational limit, with serialized checkout commands documented in [Development](../README.md#development). A no-model concurrent-build/view probe reproduced missing-module failures; using a separate installed prefix avoids that checkout's changing `dist/`. No atomic build/generation mechanism was added.
- Non-blocking follow-ups remain: parser warnings for unknown YAML tags are not surfaced as errors, and control characters in case names are not escaped in human-readable output. The review also confirmed the temporary supervisor's dependence on Node module-syntax detection is pre-existing, not introduced by this range. These observations do not extend the authoring scope or imply fixes were made.
- The post-edit result re-read in the retention test is retained as a consistency guard, not counted as independent behavioral proof; the direct `resolvedConfig` value assertions and their omission mutation provide the meaningful retention evidence. No existing test was deleted.
- Parent review of typed-parameter range `2399d73..47bbce4` confirmed the generic function-property contracts, opaque prepared closures, parse-once execution, unchanged `view` boundary, and declared result semantics. It found one introduced defect: trusted-discovery adapters detached `parse` and `create` from their exported definition. Four independent probes isolated both stages for runners and checkers; direct registration succeeded while discovery lost the receiver.
- Focused closure of `47bbce4..12d8031` confirmed that `d701b86` preserves definition and instance receivers. Parent verification from a fresh external checkout of `12d8031` passed `npm ci` and `npm run check` with 114 tests, no failures or skips, then packed and installed the actual tarball with production dependencies only. A separate installed external runner/checker probe confirmed exact receiver identity, one parse/create/execution each, distinct normalized payloads, unchanged declared `resolvedConfig`, and runtime cleanup. The installed built-in fake-runtime path also passed all eight file/worker/judge checks; npm/bin help and view remained identical. No model or credential was used.
- This closes the reviewed concrete mechanisms, not universal containment of arbitrary child processes. The successful historical real-model smoke below does not remove the documented capability limits.

### Single-File Revision Verification

- The model-free suite exercised the real installed `yaml` parser, source positions, duplicate-key errors, and forbidden anchor/alias/`<<` structures at root and nested locations.
- Real macOS Seatbelt probes and installed-Pi RPC bash/skill probes passed without prompts, model calls, network, or credentials. Deterministic fake RPC executables covered `run` integration, `view`/`run` payload equality, credential-free `view`, harness-canary non-invocation, and retained resolved-configuration values.
- The packaged `agent-evals` bin and `npm run eval` produced identical help and view output. The clean local tarball installed without dev dependencies or Git metadata; its installed run verified the generated supervisor, safe-process-group, shell wrapper, regex worker, file checks, and independent fake judge.
- Independent review and parent-focused closure are recorded above. The implementation and packaged artifact remain model-free validated; the original two-file live smoke is not evidence of live-model validation for this migration.

### Real-Model Smoke

The approved `write-file` example passed in one evaluation invocation on 2026-11-11 using the original two-file format. The old CLI invocation was:

```sh
npm run eval -- --case examples/write-file/case.yml --candidate examples/write-file/candidate.yml
```

That command shape is no longer accepted after the single-file migration. This historical smoke proves the original two-file runtime integration, checks, and cleanup; it is not a live-model test of the migrated single-file loader or example, whose coverage is model-free only.

- Runner and judge: `opencode-go/deepseek-v4.1-flash`, each in its own isolated Pi invocation, default thinking `medium`, 120-second execution budget per invocation. The evaluation was not automatically rerun.
- Result: `pass` in approximately 30 seconds; the runner completed in approximately 25 seconds. File existence, regex content matching, and the independent judge criterion all passed. Diagnostics were empty.
- Cleanup: the runtime directory was removed, and a post-run process check found no remaining evaluation supervisors or shell wrappers. No additional Seatbelt permissions were needed.
- Credentials: only the selected provider key was injected in memory through `OPENCODE_API_KEY`; personal authentication/configuration files were not copied into the run, and the retained result did not contain the key.
- Result record: `.eval-results/2026-11-11T15-06-44-228Z-898d5cc9/result.json` (ignored by Git). The workspace was not retained. Token usage and monetary cost were not measured; this smoke used invocation/time limits rather than a hard cost cap.

This verifies the execution/checking/cleanup integration, not skill effectiveness or support for arbitrary provider endpoints. Routine test gates remain model-free.

### Test Coverage

The suite includes:

- Real macOS Seatbelt probes that allow workspace reads/writes and deny reads, writes, and symlink escapes outside the workspace.
- A real Pi RPC startup and skill-loading probe under the Seatbelt profile, using `get_commands` with no model call.
- Real installed-Pi RPC bash probes under Seatbelt: ordinary background jobs are terminated before the command returns; an active wrapper shell group is terminated on session stop; output and exit status survive the wrapper; an early Pi death still cleans tracked groups. No prompt, model, network, or credentials are used.
- A real installed-Pi RPC bash registry-forgery probe: the agent writes an unrelated synthetic detached group's id into the state directory; the external victim survives teardown, while owned groups are still cleaned. Special/broadcast numeric names are rejected by validation, not by sending real signals.
- Real Seatbelt root-replacement and FIFO probes through file and judge checks.
- Deterministic fake Pi RPC processes for success, invalid protocol data, failed start, final provider error, error-then-success retry, timeout, cancellation, owned-child termination, and SIGTERM escalation.
- Integration tests for success, failed checks, checker failures, cleanup, fixture preservation, baseline isolation for `unchanged`, a replaced workspace root, FIFO evidence, pathological regex bounds, configuration rejection before resource creation, different invocation working directories, and CLI signal cancellation.
- Authoring parser/resolver tests against real YAML source positions: ordinary and named documents, explicit selection, empty or invalid case maps and names, common/selected collisions including identical values and nested-only differences, sibling independence, forbidden anchors/aliases/`<<` at nested positions, quoted and literal reuse-like text, duplicate keys, malformed shapes, incomplete fragments, and metadata-only names.
- CLI integration for `view` and fake-runtime `run` from another working directory. `view` succeeds with `pi` unavailable and no provider credential, does not launch a harness canary, does not print an environment secret, and shows expected declaration lines. `view` and `run` are compared through the same resolved payload. A retained result is checked after the YAML is edited, and a path-like case name does not control the result location.
- Packaged-artifact tests assert the `bin` and `eval` script use the same built entry, source and built help/view output match, and required generated assets include the regex worker, supervisor, safe-group helper, and shell wrapper. A deterministic fake-runtime run through the built CLI exercises those packaged assets, file checks, the regex worker, and an independent fake judge.
- Typed implementation tests cover compile-time schema-output inference/defaults, raw-record rejection, mismatched schema/instance types, and accidental widening to `unknown`; runtime tests cover synchronous and asynchronous schemas, validation-once binding, independent runner/checker shapes, schema failure before instance creation, compiled file-checker parameters, and declared configuration retained in results.
- Real YAML-to-Zod compatibility tests cover ordinary and named cases, numbers/booleans/strings/arrays/nested maps, quoted scalars and YAML 1.2 on/off/yes/no, false/zero/empty arrays, missing versus explicit null, nullable fields, enum/default/unknown fields, nested paths, and `.nan`/`.inf` finite rejection.
- The new authoring/package CLI tests share a bounded child-runner helper with creation-time cleanup, test-signal cancellation, a local deadline, and SIGTERM-then-SIGKILL reaping. A real synthetic child kept alive until the deadline verifies both timeout and cancellation cleanup without leaving the suite pinned.
- File-checker and judge-checker unit tests for their complete parameter and result behavior.
- Real Git/Husky hook tests with isolated local bare remotes: valid commit/push, lint and formatting rejection without rewriting files, type and runtime-test failure rejection, and safeguards against validating a dirty worktree or a different outgoing commit.

## Known Limitations

- macOS only; no Linux or container backend.
- One initial user message and one resolved case per invocation.
- Checkout development builds replace shared `dist/` non-atomically. Do not overlap checkout-based evaluations with build/test/pack/check/push; use a separate installed package prefix for concurrent runs.
- The installable CLI is a Node.js package rather than a self-contained executable; it requires Node.js 24+, its declared `yaml` and `zod` dependencies, the packaged `dist/` layout, and macOS Seatbelt for execution.
- Dynamically imported runner/checker modules are untyped at the engine boundary. Runtime capability checks verify `type`, a Zod `params` schema via its `safeParseAsync` method (including a separate installed Zod copy), and `create`; the module remains responsible for keeping schema output and instance parameter type consistent. `view` does not validate implementation parameters or readiness.
- Checks run after the agent stops but before workspace cleanup; full snapshots are not retained and results cannot be regraded after cleanup.
- Judge evidence is limited to one file. There is no generic evidence-reference language.
- Model networking was smoke-tested only with the example's OpenCode Go endpoint; other providers/endpoints remain unverified.
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
