# Case Configuration

Status: implemented M1 authoring revision. The CLI uses one configuration file; see [supported records](cases.md#implemented-records).

This scope supersedes the earlier `extends` and recursive-override proposal. Support one file and disjoint top-level composition only. Do not implement inheritance, nested merging, deletion operators, or automatic migration between implementation types.

## Case and Run

- A **case** is a complete executable test definition: its task, initial environment, runner configuration, checks, and execution requirements.
- An **authoring document** contains either one ordinary case or common top-level fields plus a mapping of named cases.
- **Common fields** are invariants shared by the cases in that document, not overridable defaults.
- A **resolved case** combines those common fields with one selected case entry. Only the complete result is executed.
- A **run** is one actual execution of one resolved case, with independent runtime state and a retained result.

Do not require Candidate, Subject, or Variant entities or files. Named cases are ordinary tests, not a special A/B pipeline. Names such as `with-skill`, `without-skill`, and `baseline` are author-defined identifiers for selection and result labeling; they have no built-in behavior. A collection need not be a comparison group.

A case may be specific to a skill or capability. Reuse tests across implementations when expectations are genuinely shared; do not require every case to support every skill or harness. Repeatedly execute saved tests against the current content of their referenced resources instead of requiring a new configuration or manually entered version number for every run.

## Ordinary Single-Case Documents

Write simple tests directly, without a `case`, `subject`, or `candidate` wrapper:

```yaml
input: Create hello.txt with exactly the content "Hello, world!".
timeoutMs: 120000

runner:
  $type: pi
  model: opencode-go/deepseek-v4.1-flash

checks:
  - $type: file
    path: hello.txt
    exists: true
    matches: '^Hello, world!\n?$'
```

Without `cases`, the document resolves to one ordinary case. Without `fixture`, it starts from an empty workspace. Provider credentials come from the run invocation `.env`, not YAML; see [Credentials](../README.md#credentials). `view` does not read or resolve them.

## Common Fields and Named Cases

Use `cases` when several tests share top-level fields:

````yaml
input: Create hello.txt with exactly the content "Hello, world!".
timeoutMs: 120000

checks:
  - $type: file
    path: hello.txt
    exists: true
    matches: '^Hello, world!\n?$'

cases:
  with-skill:
    runner:
      $type: pi
      model: opencode-go/deepseek-v4.1-flash
      skills: [skill]

  without-skill:
    runner:
      $type: pi
      model: opencode-go/deepseek-v4.1-flash
      skills: []
    ```

Each named entry provides a complete `runner` because that top-level field varies. Repeating the otherwise identical runner parameters is intentional for this revision; finer-grained runner reuse is not part of this design.

The resolver does not understand these labels or skill parameters. The Pi runner interprets `skills`; its existing automatic-discovery restrictions make an empty list meaningful. Other runners can use different parameters.

The common part is not executed as an extra unnamed case. Execute a selected case through the ordinary single-case execution path. A helper may iterate over cases without introducing a separate lifecycle or requiring that their results be compared.

## Case Selection and Identity

- When `cases` is present, require a non-empty mapping whose names are non-empty strings and whose entries are mappings.
- Require an explicit selection from that mapping, even if it contains only one entry. A missing or unknown selection is an error; do not implicitly execute all cases.
- A document without `cases` is one ordinary case and does not require a synthetic name.
- Identify a run's case by its source configuration path and optional selected case name. Names are metadata, not filesystem paths; do not use them to construct result directories.

## Disjoint Top-Level Composition

For each selected case:

1. Treat document fields other than `cases` as the common fields.
2. Reject any top-level field present in both the common fields and that case entry.
3. Combine the two disjoint sets of fields without inspecting or merging their contents.
4. Validate the complete resolved case before runtime execution.

Collision detection is by top-level key, even when both values are identical. In particular, common `runner` plus case-local `runner` is an error, even if one contains `model` and the other only `skills`. Do not recurse to decide whether their nested fields differ.

Different case entries may contain the same top-level keys; they are resolved independently, not combined with one another. A field that varies must be defined in the relevant case entries rather than the common part. If `fixture` applies only to some cases, for example, put it in those entries instead of introducing removal syntax.

Mappings and arrays are whole values supplied by one side. There is no array append, scalar override, special `$type` replacement rule, or `null` deletion behavior. A null value is ordinary YAML data and remains subject to the final field/implementation schema. Common fragments and named entries do not each have to be executable on their own, but their resolved combination must be complete.

`cases` is a document-level authoring control, not a field passed to a runner or checker. Within implementation records, `$type` still selects the implementation and all other fields remain implementation-owned. The engine does not add special meanings for model, thinking, skills, or rubric.

## Scope and Path Origins

Use one file. Do not support `extends`, imported case collections, nested `cases` inside a case entry, template interpolation, a variable-expression language, or implicit environment expansion in this revision.

Reject YAML anchor declarations and alias nodes. Also reserve and reject the scalar mapping key `<<` in every mapping, including quoted keys: the current parser treats it as an ordinary string key, so do not depend on a special merge-node type to detect it. Ordinary string values containing characters such as `&`, `*`, or `<<` remain data; rejection must inspect the parsed structure rather than search the source text.

Parser warnings, including unresolved application tags such as `!include`, are configuration errors. Literal tag-like text in an ordinary string remains data, and built-in YAML tags that parse without warnings remain supported.

These parser behaviors were verified against the installed `yaml` library: ordinary aliases resolve; both plain and quoted `<<` keys remain ordinary keys without inherited-field expansion when merge handling is disabled; quoted string values containing reuse-like text have no anchor/alias nodes. The new format must explicitly reject the reserved structures rather than rely on library defaults.

All authoring assets are relative to that file's directory. Check targets remain relative to the evaluated workspace. One declaring directory per runner/checker record is sufficient; do not add a per-field source-directory API for a multi-file problem that this scope does not have.

For each final top-level field, preserve its source file, the 1-based line of that field's declaration, and whether it came from the common part or the selected named case. This is the required annotation granularity for `view`. Nested values share their top-level field's origin; per-leaf-value line annotations and override history are not required.

File names have no semantic meaning. A file called `skills.yml` does not activate a skill-specific mode.

## Read-Only `view`

Provide a `view` operation that displays the resolved case with the top-level source annotations defined above. It must not launch a harness, invoke a model, require provider credentials, or fetch credential values from the environment.

Use the same composition function and resolved values for inspection and execution. Inspection can report parse, structural, and top-level collision errors without runtime preparation. It does not establish that runtime prerequisites such as provider credentials or the harness executable are available; execution performs the full implementation/runtime validation before launching anything.

Do not call implementation parameter schemas or `create` from `view`: schema validation is the run-path parameter boundary, and `create` also performs readiness checks such as executable/platform availability and required provider-credential resolution. `view` therefore performs YAML, structural, and top-level collision validation only. It does not validate implementation parameters or establish runtime readiness.

The implemented commands are:

```sh
agent-evals view <config.yml> [--case <name>]
agent-evals run <config.yml> [--case <name>] [--results-dir <path>] \
  [--runner-dir <path>] [--checker-dir <path>]
````

The installed `agent-evals` command and the development `npm run eval -- <command>` form execute the same built `dist/cli.js`. `view` prints the resolved configuration followed by one `field: origin` line per top-level field, where the origin is `common` or `case <JSON-string>`, and includes the source file and 1-based declaration line. Case labels are JSON-escaped so newline and control characters cannot inject additional output structure. `run` prints the run status and writes the result record.

## Run Records and Implementation Boundary

Retain the actual resolved, non-sensitive configuration passed to execution, together with the source configuration path and optional case name. This is part of the revision: changing YAML later must not erase which declared parameters an old run used.

Resource-directory or fixture hashing, content/version identifiers, and resource snapshots are outside this revision's acceptance. An unchanged path does not prove unchanged content: the retained configuration alone cannot recover the earlier skill or fixture contents and does not guarantee complete reproduction. Do not imply those stronger guarantees in results or documentation.

Do not retain secret values or credential values. Credentials are not part of the declared case configuration. This small configuration record is not a commitment to a generic tracer or offline regrading of all checks.

The single-file format, `view`, top-level source annotations, and resolved-configuration retention are implemented. A result record stores the source path, optional case name, and the non-sensitive resolved configuration under `resolvedConfig`; it does not include environment values or provide resource snapshots.

See [cases and configuration](cases.md) for shared authoring and implementation-selection rules, [architecture](architecture.md) for responsibilities, and [M1](m1-plan.md) for the delivered behavior.
