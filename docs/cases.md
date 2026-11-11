# Cases and Configuration

A case is a human-readable, executable test definition. This document describes shared authoring principles and the implemented M1 records, not a complete general schema.

The implemented M1 authoring revision is documented in [Case Configuration](configuration.md): one file, ordinary single cases or common fields plus named `cases`, disjoint top-level composition, and source-annotated `view`. There is no inheritance or overriding.

Write a case the way you would write a test: control the inputs, observe the outputs and side effects, and focus on one behavior. See [Cases as Tests](architecture.md#cases-as-tests) for the analogy, its limits, and the direction for mocked tools and services.

## What a Case Describes

Use YAML to keep the following decisions together:

- The input message, user goal, and constraints.
- The initial environment: files, environment variables, setup steps, required tools or services, and any failure conditions to exercise.
- Checks: selected implementations, parameters, success and failure criteria, and rubrics.
- Case-specific execution requirements, such as a timeout.
- The runner and its implementation-owned configuration in the resolved case.

The input is a real message and prepared environment, not a requirement to fill prompt-template variables. Do not silently rewrite evaluated prompts or interpolate arbitrary YAML strings.

A case may be specific to the skill or capability under test. Reuse shared fields or cases only when the relevant expectations are genuinely shared; do not require every case to apply to every evaluated system. Named cases need not form a comparison group. Prefer explicit fixtures, commands, or scripts for setup rather than asking another LLM to improvise it.

The implemented format does not require separate Candidate or Subject entities. A single saved document can be directly runnable, or named cases can supply top-level fields absent from the common part. Duplicate top-level fields are errors; nested values are not merged. Persist test inputs rather than depending on temporary shell parameters, and retain each run's resolved non-sensitive configuration and source/case identity. Resource-content hashing is outside this revision; configuration records alone do not preserve old skill or fixture contents.

## Keep Related Assets Together

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

- Resolve authoring assets relative to the file declaring them, not the invocation's current working directory. Check targets refer to the evaluated run's context, not the case source directory or engine cwd.
- Keep fixtures, dedicated setup, and case-specific checks beside the case. Extract shared assets only after real reuse appears, and reference them explicitly.
- Share definitions and initial data, not mutable runtime state. Each run gets an independent copy or read-only access to shared inputs.
- Store retained results and diagnostics separately. Do not rewrite case definitions or contaminate fixtures.
- Expose only intended messages, environment data, and evaluated resources to the agent. Keep case definitions, checkers, rubrics, and reference answers outside its view by default.
- Do not create empty directories in advance or require scripts for every case.

## Select Implementations with `$type`

Runner and checker configuration records use `$type` to select a discovered implementation. This is a project convention, not a built-in YAML feature.

The resolved case configuration selects a runner:

```yaml
runner:
  $type: pi
  model: provider/model-under-test
  thinking: high
```

A case can select a checker using the same convention:

```yaml
checks:
  - $type: judge
    model: provider/judge-model
    rubric:
      - Each step describes a concrete action.
      - The guide covers preparation and verification.
```

- The engine consumes `$type` and passes all remaining fields to the selected implementation as its parameter object, without a separate `params` wrapper.
- Fields such as `model`, `thinking`, and `rubric` belong to the implementation, which interprets and validates them. The engine does not add implementation-specific branches for them.
- Plain `type` remains available as an implementation parameter; it is not the engine's selector.
- Missing or unknown implementations and invalid parameters are configuration errors, not reasons for implicit fallback.
- Only `$type` has agreed engine-defined semantics in these records. `$ref`, `$env`, and arbitrary string interpolation are not implicit YAML capabilities.
- Shared configuration should reuse the same implementation configuration shape rather than introduce judge-specific core sections.

These fragments establish selection and parameter ownership. [Case Configuration](configuration.md) owns the composition and inspection rules.

## Implemented Records

The CLI resolves one YAML file. Without `cases`, the document is one ordinary case. With `cases`, top-level fields outside that mapping are common invariants, and exactly one named entry must be selected; fields are combined only when their top-level keys are disjoint.

An ordinary case supplies one input message, optional fixture and timeout fields, checks, and the runner:

```yaml
input: Create hello.txt with exactly the content "Hello, world!".
fixture: fixture # optional directory, resolved relative to this file
timeoutMs: 120000 # optional runner budget in milliseconds
checks:
  - $type: file
    path: hello.txt
    exists: true
    matches: '^Hello, world!\n?$'
  - $type: judge
    model: provider/judge-model
    thinking: medium
    file: hello.txt
    rubric:
      - hello.txt exists and its content is "Hello, world!", allowing one final newline.
runner:
  $type: pi
  model: provider/model
  thinking: medium
  skills: [skill] # optional, resolved relative to this file
  envPassthrough: [API_KEY] # optional allowlist; values are not recorded
```

Use common fields plus named `cases` when several tests share inputs and checks. Each selected entry supplies the fields the common part omits:

```yaml
input: Create hello.txt with exactly the content "Hello, world!".
checks:
  - $type: file
    path: hello.txt
    exists: true

cases:
  with-skill:
    runner:
      $type: pi
      model: provider/model
      skills: [skill]
      envPassthrough: [API_KEY]
  without-skill:
    runner:
      $type: pi
      model: provider/model
      skills: []
      envPassthrough: [API_KEY]
```

Select a named case explicitly, even when only one exists:

```sh
node src/cli.ts run case.yml --case with-skill
node src/cli.ts view case.yml --case with-skill
```

A top-level field repeated between the common part and the selected entry is an error, even when both values are identical. Sibling entries may repeat each other's fields because they are resolved independently. Case names are metadata only and never become filesystem paths or result-directory names. See [Case Configuration](configuration.md) for the complete composition and rejection rules.

Within a runner or checker record, all fields except `$type` belong to the selected implementation. Unknown fields, unknown implementations, invalid regular expressions, and missing authoring assets are configuration errors reported before any runtime resource is created.

### `pi` Runner Parameters

| Parameter        | Meaning                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`          | Pi model selector, normally `provider/model`. Required.                                                                                                                 |
| `thinking`       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Defaults to `medium`.                                                                                     |
| `skills`         | Relative skill files or directories loaded explicitly. Discovered skills, extensions, MCP servers, sessions, context files, prompt templates, and themes stay disabled. |
| `executable`     | Pi executable name or path. Defaults to `pi`.                                                                                                                           |
| `envPassthrough` | Environment variable names copied from the invoking process. Use this for narrowly scoped credentials; other variables are not inherited.                               |

The runner starts Pi in an empty or fixture-backed workspace, sends the case input as one user message, and lets Pi complete autonomous tool turns. Pi bash invocations run through a generated custom shell that keeps ordinary background jobs in a tracked process group and terminates them before the command returns. The engine also stops Pi and every tracked shell group before checks run, including after timeout, cancellation, and an early Pi exit. A child that deliberately starts a new session or process group is outside this cleanup contract.

A final assistant message with `stopReason: error` is an execution failure, not a failed check. This applies even when the workspace already satisfies every file check; intermediate retry errors are ignored when the final run succeeds.

### `file` Checker Parameters

| Parameter   | Meaning                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`      | Required run-relative path. Absolute paths and `..` are rejected.                                                                                                                                                                                                    |
| `exists`    | Boolean. When present, produces one result. Only a regular file counts as existing; a non-regular path is a check error.                                                                                                                                             |
| `matches`   | A regular expression or list of them. Search semantics apply; a match need not cover the whole file. Each pattern produces one result. Evaluation runs in a worker so a catastrophic expression is terminated by the check deadline or an internal 5-second ceiling. |
| `unchanged` | May only be `true` when present; `false` is a configuration error, and no inverse `changed` feature exists. Compares the file with the initial baseline outside the agent's writable area.                                                                           |

At least one of `exists`, `matches`, or `unchanged` is required. Checks are capped at 1 MiB per file. A missing file is a failed check; an unsafe path, escaping symlink, non-regular file, unreadable file, or oversized file is a check error. Paths that traverse a symlink outside the workspace, including through an ancestor, are rejected rather than inspected.

The engine records the workspace directory's device and inode when it prepares the run. Every file, existence, unchanged, and judge-evidence operation verifies that identity first. If the agent removes the workspace and replaces that path with a symlink or another directory, checks fail with an error and never read the replacement's contents.

The example's `matches` pattern tolerates one optional final newline. The checker does not rewrite or normalize file content.

### `judge` Checker Parameters

| Parameter                      | Meaning                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `model`, `thinking`            | Independent judge model selection.                                                   |
| `rubric`                       | Non-empty list of statements. Each statement produces its own result.                |
| `file`                         | One run-relative evidence file. Missing evidence is stated explicitly in the prompt. |
| `executable`, `envPassthrough` | Same meaning as for the runner.                                                      |

The judge is a separate isolated Pi invocation with tools disabled. It receives the case input and selected file content, not the evaluated workspace or its own process environment besides the explicit allowlist. Evidence must be a regular file. The verdict must be a JSON object with one boolean `pass` and a reason per rubric statement. A valid failing verdict is a failed check; a malformed or missing verdict is a checker error.

### Trusted Implementation Directories

The CLI loads the built-in `pi`, `file`, and `judge` implementations, then optional modules from explicitly supplied operator directories:

```sh
node src/cli.ts run case.yml --case with-skill \
  --runner-dir ./trusted/runners --checker-dir ./trusted/checkers
```

A runner module exports `runner`; a checker module exports `checker`. Each has a non-empty `type`, `validate(params, authoringDir)`, and `create()`. Implementation modules are loaded only from these trusted paths, never from an evaluated workspace.

## Express Checks, Not Evaluation Categories

Do not create separate routing and behavior case types, files, or execution pipelines. Whether a skill was loaded, how an agent acted, and whether its result is correct are concerns expressed through checks and available evidence.

Prefer reusable declarative checks for common needs. Custom code is an extension path, not mandatory boilerplate for every case. A checker may return several results; dimensions such as correctness or constraint adherence are case data, not separate checker classes or fixed global categories.

An LLM judge can accept multiple rubric statements and preserve individual judgments. A list of criteria is sufficient; mandatory category labels are unnecessary. Multiple criteria do not inherently require multiple checker implementations or model calls.

Models and connection settings remain runner or checker parameters. Checkers consume the evaluated run's state and supplied evidence. Required observations must exist: missing tools, inaccessible state, or collection failures must not turn a restraint into a vacuous pass.

## Dataset Organization

Cases may be organized and selected as train, dev, or test data. Here, train may mean examples used to improve prompts, workflows, or configurations rather than model weights.

Train and dev data may be inspected repeatedly during development. Keep test data for held-out validation and avoid exposing its answers to the optimization process. Watch for leakage across related tasks and near-duplicate variants. Manage judge calibration examples separately from the evaluated test sets.

See [architecture](architecture.md) for runtime responsibilities and [M1](m1-plan.md) for the concrete first delivery.
