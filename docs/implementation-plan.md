# Filesystem Evaluation MVP

Implement one complete evaluation path before expanding the framework. This plan follows the [design principles](design.md); it does not import the previous skill-eval implementation or its upstream dependencies.

## Goal

Run one small skill-evaluation case through Pi in a Seatbelt-controlled environment, preserve filesystem evidence, and evaluate it with the `file` and `judge` checkers. Checks must remain runnable after the evaluated environment has been cleaned up.

Keep the repository private until this initial path is usable. Publication is a separate user decision, not an automatic completion step.

## Implementation Choices

- TypeScript on Node.js 24 or later.
- Use Node's built-in test runner and platform libraries where practical.
- Approved project-local dependencies: `yaml`, plus `typescript` and `@types/node` for type checking. Commit a lockfile; do not install global tools.
- The first runner drives Pi through its native RPC interface, without WebAgent.
- Use macOS Seatbelt directly through `sandbox-exec`, with platform-specific policy and launch code kept separate.
- Discover runner and checker implementations from trusted directories. `$type` selects the implementation; other fields are its parameters.
- The two initial checkers are `file` and `judge`. Judge model access initially reuses an independent Pi invocation rather than introducing another provider SDK.

## 1. Establish the Example and Project Gate

- [ ] Create the minimal package configuration, dependency lockfile, type-check command, and test command.
- [ ] Author a small, reproducible filesystem-modification case with a fixture and a minimal skill owned by this project.
- [ ] Keep the case, fixture, and dedicated authoring assets together; keep the candidate runner configuration separate from the task.
- [ ] Use this example to settle the smallest necessary YAML fields rather than implementing a speculative full schema.
- [ ] Include both deterministic file assertions and a short judge rubric in the example.
- [ ] Reference earlier skill-eval lessons about isolation, capability verification, evidence, and cleanup, but do not copy private configurations, historical run data, or vendored tooling.

Acceptance: the example is independently understandable and contains everything needed to reproduce its initial filesystem state. No model calls are needed for this step.

## 2. Load Cases and Discover Implementations

- [ ] Write focused failing tests for YAML loading, relative asset paths, implementation discovery, and invalid input before implementing them.
- [ ] Validate the common case and invocation structure; let each selected implementation validate its own parameters.
- [ ] Reject missing implementations, invalid parameters, unsupported features, and unsafe asset paths explicitly.
- [ ] Pass implementation parameters without promoting fields such as `model`, `thinking`, or `rubric` into engine business logic.
- [ ] Prove that a test implementation can be added in a trusted discovery directory without changing dispatch code.
- [ ] Do not discover executable extensions from the evaluated workspace or its artifacts.

Acceptance: the example loads through the real YAML parser and resolver. Invalid cases fail before starting an agent.

## 3. Execute Pi with Filesystem Isolation and Evidence

- [ ] First test the Seatbelt launcher and lifecycle with controlled subprocesses, without calling a model.
- [ ] Create independent working, home, Pi configuration, and temporary directories for each run.
- [ ] Populate the fixture and only the declared candidate resources. Do not inherit the operator's complete skill, instruction, extension, MCP, or session environment.
- [ ] Carry only necessary model access configuration; do not record credentials or inherited production capabilities in evidence.
- [ ] Drive Pi through RPC, preserve visible events and replies, and verify that declared resources are actually available.
- [ ] Keep case definitions, rubrics, checker implementations, candidate labels, and result records outside the evaluated agent's permitted data. Expose only the intended inputs and candidate resources, using neutral runtime paths.
- [ ] Preserve the relevant before/after filesystem state and contents outside the evaluated agent's writable area. Do not follow workspace symlinks into unrelated host data while capturing evidence.
- [ ] Distinguish an observed missing file from incomplete evidence collection. Record capture failures explicitly.
- [ ] Register resource cleanup when resources are created. Exercise successful completion, startup failure, task failure, timeout, cancellation, and owned-child-process cleanup.
- [ ] Keep required filesystem denials enforced by the real OS. Do not fall back to unsandboxed execution.

Acceptance: permitted file operations work and forbidden reads/writes fail under real Seatbelt. Evidence remains available after cleanup, and the tested failure paths leave no owned processes or temporary execution environments behind.

This milestone establishes a tested filesystem boundary, not a claim of complete isolation from every host capability. Document remaining permissions, including networking required for model access.

## 4. Implement Checkers and Offline Rechecking

### File

- [ ] Implement `exists`, `matches`, and `unchanged` within one `file` checker rather than separate checker types.
- [ ] `matches` uses regular-expression search over text contents. It does not imply full-file matching; anchors can express stricter patterns. Do not retain an `includes` alias.
- [ ] Return separate results for configured conditions and patterns.
- [ ] Treat invalid regexes and invalid configurations as errors, not failed agent behavior. Keep checker execution bounded.
- [ ] Resolve paths within the persisted evaluated-workspace evidence, never against the engine's working directory.
- [ ] Test missing files, matching and nonmatching contents, unchanged and modified files, invalid patterns, unsafe paths, and incomplete evidence.

### Judge

- [ ] Evaluate explicitly selected file contents or differences with the task context and rubric.
- [ ] Use an independent Pi invocation, not the evaluated agent's conversation. Do not provide unrestricted workspace contents by default.
- [ ] Return a result and explanation for each rubric statement, without mandatory business-category labels.
- [ ] Preserve raw judge output and validated results. Malformed or incomplete verdicts are checker errors, not passes.
- [ ] Keep model and connection settings as checker parameters, not engine-specific fields.

### Rechecking

- [ ] Provide a way to invoke checks against an existing evidence bundle without rerunning the evaluated agent.
- [ ] Preserve the distinction between an agent failing a check, an execution failure, and a checker or capture failure.
- [ ] Produce machine-readable results and a small human-readable summary without introducing a general reporting plugin system.

Acceptance: deterministic checks work against real saved files; judge request/response handling has non-model tests. Checks still work after the original runtime has been removed. Rechecking with a judge can incur a new judge call and must remain explicit.

## 5. Verify the Complete Path

- [ ] Run type checking, unit tests, and real Seatbelt integration tests at normal suite concurrency. Resolve flakes rather than masking them with retries.
- [ ] Test controlled failure and timeout paths, with bounded outer timeouts and cleanup registered in the test fixtures.
- [ ] Before any real-model run, confirm the runner and judge models, thinking settings, and run budget. No model calls are part of the default test gate.
- [ ] After approval, run one small end-to-end smoke case with Pi and the judge. Retain the configuration, evidence, and results needed to explain it. This verifies tool integration, not that the skill improves agent behavior.
- [ ] Run one bounded, independent, read-only review Task over the cumulative implementation; validate all material findings together and close confirmed findings in one focused pass.
- [ ] Update usage documentation with commands that were actually verified and the limitations observed.

Acceptance: do not call the first milestone usable until the real-model smoke path has been verified. Do not publish the repository or push changes without the user's confirmation.

## Not in This Milestone

- WebAgent integration or dependencies on its Task APIs.
- A generic ACP runner, multi-turn case scripting, or a simulated User Agent.
- A tracer plugin system, magic evidence variables, or a general reference-expression language.
- Linux or Windows backends, MXC, Docker, or VM execution.
- Automated candidate optimization, a training platform, large sweeps, or advanced statistical reports.
- Full compatibility with earlier skill-eval formats, aggregators, or viewers.
