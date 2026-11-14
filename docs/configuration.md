# Configuration Reference

The run/view commands resolve one YAML file into one executable case. ACP preparation helpers instead load a standalone agent configuration. Test-design guidance belongs in [Writing Cases](cases.md); module and extension contracts belong in [Architecture](architecture.md).

## Commands

```sh
agent-evals config agent.yml
agent-evals login agent.yml
agent-evals view case.yml [--case name]
agent-evals run case.yml [--case name] [--results-dir path] \
  [--runner-dir path] [--checker-dir path]
```

The development form is `npm run eval -- <command>`; both entry points execute the same built CLI. Flags are parsed by Node's `util.parseArgs`: `--name=value`, separate option values, `--` before dash-prefixed positionals, and `--help`/`-h` are supported. Use `--case=-name` for a dash-prefixed case name.

The trusted-directory options are repeatable and apply only to `run`; they load implementation modules, not working directories. All supplied directories feed the same registry, where duplicate `$type` names are errors rather than ordered overrides.

## ACP Preparation Helpers

These commands do not take a case. `config` uses `acpCommand`, performs ACP initialization and creates a session, then prints YAML containing `authMethods` and `configOptions` (current values, available values, labels and descriptions as offered by the agent). It sends no prompt. Authentication may be required first. Queries have a 30-second protocol budget; errors and cancellation still tear down the sandbox.

`login` runs `command` with the current terminal's input/output. The sandbox permits termios mode changes (`TIOCSETA`, `TIOCSETAW`, `TIOCSETAF`) only on that terminal and its `/dev/tty` alias, not arbitrary ioctl operations or other devices. Log in using that program's native interface, then exit successfully to save the listed files. It does not derive a login command from the adapter name or use case settings. The helpers reject case/run options such as `--case`.

```yaml
command: [pi]
acpCommand: [pi-acp]
home:
  deps: ${env:PI_DEPS}
  login: ${env:PI_LOGIN}
  path: [.local/bin]
login:
  - .pi/agent/auth.json
```

| Field         | Rule                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `acpCommand`  | Required non-empty argv for the ACP entry point.                                                                     |
| `command`     | Optional native argv; required by the login helper.                                                                  |
| `environment` | Optional mapping of extra variables for both commands. Names other than `HOME`, `TMPDIR`, `PATH` and `TERM`.         |
| `home.deps`   | Required caller-prepared software/settings directory, laid out like HOME.                                            |
| `home.login`  | Optional persistent login directory; required by the login helper. A first login may start with a missing directory. |
| `home.path`   | Required list of HOME-relative command directories, followed by system directories on PATH.                          |
| `login`       | HOME-relative paths describing the login directory's file composition. The login helper requires a non-empty list.   |

The ACP implementation declares one strict Zod schema; unknown fields, invalid argv and unsafe HOME-relative paths are errors. Standalone files use the same YAML restrictions and [placeholders](#placeholders) as case parameters, with `${HOME}` and `${TMPDIR}` naming the command's own directories. Directory paths resolve from the agent file; `.env` remains rooted at the invocation directory. The [ACP runner](#acp-runner-type-acp) takes the same object inline or by path.

The process sees only `HOME` (the assembled HOME), `TMPDIR` (the command's temporary directory), `PATH` (`home.path` entries, then `/usr/bin:/bin:/usr/sbin:/sbin`), `TERM` when the invoking terminal sets it, and the declared `environment`. Nothing else is inherited from the operator. A harness that needs a secret or its own temporary-directory variable declares it, for example the [Claude example](../examples/agents/claude.yml):

```yaml
environment:
  CLAUDE_CODE_OAUTH_TOKEN: ${env:CLAUDE_OAUTH_TOKEN}
  CLAUDE_CODE_TMPDIR: ${TMPDIR}
```

### Claude Code Token

Claude runs on the operator's subscription with a [`claude setup-token`](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) token, not the `login` helper. The token is valid for one year and never refreshed, so idle periods and concurrent runs do not invalidate it. It requires a Pro, Max, Ultra, Team or Enterprise plan and can only make model requests, so claude.ai connectors stay out of the run. Create it once and keep it in the keychain:

```sh
# Opens the browser authorization and prints the token; nothing is saved.
$CLAUDE_DEPS/.local/bin/claude setup-token
# -w last prompts for the token, keeping it out of shell history; -U replaces an old one.
security add-generic-password -U -a "$USER" -s claude-oauth-token -w
```

```dotenv
CLAUDE_OAUTH_TOKEN="!security find-generic-password -w -s claude-oauth-token"
```

When it expires, runs fail with an authentication error; generate a new token and store it the same way. The agent can read the token inside the sandbox, as with any run credential. Heavy automated evaluation should use a Console API key instead (`ANTHROPIC_API_KEY`).

Each command builds a fresh HOME: directories from `deps` are real and their files are read-only links; login files are copied, not linked. Dependencies must be self-contained (directory symlinks and special files are unsupported); only declared software and system directories are readable. The operator's ambient PATH, HOME and credentials are not inherited. Keep login directories evaluation-owned, separate from everyday credentials.

The login helper saves only the declared files after successful native exit, not caches or arbitrary new HOME contents. Existing login files may be refreshed during either command, even before a later failure or cancellation; changed originals are copied back after stopping the sandbox so a refreshed credential is not discarded. New login-file export still requires native success. A command failure or cancellation remains visible if copy-back also fails; secondary cleanup errors are reported alongside it. Copies are regular files with private permissions; unsafe paths, escaping symlinks and special files are rejected. Missing or non-directory deps and non-directory existing login roots are configuration errors checked before runtime allocation. Login/deps file collisions and overlapping roots are errors; deps must not contain the temporary command directory. Other runtime state is removed.

Sandbox cleanup covers ordinary, orphaned and new-session descendants. A private supervisor channel carries the workload exit result; its intentional cleanup SIGKILL is not a successful login result. Forced supervisor death is not a recoverable cleanup guarantee. These helpers do not impose a hard resource/cost isolation boundary.

Pi may download `fd` and `rg` during interactive startup if they are missing. Prepare those tools in `deps` for normal use; an offline UI check can instead use `command: [/usr/bin/env, PI_OFFLINE=1, pi]` to skip automatic downloads. This is explicit harness configuration, not engine-specific behavior.

Examples: [Pi](../examples/agents/pi.yml), [Claude](../examples/agents/claude.yml). Both run unchanged through the same implementation, which contains no harness-specific exceptions; their comments say what each `deps` holds.

## One Case or Named Cases

An ordinary document directly declares the complete case:

```yaml
input: Create hello.txt with exactly the content "Hello, world!".
timeoutMs: 120000
runner:
  $type: pi
  model: opencode-go/deepseek-v4.1-flash
  apiKey: ${env:OPENCODE_API_KEY}
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
      apiKey: ${env:OPENCODE_API_KEY}
      skills: [skill]
  without-skill:
    runner:
      $type: pi
      model: opencode-go/deepseek-v4.1-flash
      apiKey: ${env:OPENCODE_API_KEY}
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
| `fixture`   | Optional directory relative to this YAML, copied into the workspace root. Omission starts an empty workspace.                                       |
| `files`     | Optional mapping from a workspace-relative destination (`.` is the root) to an authoring file or directory, placed after the fixture.               |
| `timeoutMs` | Optional positive integer milliseconds; defaults to 300000. Bounds runner execution and is also each check's budget, not the whole run's wall time. |
| `mocks`     | Optional declared collaborator substitutes; see [Mocks](#mocks).                                                                                    |
| `cases`     | Optional document-level selection control; not passed to execution.                                                                                 |

Unknown common fields, invalid shapes and duplicate YAML keys are errors. There is one document/file: no `extends`, imported collections or nested `cases`. Implementation parameters may contain [placeholders](#placeholders). Null is a value, not omission or deletion.

Anchor declarations, alias nodes and the scalar mapping key `<<` are rejected at every depth, including quoted `<<` keys. Parser warnings, including unknown tags such as `!include`, are errors. Ordinary string values containing `&`, `*`, `<<` or tag-like text remain data; built-in YAML tags that parse without warnings are not categorically banned.

Authoring resources are relative to the YAML file; checker targets are relative to the evaluated workspace. Neither is silently based on the engine's working directory. Credentials are separate runtime inputs from the invocation directory; see [Credentials](../README.md#credentials).

### Fixture and Files

`fixture` is the base environment. `files` is the per-case variation layered on top: each key is a workspace-relative destination (`.` is the root, never absolute and never containing `..`) and each value is an authoring file or directory resolved like `fixture`.

- An entry may replace a file that came from `fixture`; that is the common "same base, one changed file" case.
- Entries may not overwrite each other: two entries producing the same file path are an error. Directory entries merge.
- A file arriving where a directory exists, or a directory where a file exists, is an error rather than a replacement, whether the existing path came from `fixture` or from another entry.
- Placement happens after the fixture copy and before the baseline snapshot, so placed files are part of the baseline and `unchanged` covers them.

The engine only copies; it assigns no meaning to a destination and knows no harness paths. A project-level skill is one use: place its directory where the harness discovers it, for example `.agents/skills/` for Pi or `.claude/skills/` for Claude Code.

## Mocks

A case may replace a `PATH` command with a fixed result. The evaluated process still resolves and runs the command; the engine answers on the host and records the call.

```yaml
mocks:
  shell:
    make:
      return:
        exitCode: 1
        stderr: "release commands are disabled\n"
    npm:
      return: {}
```

| Field             | Contract                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `shell`           | Required mapping from a bare command name to one rule. Names may not contain `/`.          |
| `<name>.return`   | Required fixed result. `exitCode` defaults to `0`, `stdout` and `stderr` to empty strings. |
| `return.exitCode` | Integer 0–255.                                                                             |
| `return.stdout`   | String written to the call's standard output, used exactly as written.                     |
| `return.stderr`   | String written to the call's standard error, used exactly as written.                      |

Only this subset is implemented. `args`, `run`, `pass`, a list of rules and workspace-relative targets are configuration errors, as are unknown fields, so unsupported syntax never silently falls back to the real command. Mock text is literal data: [placeholders](#placeholders) are not expanded.

Mocks need a runner that can wire them, which today is `acp` only; declaring them on the native `pi` runner is a configuration error before any run directory exists. Inside the sandbox each name is a thin forwarder ahead of `home.path` on `PATH`, and the result and the call records stay on the host. Only calls looked up through `PATH` are intercepted: absolute paths, shell builtins and a command already resolved to another path are not. Standard input is not forwarded. Standard output and error arrive after the call completes, not streamed, and their original interleaving is lost. A command whose forwarder cannot reach the host fails with exit code 126.

Calls from scripts are intercepted because children inherit `PATH`. Undeclared commands resolve as usual and are not recorded. Nothing hides the forwarder: `which` and reading it reveal that the command is substituted, never the rules, results or records.

## Placeholders

```yaml
apiKey: ${env:OPENCODE_API_KEY} # a value from the invocation .env
url: https://${env:HOST}/v1 # embedded in text
cache: ${TMPDIR}/cache # a built-in variable
note: write $${env:X} # $${ is a literal ${
```

- `${env:NAME}` reads `NAME` from the invocation `.env` ([Credentials](../README.md#credentials)). `${NAME}` reads a built-in variable: `HOME` and `TMPDIR` are the run's HOME and temporary directory, the same directories the runner gives its process; a preparation helper uses its own. Other sources and names are errors; nothing falls back to the operator's environment.
- Placeholders apply to every string in the selected runner/checker parameters, nested objects and arrays included, and in standalone agent files—not keys, `$type` or Case-level fields. YAML quoting does not change them.
- The engine chooses the run directories' paths first, substitutes, applies the implementation schema, and only then creates the directories. Substituted text is not scanned again and is not converted to numbers or booleans. Malformed placeholders in the selected case fail at load, also for `view`; a missing `.env` name fails before any run resource exists.
- `view` and result declarations show placeholders unsubstituted; the declared text itself says which parts are placeholders.

These are value-source rules, not secrecy rules. Implementations decide how values are used and exposed; the engine does not redact based on parameter names or source. File and command behavior is documented in [Credentials](../README.md#credentials).

## Implementation Records

`$type` selects a registered implementation. All remaining fields belong to its Zod parameter schema; the engine does not understand model, skill or rubric semantics. There is no `params` wrapper, and plain `type` is not the selector.

On `run`, the engine validates each record once, reports schema errors with field paths, and passes inferred output to its factory. Built-in schemas reject unknown fields and do not broadly coerce YAML scalars: `false` and `0` stay typed, quoted numbers/booleans stay strings, and explicit null does not trigger a missing-field default.

### Pi Runner (`$type: pi`)

| Parameter    | Contract                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `model`      | Required non-empty Pi model selector.                                                                                        |
| `thinking`   | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; default `medium`.                                              |
| `skills`     | Explicit config-relative skill files/directories; default empty. Automatic discovery is disabled.                            |
| `apiKey`     | Optional non-empty string; use `${env:NAME}` for private storage. Current transport requires `provider/model` when supplied. |
| `executable` | Pi executable name/path; default `pi`.                                                                                       |

The adapter, not the engine, handles Pi authentication and model requirements. The key is passed in the isolated process environment through a non-secret Pi config reference, not argv or a plaintext key file. This requires a compatible Pi build with `models.json` API-key environment interpolation (verified with Pi 1.5.1); custom providers need Pi configuration beyond this adapter.

The runner exposes read/write/edit/bash for one initial message. Operator skills, extensions, MCP servers, sessions and context files are not automatically inherited. A final native assistant error is an execution error; a recovered intermediate retry is not necessarily a failure.

### ACP Runner (`$type: acp`)

```yaml
runner:
  $type: acp
  agent: ../../agents/pi.yml # or inline the same object
  config:
    model: opencode-go/deepseek-v4.1-flash
```

| Parameter | Contract                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`   | Required. An inline [agent object](#acp-preparation-helpers), or a config-relative path to a standalone file holding one. `acpCommand`, `environment` and `home` are used.     |
| `config`  | Optional mapping of session config values (string or boolean), applied in declaration order. A key names an option's category when exactly one has it, otherwise an option ID. |

A path-referenced file resolves its own directories from its location and its placeholders like the case's own parameters; an inline object is part of them. Missing deps or an invalid login root are configuration errors before any run resource exists.

Each run assembles the harness home in the run's own HOME exactly as the helpers do, starts `acpCommand` in the workspace under the same sandbox, creates one session, applies `config`, then sends the input as one prompt. `agent-evals config <agent.yml>` lists the offered options. A key matching no option, or a value the agent does not offer, fails the run before prompting; set `model` first because other choices may depend on it. Skills and project settings come from the prepared workspace (`fixture` and `files`), not runner parameters.
The run completes only when the turn ends with `end_turn`; any other stop reason, an agent exit or a protocol error is an execution error. The runner records a [trace](#inspecting-and-recording); output is the agent's text after its last tool call. Permission requests are approved (`allow_once`, else `allow_always`): the sandbox is the boundary. On completion, timeout or cancellation the whole sandbox is stopped, then changed original login files are copied back. Only the workspace, the run HOME and its temporary directory are writable; deps is read-only, and the baseline, policy and case files are unreadable. With [`mocks`](#mocks), the runner puts the forwarder directory first on the process `PATH` and makes it readable but not writable inside the sandbox.

Example: [`deploy-runbook`](../examples/cases/deploy-runbook/case.yml), whose Pi and Claude cases share one fixture and differ in agent, model and whether `files` places `skill` where that harness discovers it (`.agents/skills/` or `.claude/skills/`).

### File Checker (`$type: file`)

| Parameter   | Contract                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`      | Required workspace-relative file path, not absolute and without `..` segments.                                                                           |
| `exists`    | Optional boolean; `false` is supported. Only regular files count.                                                                                        |
| `matches`   | Optional regex string or list, at most 100 patterns. Search semantics, not an implicit whole-file match. Empty/invalid regexes are configuration errors. |
| `unchanged` | Optional literal `true`; compare bytes against the initial baseline. `false` is invalid.                                                                 |

At least one assertion is required; each produces its own result. Regex work runs in a terminable worker with the check deadline and an internal five-second ceiling. File reads are capped at 1 MiB. Missing required files fail checks; unsafe/replaced roots, escaping/broken symlinks, non-regular, oversized or unreadable evidence are errors rather than passes. No content normalization or `includes` alias is provided.

### Judge Checker (`$type: judge`)

| Parameter                                   | Contract                                                   |
| ------------------------------------------- | ---------------------------------------------------------- |
| `model`, `thinking`, `executable`, `apiKey` | Same meanings as for Pi; judge invocation is independent.  |
| `file`                                      | Optional workspace-relative evidence file.                 |
| `trace`                                     | Optional literal `true`: give the run's trace as evidence. |
| `rubric`                                    | Required non-empty list of non-empty statements.           |

At least one of `file` and `trace` is required; with both, every statement is judged against both.

```yaml
- $type: judge
  model: opencode-go/deepseek-v4.1-flash
  apiKey: ${env:OPENCODE_API_KEY}
  trace: true
  rubric:
    - The agent consulted the deploy-runbook skill before writing the diagnosis.
```

The judge receives the task, the selected regular-file evidence (or an explicit missing-file signal), the rendered trace, and the rubric. The trace is rendered in run order without cutting: messages, reasoning, and each tool call's title, kind, status, input and output. Use it for process questions a fixed rule cannot answer across harnesses, such as whether a skill was consulted (Pi reads `SKILL.md`; Claude calls a skill tool). A requested call shows what the agent asked for, not every effect, and harnesses differ in what they report (reasoning may be absent). `trace: true` with a runner that records no trace, such as the native Pi runner, is a checker error. Its separate Pi invocation has no tools and no access to the evaluated workspace. Verdict JSON must have exactly one criterion per rubric item, each with boolean `pass` and non-empty `reason`. Extra fields/criterion labels are ignored. Valid negative judgments are `fail`; malformed, absent or wrong-count verdicts are checker errors.

## Inspecting and Recording

`view` uses the same authoring resolver as `run`, then prints the resolved declaration and each top-level field's source file, 1-based declaration line, and common/selected-case origin. Case labels are JSON-escaped. Placeholders are shown unsubstituted. It does not show implementation defaults or invoke implementation schemas, factories, environment lookups or harnesses; it is not a runtime-readiness check.

`run` writes `.agent-evals/<run-id>/result.json` in the invocation directory by default; `--results-dir` changes the root. This is retained report data, not the evaluated workspace. Schema version 1 retains source path/optional case name, declared `resolvedConfig`, runner outcome, individual checks, overall status, diagnostics and cleanup status. Substituted and schema-normalized/defaulted values do not replace the declaration; implementation outputs are retained normally. A runner that records a trace (currently `acp`) also writes `trace.json` beside it, including for failed, timed-out or cancelled runs: an ordered list of `message` and `thought` entries (consecutive chunks joined) and `tool` entries. ACP updates replace the fields they carry, so each tool entry is one `toolCallId` in its final state with the harness's own fields (`title`, `kind`, `status`, `rawInput`, `content`, ...); intermediate states are not kept. Non-text content and other session updates are not recorded. A case that declares [`mocks`](#mocks) also writes `interactions.json`: the calls that reached a mocked command in arrival order, each as a `target` and its `arguments`. It holds no output or exit code and no judgment. The [judge](#judge-checker-type-judge) can take the trace as evidence; field meanings differ between harnesses, so there are no field-level trace assertions. Literal keys authored in YAML are declaration data and are not automatically masked. No resource hashes or workspace snapshots are retained, so old resource contents cannot be reconstructed from their unchanged paths.

Overall statuses are `pass`, `fail`, `error`, `timeout`, and `cancelled`; individual checks are `pass`, `fail`, or `error`. Pass/fail summarizes satisfaction of the configured checks, not model/skill quality or an improvement claim. A normal negative judgment is `fail`; inability to execute or evaluate is `error`, with timeout/cancellation reported separately. Exit codes are 0 for pass, 1 for failed checks, and 2 for configuration/execution/checker/timeout/cancellation errors. Early configuration errors need not produce a run record.

## Trusted Extensions

`run` registers the built-ins and can load `.ts`, `.js` or `.mjs` modules from explicitly supplied trusted directories. A runner module exports `runner`; a checker module exports `checker`. Duplicate/unknown types or malformed exports are errors, never fallback reasons.

Extensions use the same schema/factory/instance contracts as built-ins; see [Definitions, Factories, and Instances](architecture.md#definitions-factories-and-instances) and [`registry.ts`](../src/engine/registry.ts). They execute as trusted host code. Never use an agent-writable workspace or generated result directory as an extension discovery root.
