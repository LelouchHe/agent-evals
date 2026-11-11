# Architecture

This document records the system's overall direction and responsibility boundaries. Concrete delivery scope, implementation choices, and acceptance criteria belong in milestone plans.

Configuration composition below is agreed direction, not implemented behavior. M1 still uses separate case/candidate files; see [the current records](cases.md#m1-supported-records) and [the planned composition contract](configuration.md).

## Principles

- Start from scratch. Learn from earlier skill-eval work without importing its package, upstream skill bundles, or the old agent-eval prototype as the foundation.
- Do not require compatibility with earlier schemas, aggregators, or viewers.
- Use real evaluation scenarios to grow the system. Extract abstractions from actual repetition rather than anticipated requirements.
- Skills, workflows, configurations, and harnesses share one evaluation model, not separate hard-coded pipelines.

## Distinguishing Choices

Comparable agent-evaluation tools mostly isolate runs in containers and adapt each agent CLI separately, and several build skill concepts into the engine. This project makes three different choices, which depend on one another.

- **The engine does not know what is being evaluated.** Skills, workflows, configurations, and harnesses are evaluated through ordinary cases. Labels such as "with" and "without" are author-defined names, not built-in modes, and a collection of cases is not inherently a comparison group.
- **Host sandboxes instead of containers.** How a harness behaves on a real platform and runtime is part of what is measured, so runs execute on the host operating system under its own sandbox. See [Runtime and Platform Boundaries](#runtime-and-platform-boundaries).
- **One protocol-level runner instead of one adapter per harness.** Evaluating different harnesses needs a uniform way to drive them, including across several turns. See [The ACP Runner Direction](#the-acp-runner-direction).

These choices carry costs. Each platform needs its own sandbox backend, with differing capabilities and guarantees, and cross-platform comparison requires fixtures, setup, and checks that hold on every platform compared.

## Evaluation Model

```text
Configuration files
    -> Resolve composition and preserve field provenance
    -> Complete case: input message + runner configuration + environment + checks
    -> Runner
    -> Output message + Environment observations
    -> Checkers
    -> Result of one run
```

Messages form the invocation's conversational input and output. Files, environment variables, service state, and other observable external state belong to the environment. A workflow may treat a file as its business result without requiring a separate return-value system in the evaluation engine.

Checks may assess the relationship between input and output messages, environment changes, or both. Execution traces and measurements are additional evidence when available. Evidence must not be limited to the evaluated agent's own account of what happened.

## Configuration Resolution

Keep authoring composition separate from runtime execution. The agreed M1 revision resolves one file into a single case or combines common fields with a selected named case using disjoint top-level keys. A repeated top-level field is an error, even if its nested fields differ. Do not introduce inheritance or recursive overrides. The engine executes the complete case without interpreting case labels or skill-specific comparison categories.

The read-only `view` operation and execution share this resolver and its source locations. All authoring paths use the single file's directory. Inspection shows the final configuration without launching a harness or obtaining credentials; execution performs runtime validation separately. Each run retains the actual non-sensitive resolved configuration and evaluated-content identity, rather than relying on source files remaining unchanged.

The composition rule, supported authoring forms, and implementation boundary belong in [Case Configuration](configuration.md). This is not a new Runner/Checker plugin lifecycle or the generic tracer contract.

## Cases as Tests

Treat an evaluation case as a test in the sense of a unit-testing framework: control the inputs, observe the outputs and side effects, and focus each case on one behavior.

| Testing concept          | Here                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| System under test        | Configured harness and evaluated resources                       |
| Parameterized test       | Named cases derived from common configuration                    |
| Fixture, setup, teardown | Fixture, setup, cleanup                                          |
| Assertion                | Check                                                            |
| Side-effect assertion    | Environment observations, such as files that must stay unchanged |
| Hermetic environment     | Sandbox with per-run state                                       |

- Keep cases small, independent, and focused, so that a failure points to its cause. Prefer many narrow cases over one large task with a single score.
- A case may target a particular skill or capability. Reuse it across implementations when expectations are shared; do not confuse a generic engine with universally applicable cases. Repetition and batching can use the same single-case execution path.
- Assert outcomes and resulting state rather than the sequence of steps. An agent has many valid paths; check that something was or was not done only when that is the behavior under test.
- The analogy stops at determinism. An evaluated agent is stochastic, so a result is ultimately a rate over repeated runs rather than a single pass or fail. Repetition is not yet defined.

### The Mock Direction

Replacing the tools and services an agent uses with controlled substitutes belongs to the environment, and serves three purposes: controlling what the agent receives, including errors, timeouts, and malformed data; recording what the agent did to them as evidence; and avoiding real consequences for actions such as sending messages or publishing changes.

- Substitution isolates the behavior under test from its collaborators. A skill under test may invoke other skills, tools, or agents, some by design and some on the agent's own initiative; a case that is not about those collaborators should not depend on their quality, cost, or side effects.
- Each collaborator is in one of three states for a run: real, substituted, or absent. The agent can only reach what the run exposes, so unanticipated calls are bounded by deciding what is exposed, not by predicting them.
- A substituted skill keeps the name and description that make the agent select it and replaces the body with a minimal one that yields what the caller needs to continue. A skill is instruction text in the agent's context rather than a call boundary, so its substitute still influences later behavior and must be written with that in mind.
- Cases with substituted collaborators measure whether and how the behavior under test uses them; cases with real ones measure the combined result. Both are needed, as with unit and integration tests.
- Prefer working simplified implementations (fakes) over substitutes that accept only scripted calls. An agent explores and may use anything the substitute appears to offer; gaps in the substitute would be measured as agent failures.
- Substitutes are trusted authoring assets and stay outside the evaluated agent's writable area, like checkers.
- An ACP runner is a natural injection point, since the client side supplies tool servers and may serve file and terminal operations.
- Replacing the model itself tests a harness's deterministic code, not agent behavior. That is useful for this project's own tests but is not a case feature.

This direction does not yet define how substitutes are declared, started, or referenced by checks. Open questions:

- **Ownership.** A substituted skill is installed where the evaluated skills are, which makes it runtime assembly mechanically, yet it is a test double that belongs to the case. Which side declares substitutes decides the configuration shape.
- **Harness built-in tools.** Tool servers are easy to replace; shell, file, and other tools inside the harness are not. Candidate mechanisms are substitute executables on the sandbox's command path, harness hooks that rewrite or deny calls, and client-served operations over ACP. Their coverage differs by harness.
- **Skill substitutes as context.** Since a substituted skill still shapes later behavior, it is unsettled how to write one that stands in for the real skill without distorting what the case measures, and how to notice when it does.
- **Form and drift.** A substitute may be canned responses, a stateful fake, or a model playing the collaborator; these trade determinism and cost against coverage of unscripted calls. Any form can silently fall out of step with the real collaborator's interface.

## Components

| Component | Responsibility                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine    | Validate common inputs, prepare environments, coordinate runners and checkers, handle results, and enforce lifecycle and cleanup requirements. |
| Runner    | Drive the evaluated harness, expose its observable events and state, and perform harness-specific cancellation and teardown.                   |
| Checker   | Interpret its parameters, inspect run state or supplied evidence, and return checks or scores with reasons and evidence references.            |

Keep failed checks of agent behavior distinct from configuration, execution, observation, and checker failures.

## Extension Boundaries

- Runner and Checker are configurable extension points. The resolved case selects its runner and checkers; their parameters remain implementation-owned.
- Discover implementations from designated, trusted directories. Adding an implementation that satisfies the established contract should not require changing engine dispatch. M1 registers the built-ins at the CLI composition root and loads optional modules only from operator-supplied trusted directories; an evaluated workspace is never a discovery root.
- Built-in and added implementations follow the same contracts. The engine does not understand their business parameters.
- Runners manage interaction and session lifecycle; checkers evaluate results and observations. Do not force them into one universal plugin interface.
- Do not load executable extensions from agent-writable workspaces or generated artifacts. Case-local checker code is a trusted authoring asset, not part of the evaluated working copy.
- Neither case definitions nor the engine should require WebAgent or one particular harness. Harness-specific startup and communication details belong in runners.
- Stable contracts avoid routine engine changes; genuinely new requirements may justify explicit contract evolution. Add extension mechanisms when real needs support them, not for completeness.

The `$type` selection convention and authoring rules are documented in [cases and configuration](cases.md).

## The ACP Runner Direction

The Agent Client Protocol (ACP) is the expected main route for driving harnesses beyond the first runner. One ACP runner can serve every harness that speaks the protocol instead of requiring a dedicated runner for each.

- Multi-turn evaluation depends on this route: further input messages are additional prompts on the same ACP session, not a separate evaluation model.
- ACP session updates such as tool calls, plans, and permission requests are protocol-level reports from the harness and are usable as evidence. Their granularity may differ between harnesses, and they report calls rather than effects, so environment observations remain the evidence for what actually changed.
- ACP standardizes the conversation, not configuration assembly. Placing skills, configuration, and tool servers remains harness-specific preparation.
- The runner answers the agent's permission requests. The answering policy is an evaluation variable and may become case or runner configuration; it is not yet defined.
- Harness-native runners remain valid. Keep the Runner contract free of concepts specific to one harness's protocol so that an ACP runner can be added without engine changes.

This direction does not yet define the ACP runner's configuration, supported protocol capabilities, or permission-policy syntax.

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
- Keep workspace state, credentials, run configuration, results, and diagnostics deliberately scoped. Do not contaminate source fixtures or retain copied credentials as results.
- Register cleanup when resources are created, and account for failure, timeout, and cancellation as well as successful completion. M1 keeps the initial comparison baseline outside the agent's writable area, then removes the whole runtime directory after checks.
- Platform adaptation must not imply identical capabilities or security guarantees across backends.
- Isolate with the host operating system's own sandbox rather than containers. A harness behaves differently across platforms and runtimes, for example driving PowerShell on Windows instead of Bash, and that difference is itself something to measure. Containers would run nearly everything on Linux and erase it.
- Support macOS, Linux, and Windows, each through its own backend, starting with macOS and then Linux. The cross-platform execution SDK mcx was considered and set aside because of privacy concerns about its telemetry.
- Keep personal configuration and private run data out of shareable examples.

See [M1](m1-plan.md) for the first filesystem-evaluation implementation.
