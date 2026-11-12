# Configuration Reference

The CLI resolves one YAML file into one executable case. Test-design guidance belongs in [Writing Cases](cases.md); module and extension contracts belong in [Architecture](architecture.md).

## Commands

```sh
agent-evals view case.yml [--case name]
agent-evals run case.yml [--case name] [--results-dir path] \
  [--runner-dir path] [--checker-dir path]
```

The development form is `npm run eval -- <command>`; both entry points execute the same built CLI. Flags are parsed by Node's `util.parseArgs`: `--name=value`, separate option values, `--` before dash-prefixed positionals, and `--help`/`-h` are supported. Use `--case=-name` for a dash-prefixed case name.

The trusted-directory options are repeatable and apply only to `run`; they load implementation modules, not working directories. All supplied directories feed the same registry, where duplicate `$type` names are errors rather than ordered overrides.

## One Case or Named Cases

An ordinary document directly declares the complete case:

```yaml
input: Create hello.txt with exactly the content "Hello, world!".
timeoutMs: 120000
runner:
  $type: pi
  model: opencode-go/deepseek-v4.1-flash
  apiKey: $env:OPENCODE_API_KEY
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
      apiKey: $env:OPENCODE_API_KEY
      skills: [skill]
  without-skill:
    runner:
      $type: pi
      model: opencode-go/deepseek-v4.1-flash
      apiKey: $env:OPENCODE_API_KEY
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

Unknown common fields, invalid shapes and duplicate YAML keys are errors. There is one document/file: no `extends`, imported collections, nested `cases` or string interpolation. Explicit parameter references follow the rule below. Null is a value, not omission or deletion.

Anchor declarations, alias nodes and the scalar mapping key `<<` are rejected at every depth, including quoted `<<` keys. Parser warnings, including unknown tags such as `!include`, are errors. Ordinary string values containing `&`, `*`, `<<` or tag-like text remain data; built-in YAML tags that parse without warnings are not categorically banned.

Authoring resources are relative to the YAML file; checker targets are relative to the evaluated workspace. Neither is silently based on the engine's working directory. Credentials are separate runtime inputs from the invocation directory; see [Credentials](../README.md#credentials).

## Values from .env

```yaml
apiKey: $env:KEY # lookup
# apiKey: "$env:KEY"   # literal alternative
```

- Only an unquoted **plain scalar** that completely matches `$env:NAME` is a reference. Quoted and block scalars are literal; embedded text is not interpolated.
- References apply to selected runner/checker parameter values, including nested objects and array elements—not keys, `$type`, or Case-level fields. Arrays remain arrays.
- `run` resolves values once from the invocation `.env`, then applies the implementation schema. Invalid/missing names fail; returned values are not recursively expanded, and strings are not implicitly converted to numbers/booleans.
- `view` does no lookup and preserves the reference/literal distinction. Result declarations stay unexpanded, with reference locations recorded separately.

These are value-source rules, not secrecy rules. Implementations decide how values are used and exposed; the engine does not redact based on parameter names or source. File and command behavior is documented in [Credentials](../README.md#credentials).

## Implementation Records

`$type` selects a registered implementation. All remaining fields belong to its Zod parameter schema; the engine does not understand model, skill or rubric semantics. There is no `params` wrapper, and plain `type` is not the selector.

On `run`, the engine validates each record once, reports schema errors with field paths, and passes inferred output to its factory. Built-in schemas reject unknown fields and do not broadly coerce YAML scalars: `false` and `0` stay typed, quoted numbers/booleans stay strings, and explicit null does not trigger a missing-field default.

### Pi Runner (`$type: pi`)

| Parameter    | Contract                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `model`      | Required non-empty Pi model selector.                                                                                      |
| `thinking`   | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; default `medium`.                                            |
| `skills`     | Explicit config-relative skill files/directories; default empty. Automatic discovery is disabled.                          |
| `apiKey`     | Optional non-empty string; use `$env:NAME` for private storage. Current transport requires `provider/model` when supplied. |
| `executable` | Pi executable name/path; default `pi`.                                                                                     |

The adapter, not the engine, handles Pi authentication and model requirements. The key is passed in the isolated process environment through a non-secret Pi config reference, not argv or a plaintext key file. This requires a compatible Pi build with `models.json` API-key environment interpolation (verified with Pi 1.5.1); custom providers need Pi configuration beyond this adapter.

The runner exposes read/write/edit/bash for one initial message. Operator skills, extensions, MCP servers, sessions and context files are not automatically inherited. A final native assistant error is an execution error; a recovered intermediate retry is not necessarily a failure.

### File Checker (`$type: file`)

| Parameter   | Contract                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`      | Required workspace-relative file path, not absolute and without `..` segments.                                                                           |
| `exists`    | Optional boolean; `false` is supported. Only regular files count.                                                                                        |
| `matches`   | Optional regex string or list, at most 100 patterns. Search semantics, not an implicit whole-file match. Empty/invalid regexes are configuration errors. |
| `unchanged` | Optional literal `true`; compare bytes against the initial baseline. `false` is invalid.                                                                 |

At least one assertion is required; each produces its own result. Regex work runs in a terminable worker with the check deadline and an internal five-second ceiling. File reads are capped at 1 MiB. Missing required files fail checks; unsafe/replaced roots, escaping/broken symlinks, non-regular, oversized or unreadable evidence are errors rather than passes. No content normalization or `includes` alias is provided.

### Judge Checker (`$type: judge`)

| Parameter                                   | Contract                                                  |
| ------------------------------------------- | --------------------------------------------------------- |
| `model`, `thinking`, `executable`, `apiKey` | Same meanings as for Pi; judge invocation is independent. |
| `file`                                      | Required workspace-relative evidence file.                |
| `rubric`                                    | Required non-empty list of non-empty statements.          |

The judge receives the task, selected regular-file evidence (or an explicit missing-file signal), and rubric. Its separate Pi invocation has no tools and no access to the evaluated workspace. Verdict JSON must have exactly one criterion per rubric item, each with boolean `pass` and non-empty `reason`. Extra fields/criterion labels are ignored. Valid negative judgments are `fail`; malformed, absent or wrong-count verdicts are checker errors.

## Inspecting and Recording

`view` uses the same authoring resolver as `run`, then prints the resolved declaration and each top-level field's source file, 1-based declaration line, and common/selected-case origin. Case labels are JSON-escaped. Unquoted references stay unquoted; literal strings resembling references stay quoted. It does not show implementation defaults or invoke implementation schemas, factories, environment lookups or harnesses; it is not a runtime-readiness check.

`run` writes `.agent-evals/<run-id>/result.json` in the invocation directory by default; `--results-dir` changes the root. This is retained report data, not the evaluated workspace. Historical `.eval-results/` directories remain ignored but are not automatically moved. Schema version 2 retains source path/optional case name, declared `resolvedConfig`, runner outcome, individual checks, overall status, diagnostics and cleanup status. Optional `references: [{path, name}]` identifies which declaration strings were references rather than literals. Expanded and schema-normalized/defaulted values do not replace the declaration; implementation outputs are retained normally. Literal keys authored in YAML are declaration data and are not automatically masked. No resource hashes or workspace snapshots are retained, so old resource contents cannot be reconstructed from their unchanged paths.

Overall statuses are `pass`, `fail`, `error`, `timeout`, and `cancelled`; individual checks are `pass`, `fail`, or `error`. Pass/fail summarizes satisfaction of the configured checks, not model/skill quality or an improvement claim. A normal negative judgment is `fail`; inability to execute or evaluate is `error`, with timeout/cancellation reported separately. Exit codes are 0 for pass, 1 for failed checks, and 2 for configuration/execution/checker/timeout/cancellation errors. Early configuration errors need not produce a run record.

## Trusted Extensions

`run` registers the built-ins and can load `.ts`, `.js` or `.mjs` modules from explicitly supplied trusted directories. A runner module exports `runner`; a checker module exports `checker`. Duplicate/unknown types or malformed exports are errors, never fallback reasons.

Extensions use the same schema/factory/instance contracts as built-ins; see [Definitions, Factories, and Instances](architecture.md#definitions-factories-and-instances) and [`registry.ts`](../src/engine/registry.ts). They execute as trusted host code. Never use an agent-writable workspace or generated result directory as an extension discovery root.
