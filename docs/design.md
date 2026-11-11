# Design Principles

A personal toy project that grows from real evaluation needs. This document records agreed directions, not a complete schema, plugin system, or class hierarchy.

## Starting Point

- Start from scratch. Do not import the existing skill-eval package wholesale or use the old agent-eval prototype as the foundation.
- Learn from earlier evaluation work without targeting compatibility with its schemas, aggregator, or viewer. Do not introduce upstream skill packages as part of initialization.
- Make skill evaluation work first. Use real workflow, configuration, and harness evaluation scenarios to discover what needs to grow next.
- Extract abstractions from actual repetition rather than anticipated requirements.
- Keep the repository private during initial development. Reconsider publication once the initial skill-evaluation tooling is usable; do not change visibility automatically.

## A Case Is a Human-Readable Experiment Specification

Use YAML for human-authored cases. Keep the following decisions together:

- **Prompt**: the actual user request, goals, and constraints supplied to the agent.
- **Environment**: initial files, setup steps, required tools or services, and any failure conditions to exercise.
- **Checks**: selected checker implementations, their parameters, success and failure criteria, and rubrics.
- **Execution requirements**: capabilities and case-specific constraints, such as a timeout.

Declare candidates separately so the same case can compare different skills, workflows, configurations, or harnesses without duplicating the task definition.

Prefer explicit fixtures, commands, or scripts for environment setup rather than asking another LLM to improvise it. YAML describes the experiment; it should not become a complicated programming language.

## Keep Case Assets Together

For example:

```text
cases/
├── delegation-basic/
│   ├── case.yml
│   ├── fixtures/
│   ├── setup.sh       # optional
│   └── check.py       # optional
└── shared/
    └── fixtures/
```

- Resolve paths relative to the case definition, not the invocation's current working directory.
- Keep fixtures, dedicated setup, and case-specific checks beside the case. Extract shared assets only after real reuse appears.
- Reference shared assets explicitly rather than injecting them through hidden global conventions.
- Share definitions and initial data, not mutable runtime state. Each run gets an independent copy or read-only access to shared inputs.
- Store run artifacts separately. Do not rewrite case definitions or contaminate fixtures.
- Expose only the prompt and intended environment to the evaluated agent. Do not expose the case definition, checkers, rubrics, or reference answers by default.
- Do not create empty directories in advance or require scripts for every case.

## Engine, Runners, and Checkers

The main flow is:

```text
Case + Candidate + Environment
    -> Runner
    -> Evidence
    -> One or more Checkers
    -> Results and comparisons
```

| Component | Responsibility |
|---|---|
| Engine | Validate inputs, prepare environments, invoke the selected runner and checkers, preserve evidence and results, and enforce lifecycle and cleanup requirements. |
| Runner | Drive the evaluated harness, expose its observable events and state, and implement the harness-specific actions needed for cancellation and teardown. |
| Checker | Interpret its parameters, inspect evidence, and return named checks or scores with reasons and evidence references. |

Evidence includes observed events, outputs, artifacts, and measurements, not just the evaluated agent's own account of what happened. Regrading should not require rerunning the agent by default. Keep checker execution failures distinct from failed checks of the evaluated result.

## Evidence Capture and the Tracer Direction

### Current Scope

- Focus the first iteration on filesystem evidence. Preserve the relevant initial and final state, changes, and file contents needed by checks.
- Checker context comes from the evaluated run's persisted evidence, not the engine's working directory, process environment, or a live runtime handle. It must remain usable after the evaluated environment is gone.
- Capture required state while it is observable, preserve evidence outside the evaluated agent's writable area, and complete collection before destroying the environment.
- Do not build a general tracer plugin system in the first iteration.

### Unified Direction

- Treat tracing as one coherent evidence-collection responsibility. Future needs such as messages, process environment variables, tool calls, permission events, or service state should fit a unified tracer design rather than accumulate unrelated engine special cases.
- Separate collection from referencing. A reference cannot recover state that was never captured; a tracer has value when it provides an actual collection capability, not merely a new name for existing data.
- A filesystem-first implementation does not establish a filesystem-only contract for all future evidence. Collection mechanisms may differ by source while sharing consistent persistence and checker-access principles.
- Missing or unavailable observations must be explicit. Do not silently substitute engine-host state or count missing evidence as a passing check. Capture only the necessary data, especially for secrets-bearing environment variables.
- Tracer configuration, lifecycle hooks, discovery, evidence layout, and reference syntax are deliberately deferred. Illustrative filenames such as `env.json` or `response.txt` are not a finalized format. No `$msg`, `$env`, or general variable-expression language is approved.

## Two Configurable Extension Points

- Runner and Checker are the initial extension points. Run or candidate configuration selects the runner; cases select checkers and supply their parameters.
- The default execution target is Pi. Neither the engine nor the case format should require WebAgent or embed a particular harness's startup details.
- Discover implementations from designated, trusted directories. Adding an implementation that satisfies the established contract should not require changing the engine's dispatch logic.
- Built-in and added implementations follow the same contracts. Start with a runner that can drive Pi and a small set of useful checkers, including an LLM judge; do not implement every possible extension upfront.
- A runner manages interaction and session lifecycle, while a checker evaluates captured evidence. They need separate contracts, not a universal plugin interface forced onto both.
- Keep checker parameters outside the engine's business logic. Each checker interprets and validates its own parameters; the engine validates the common contract and handles invocation and results.
- Do not discover executable extensions from agent-writable workspaces or generated artifacts. Case-local checker code remains a trusted authoring asset, not part of the evaluated agent's working copy.
- Environment preparation can use fixtures and scripts. Keep sandboxing in its platform module rather than adding environment, sandbox, and reporting plugin families in advance.

Stable contracts let implementations grow without routine engine changes; genuinely new requirements may still justify explicit contract evolution.

## Implementation Selection with `$type`

Runner and checker configuration records use `$type` to select a discovered implementation. This is a project convention, not a built-in YAML feature.

For example, run or candidate configuration can select a runner:

```yaml
runner:
  $type: pi
  model: provider/model-under-test
  thinking: high
```

A case can select a checker using the same convention:

```yaml
checks:
  - $type: llm-judge
    model: provider/judge-model
    rubric:
      - Each step describes a concrete action.
      - The guide covers preparation and verification.
```

- The engine consumes `$type` and passes all remaining fields to the selected implementation as its parameter object, without requiring a separate `params` wrapper.
- Fields such as `model`, `thinking`, and `rubric` belong to the implementation. The engine does not interpret them or add implementation-specific branches for them.
- Plain `type` remains available as an implementation parameter; it is not the engine's selector.
- Missing or unknown implementations and invalid parameters are configuration errors, not reasons for implicit fallback.
- Only `$type` currently has engine-defined semantics in these records. Do not introduce `$ref`, `$env`, or other engine directives in advance; YAML does not provide those features automatically.

These examples establish implementation selection and parameter ownership, not a complete case schema or a promise that the illustrated parameters are implemented.

## Declarative Checks and Named Dimensions

- Do not introduce separate routing and behavior case types, files, or execution pipelines. Whether a skill was loaded and how the agent acted are evaluation concerns expressed through checks and evidence.
- Prefer reusable declarative checks for common needs. Custom code is an extension path, not mandatory boilerplate for every case.
- A check selects its checker with `$type`; the remaining body supplies that checker's parameters. Other case fields and invocation wire formats should be established through real cases rather than speculative schema design.
- A checker can return several named results. Correctness, completeness, constraint adherence, and similar dimensions are case data, not separate checker classes or fixed global categories.
- The built-in LLM judge should accept multiple rubric criteria and preserve their individual results. Criteria do not require fixed category labels; a list of grading statements is sufficient. Multiple criteria do not require multiple checker implementations or necessarily multiple model calls.
- Models and connection settings are runner or checker parameters, not special engine-level fields. Shared configuration should reuse the same implementation configuration shape rather than introduce judge-specific core sections.

Skills, workflows, configurations, and harnesses do not each need a hard-coded execution pipeline. Different evaluation concerns mainly belong in checks; harness-specific interaction belongs in runners. Evidence capture follows the unified tracer direction above. Required tool or service capabilities must exist before a case can be evaluated; their absence must not turn a restraint into a vacuous pass.

## Sandboxing and Runtime Environments

- The initial implementation targets macOS only and uses Seatbelt directly through `sandbox-exec`.
- Do not introduce MXC or implement Linux or Windows backends at this stage.
- Keep Seatbelt profile generation and platform-specific launch details in a small, separate module. Case definitions, grading, and the rest of the execution flow should not depend directly on Seatbelt syntax.
- Do not design a generic backend plugin system or cross-platform policy language in advance. Add platform support only when a real need justifies it.
- Isolation boundaries, working environments and state, and execution lifecycles are separate responsibilities. Seatbelt does not provide workspace snapshots, dependency provisioning, or complete task lifecycle management.
- Workspace state, candidates, evidence, timeouts, cancellation, and cleanup remain this project's responsibility.
- Declare required capabilities and verify both permitted and denied behavior. Do not fall back to unsandboxed execution when a required restriction cannot be enforced.
- Keep personal configuration, credentials, and private run data out of public examples.

## Dataset Splits

Cases may be organized and selected as train, dev, or test data without first building a training platform. Here, train may mean examples used to improve prompts, workflows, or configurations rather than model weights.

Train and dev data may be inspected repeatedly during development. Keep test data for held-out validation and avoid exposing its answers to the optimization process. Watch for leakage across related tasks and near-duplicate variants. Manage judge calibration examples separately from candidate test sets.
