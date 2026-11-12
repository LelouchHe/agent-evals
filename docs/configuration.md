# Configuration Reference

The CLI resolves one YAML file into one executable case. Test-design guidance belongs in [Writing Cases](cases.md); module and extension contracts belong in [Architecture](architecture.md).

## Commands

```sh
agent-evals view case.yml [--case name]
agent-evals run case.yml [--case name] [--results-dir path] \
  [--runner-dir path] [--checker-dir path]
```

The development form is `npm run eval -- <command>`; both entry points execute the same built CLI. The trusted-directory options are repeatable and apply only to `run`.

## One Case or Named Cases

An ordinary document directly declares the complete case:

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

For several cases, common top-level fields sit beside `cases`; each entry supplies the fields absent from the common part. For example, replace the `runner` above with:

```yaml
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

Select a name explicitly, even with one entry. `cases` must be a non-empty mapping of non-empty string names to mappings. Missing/unknown selection is an error; an ordinary document rejects an unnecessary name. The common part is never executed as an extra unnamed case.

**Composition is a disjoint top-level union.** A field repeated between common fields and the selected entry is an error, even with equal values or different nested fields. Common `runner` and case-local `runner` cannot coexist. Siblings are independent; put the complete varying field in each case. There is no recursive merge, override, array append or deletion operator. Names have no built-in skill/comparison behavior and are never result-directory paths.

## Common Fields and Parsing

| Field       | Contract                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`     | Required non-empty initial user message.                                                                                                            |
| `runner`    | Required implementation record.                                                                                                                     |
| `checks`    | Required non-empty list of implementation records.                                                                                                  |
| `fixture`   | Optional directory relative to this YAML. Omission starts an empty workspace.                                                                       |
| `timeoutMs` | Optional positive integer milliseconds; defaults to 300000. Bounds runner execution and is also each check's budget, not the whole run's wall time. |
| `cases`     | Optional document-level selection control; not passed to execution.                                                                                 |

Unknown common fields, invalid shapes and duplicate YAML keys are errors. There is one document/file: no `extends`, imported collections, nested `cases`, template interpolation, or implicit environment expansion. Null is a value, not omission or deletion.

Anchor declarations, alias nodes and the scalar mapping key `<<` are rejected at every depth, including quoted `<<` keys. Parser warnings, including unknown tags such as `!include`, are errors. Ordinary string values containing `&`, `*`, `<<` or tag-like text remain data; built-in YAML tags that parse without warnings are not categorically banned.

Authoring resources are relative to the YAML file; checker targets are relative to the evaluated workspace. Neither is silently based on the engine's working directory. Credentials are separate runtime inputs from the invocation directory; see [Credentials](../README.md#credentials).

## Implementation Records

`$type` selects a registered implementation. All remaining fields belong to its Zod parameter schema; the engine does not understand model, skill or rubric semantics. There is no `params` wrapper, and plain `type` is not the selector.

On `run`, the engine validates each record once, reports schema errors with field paths, and passes inferred output to its factory. Built-in schemas reject unknown fields and do not broadly coerce YAML scalars: `false` and `0` stay typed, quoted numbers/booleans stay strings, and explicit null does not trigger a missing-field default. `envPassthrough` is not a supported parameter.

### Pi Runner (`$type: pi`)

| Parameter    | Contract                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `model`      | Required non-empty Pi model selector, normally `provider/model`.                                  |
| `thinking`   | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; default `medium`.                   |
| `skills`     | Explicit config-relative skill files/directories; default empty. Automatic discovery is disabled. |
| `executable` | Pi executable name/path; default `pi`.                                                            |

The runner exposes read/write/edit/bash tools for one initial message with autonomous tool turns. Operator skills, extensions, MCP servers, sessions, context files, prompt templates and themes are not automatically inherited. A final native assistant error is an execution error, even if files already satisfy checks; a recovered intermediate retry is not necessarily a failure.

### File Checker (`$type: file`)

| Parameter   | Contract                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`      | Required workspace-relative file path, not absolute and without `..` segments.                                                                           |
| `exists`    | Optional boolean; `false` is supported. Only regular files count.                                                                                        |
| `matches`   | Optional regex string or list, at most 100 patterns. Search semantics, not an implicit whole-file match. Empty/invalid regexes are configuration errors. |
| `unchanged` | Optional literal `true`; compare bytes against the initial baseline. `false` is invalid.                                                                 |

At least one assertion is required; each produces its own result. Regex work runs in a terminable worker with the check deadline and an internal five-second ceiling. File reads are capped at 1 MiB. Missing required files fail checks; unsafe/replaced roots, escaping/broken symlinks, non-regular, oversized or unreadable evidence are errors rather than passes. No content normalization or `includes` alias is provided.

### Judge Checker (`$type: judge`)

| Parameter                         | Contract                                                  |
| --------------------------------- | --------------------------------------------------------- |
| `model`, `thinking`, `executable` | Same meanings as for Pi; judge invocation is independent. |
| `file`                            | Required workspace-relative evidence file.                |
| `rubric`                          | Required non-empty list of non-empty statements.          |

The judge receives the task, selected regular-file evidence (or an explicit missing-file signal), and rubric. Its separate Pi invocation has no tools and no access to the evaluated workspace. Verdict JSON must have exactly one criterion per rubric item, each with boolean `pass` and non-empty `reason`. Extra fields/criterion labels are ignored. Valid negative judgments are `fail`; malformed, absent or wrong-count verdicts are checker errors.

## Inspecting and Recording

`view` uses the same authoring resolver as `run`, then prints the resolved declaration and each top-level field's source file, 1-based declaration line, and common/selected-case origin. Case labels are JSON-escaped. It does not show implementation defaults or invoke implementation schemas, factories, credential lookups or harnesses; it is not a runtime-readiness check.

`run` writes `.eval-results/<run-id>/result.json` by default. Schema version 2 retains source path/optional case name, declared `resolvedConfig`, runner outcome, individual checks, overall status, diagnostics and cleanup status. Credentials and schema-normalized/defaulted values do not replace the declaration. No resource hashes or workspace snapshots are retained, so old resource contents cannot be reconstructed from their unchanged paths.

Overall statuses are `pass`, `fail`, `error`, `timeout`, and `cancelled`; individual checks are `pass`, `fail`, or `error`. Exit codes are 0 for pass, 1 for failed checks, and 2 for configuration/execution/checker/timeout/cancellation errors. Early configuration errors need not produce a run record.

## Trusted Extensions

`run` registers the built-ins and can load `.ts`, `.js` or `.mjs` modules from explicitly supplied trusted directories. A runner module exports `runner`; a checker module exports `checker`. Duplicate/unknown types or malformed exports are errors, never fallback reasons.

Extensions use the same schema/factory/instance contracts as built-ins; see [Definitions, Factories, and Instances](architecture.md#definitions-factories-and-instances) and [`registry.ts`](../src/engine/registry.ts). They execute as trusted host code. Never use an agent-writable workspace or generated result directory as an extension discovery root.
