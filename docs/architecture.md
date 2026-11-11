# Architecture

This document records the system's overall direction and responsibility boundaries. Concrete delivery scope, implementation choices, and acceptance criteria belong in milestone plans.

## Principles

- Start from scratch. Learn from earlier skill-eval work without importing its package, upstream skill bundles, or the old agent-eval prototype as the foundation.
- Do not require compatibility with earlier schemas, aggregators, or viewers.
- Use real evaluation scenarios to grow the system. Extract abstractions from actual repetition rather than anticipated requirements.
- Skills, workflows, configurations, and harnesses share one evaluation model, not separate hard-coded pipelines.

## Evaluation Model

```text
Input message + Candidate + Environment
    -> Runner
    -> Output message + Environment observations
    -> Checkers
    -> Results and comparisons
```

Messages form the invocation's conversational input and output. Files, environment variables, service state, and other observable external state belong to the environment. A workflow may treat a file as its business result without requiring a separate return-value system in the evaluation engine.

Checks may assess the relationship between input and output messages, environment changes, or both. Execution traces and measurements are additional evidence when available. Evidence must not be limited to the evaluated agent's own account of what happened.

## Components

| Component | Responsibility |
|---|---|
| Engine | Validate common inputs, prepare environments, coordinate runners and checkers, handle results, and enforce lifecycle and cleanup requirements. |
| Runner | Drive the evaluated harness, expose its observable events and state, and perform harness-specific cancellation and teardown. |
| Checker | Interpret its parameters, inspect run state or supplied evidence, and return checks or scores with reasons and evidence references. |

Keep failed checks of agent behavior distinct from configuration, execution, observation, and checker failures.

## Extension Boundaries

- Runner and Checker are configurable extension points. Run or candidate configuration selects the runner; cases select checkers.
- Discover implementations from designated, trusted directories. Adding an implementation that satisfies the established contract should not require changing engine dispatch. M1 registers the built-ins at the CLI composition root and loads optional modules only from operator-supplied trusted directories; an evaluated workspace is never a discovery root.
- Built-in and added implementations follow the same contracts. The engine does not understand their business parameters.
- Runners manage interaction and session lifecycle; checkers evaluate results and observations. Do not force them into one universal plugin interface.
- Do not load executable extensions from agent-writable workspaces or generated artifacts. Case-local checker code is a trusted authoring asset, not part of the evaluated working copy.
- Neither case definitions nor the engine should require WebAgent or one particular harness. Harness-specific startup and communication details belong in runners.
- Stable contracts avoid routine engine changes; genuinely new requirements may justify explicit contract evolution. Add extension mechanisms when real needs support them, not for completeness.

The `$type` selection convention and authoring rules are documented in [cases and configuration](cases.md).

## Evidence and the Tracer Direction

Treat tracing as a coherent evidence-collection responsibility rather than accumulating unrelated engine special cases for messages, env, files, tool calls, permission events, or services. Some observations are snapshots; others are event streams, so collection mechanisms and timing may differ.

- Checker context concerns the evaluated run, not the engine's working directory or process environment. Never silently substitute engine-host state.
- Collect required observations while they are accessible. A reference cannot recover state that was never captured.
- Separate collection from referencing. A tracer adds value by supplying an actual observation capability, not merely by renaming existing data.
- Retained evidence can enable checking after runtime teardown and regrading without rerunning the agent. Do not assume either that the environment remains alive or that every run retains a full copy.
- Make unavailable observations and collection failures explicit; they must not count as passing checks.
- Preserve evidence outside the evaluated agent's writable area when retaining it. Collect only necessary data, especially for secrets-bearing environment variables.

The unified tracer direction does not yet define configuration, lifecycle hooks, discovery, evidence layout, or reference syntax. Filenames such as `env.json` and `response.txt` are illustrative, not reserved interfaces. No `$msg`, `$env`, or general variable-expression language is approved.

## Runtime and Platform Boundaries

- Keep platform-specific policy generation and process-launch details in a small, separate module. Cases and checkers should not depend directly on a platform's policy syntax.
- Isolation, working environments and state, and execution lifecycles are separate responsibilities. An OS sandbox does not automatically provide snapshots, dependencies, or complete task lifecycle management.
- Prepare independent run state and declare required capabilities. Do not silently fall back to unsandboxed execution when a required restriction cannot be enforced.
- Keep workspace state, credentials, candidate configuration, results, and diagnostics deliberately scoped. Do not contaminate source fixtures or retain copied credentials as results.
- Register cleanup when resources are created, and account for failure, timeout, and cancellation as well as successful completion. M1 keeps the initial comparison baseline outside the agent's writable area, then removes the whole runtime directory after checks.
- Platform adaptation must not imply identical capabilities or security guarantees across backends.
- Keep personal configuration and private run data out of shareable examples.

See [M1](m1-plan.md) for the first filesystem-evaluation implementation.
