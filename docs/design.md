# Design Principles

A personal toy project that grows from real evaluation needs. This document records agreed directions, not a complete schema, plugin system, or class hierarchy.

## Starting Point

- Start from scratch. Do not import the existing skill-eval package wholesale or use the old agent-eval prototype as the foundation.
- Learn from earlier evaluation work without targeting compatibility with its schemas, aggregator, or viewer. Do not introduce upstream skill packages as part of initialization.
- Make skill evaluation work first. Use real workflow, configuration, and harness evaluation scenarios to discover what needs to grow next.
- Extract abstractions from actual repetition rather than anticipated requirements.

## A Case Is a Human-Readable Experiment Specification

Use YAML for human-authored cases. Keep the following decisions together:

- **Task**: user input, goals, and constraints.
- **Environment**: initial files, setup steps, required tools or services, and any failure conditions to exercise.
- **Grading**: selected graders, checks, success and failure criteria, and rubrics.
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
- Do not create empty directories in advance or require scripts for every case.

## Separate Execution from Grading

The main flow is:

```text
Case + Candidate + Environment
    -> Execution
    -> Evidence
    -> One or more Graders
    -> Results and comparisons
```

- The **execution layer** handles environment setup, agent interaction, sandboxing, timeouts, cancellation, evidence capture, and cleanup.
- **Evidence** includes observed events, outputs, artifacts, and measurements, not just the evaluated agent's own account of what happened.
- **Graders** consume evidence to assess outcomes or behavior. Regrading should not require rerunning the agent by default.
- Cases declare grading requirements. Reusable graders live in code; dedicated checks may reference scripts beside the case. Do not embed every program in YAML.

Skills, workflows, configurations, and harnesses do not each need a hard-coded execution pipeline. Different evaluation concerns mainly belong in graders; differences in interaction and evidence capture belong in the execution layer.

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

Train and dev data may be inspected repeatedly during development. Keep test data for held-out validation and avoid exposing its answers to the optimization process. Watch for leakage across related tasks and near-duplicate variants. Manage grader calibration examples separately from candidate test sets.
