# Configuration Reference

The run/view commands resolve one YAML file into one executable case. ACP preparation helpers instead load a standalone agent configuration. Test-design guidance belongs in [Writing Cases](cases.md); module composition belongs in [Architecture](architecture.md) and the runner and checker contracts in [Extensions](extensions.md).

## Commands

```sh
agent-evals setup sandbox [--teardown]
agent-evals config agent.yml
agent-evals login agent.yml
agent-evals view case.yml [--case name] [--files]
agent-evals run case.yml [--case name] [--reps n] [--jobs n] \
  [--retain none|on-failure|all] [--results-dir path] [--extension-dir path]
agent-evals report results-dir... [--matrix]
```

The development form is `npm run eval -- <command>`; both entry points execute the same built CLI. Flags are parsed by Node's `util.parseArgs`: `--name=value`, separate option values, `--` before dash-prefixed positionals, `--version`/`-V`, and `--help`/`-h` are supported. Use `--case=-name` for a dash-prefixed case name.

`run` on a `cases` document without `--case` executes every entry serially, in declaration order ([selection and summary](#one-case-or-named-cases)). A document with one ordinary case is unchanged.

The trusted-directory option is repeatable and applies only to `run`; it names extension roots holding implementations, not working directories. All supplied roots feed the same registry, where duplicate `$type` names are errors rather than ordered overrides.

## Agent Files

An agent file describes one caller-prepared harness. `config` and `login` load it standalone; the [ACP runner](#acp-runner-type-acp) takes the same object inline or by path, so the same file configures queries and runs.

```yaml
acpCommand: [claude-agent-acp]
deps: ${env:CLAUDE_DEPS}
path: [bin]
environment:
  CLAUDE_CODE_OAUTH_TOKEN: ${env:CLAUDE_OAUTH_TOKEN}
  CLAUDE_CODE_TMPDIR: ${TMPDIR}
files:
  ~/.claude/settings.json: claude-settings.json
login:
  command: [claude]
  dir: ${env:CLAUDE_LOGIN}
  files: [.claude.json]
```

This is the [Claude example](../examples/agents/claude.yml) with `path` spelled out: the credential comes from `.env` through `environment`, and `login` keeps Claude Code's state file between runs. The [Pi](../examples/agents/pi.yml) and [Copilot](../examples/agents/copilot.yml) examples need no `login`; see [when login state is needed](setup.md#credentials-environment-first-login-state-only-when-required).

| Field         | Rule                                                                                                                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acpCommand`  | Required non-empty argv for the ACP entry point.                                                                                                                                                                                                                                                                      |
| `environment` | Optional mapping of extra variables for both commands. Names other than `HOME`, `TMPDIR`, `PATH` and `TERM`.                                                                                                                                                                                                          |
| `deps`        | Required caller-prepared software directory. It is linked into the run as `deps`; the engine never copies or mirrors it.                                                                                                                                                                                              |
| `path`        | Optional `deps`-relative command directories; default `[bin]`. `PATH` is each entry under `run-xxxx/deps/`, then `/usr/bin:/bin:/usr/sbin:/sbin`.                                                                                                                                                                     |
| `files`       | Optional mapping from a `~/` destination to an authoring source relative to the agent file. Copied into the run HOME before login state and the case's `~/` entries.                                                                                                                                                  |
| `login`       | Optional. `command` is the native argv the login helper runs, `dir` the persistent login directory (it may not exist before the first login), `files` its composition. Prefer `environment` for credentials; see [when login state is needed](setup.md#credentials-environment-first-login-state-only-when-required). |

The ACP implementation declares one strict Zod schema; unknown fields, invalid argv, a `files` destination that does not start with `~/`, and unsafe relative paths are errors. Standalone files use the same YAML restrictions and [placeholders](#placeholders) as case parameters, with `${HOME}` and `${TMPDIR}` naming the command's own directories. Directory paths resolve from the agent file; `.env` remains rooted at the invocation directory.

`config` performs ACP initialization and creates a session, then prints YAML containing `authMethods` and `configOptions` (current values, available values, labels and descriptions as offered by the agent). It sends no prompt. Authentication may be required first. Queries have a 30-second protocol budget; errors and cancellation still tear down the sandbox. `login` runs `login.command` with the current terminal's input/output, and the sandbox permits termios mode changes (`TIOCSETA`, `TIOCSETAW`, `TIOCSETAF`) only on that terminal and its `/dev/tty` alias, not arbitrary ioctl operations or other devices. Log in using that program's native interface, then exit successfully to save the declared files. Neither helper derives a command from the adapter name. Both reject case/run options such as `--case`.

The process sees only `HOME` (the run HOME), `TMPDIR` (the run's temporary directory), `PATH` (the `path` entries under the run's `deps`, then the system directories), `TERM` when the invoking terminal sets it, and the declared `environment`. Nothing else is inherited from the operator. A harness that needs a secret or its own temporary-directory variable declares it in `environment`; see [Setup](setup.md#prepare-acp-harnesses) for step-by-step Pi, Claude Code and Copilot CLI preparation.

### What One Run Assembles

- **`deps`** is one directory symlink at the run root. The software is referenced in place and executes from its real location; only `deps` and the system directories are readable, and neither is writable. Resolving the link reveals the host path.
- **HOME** starts from the agent file's `files`, then the declared login files are copied in, then the case's `~/` entries ([placement](#fixture-and-files)). The case may replace an agent-placed file and merges into directories; nothing may place over a login file.
- **Login files** are only the declared `login.files`. A declared file that does not exist on a first login is simply absent; `login` saves the ones the harness created. Existing login files may be refreshed during either command or a run, even before a later failure or cancellation; changed originals are copied back after the sandbox stops so a refreshed credential is not discarded.
- **Login state is copied, not linked**, because harnesses lock, rewrite or rotate refresh tokens in place. Copies are regular files with private permissions; unsafe paths, escaping symlinks and special files are rejected.
- **`HOME` never holds the software.** A harness's caches, sessions, model stores and other state land in the writable `home/` and disappear with the run. The harness settings live beside the agent file, not in a prepared copy, so there is no intermediate tree to drift.

Missing or non-directory `deps` and non-directory existing login directories are configuration errors checked before runtime allocation. `deps` and `login.dir` must not overlap, `deps` must not contain the run directory, an agent `files` destination must not collide with a declared login file, and a case `~/` entry must not either. Other runtime state is removed.

Sandbox cleanup covers ordinary, orphaned and new-session descendants. A private supervisor channel carries the workload exit result; its intentional cleanup SIGKILL is not a successful login result. Forced supervisor death is not a recoverable cleanup guarantee. These commands do not impose a hard resource/cost isolation boundary.

Pi may download `fd` and `rg` during interactive startup if they are missing. A prepared copy belongs in `deps` (for example `deps/bin/fd`); Pi's own downloads land under `HOME` and disappear with the run. An offline UI check can instead use `acpCommand: [/usr/bin/env, PI_OFFLINE=1, pi]` to skip automatic downloads. This is explicit harness configuration, not engine-specific behavior.

Examples: [Pi](../examples/agents/pi.yml), [Claude](../examples/agents/claude.yml), [Copilot](../examples/agents/copilot.yml). All three run unchanged through the same implementation, which contains no harness-specific exceptions; their comments say what each `deps` holds and which settings file they place in HOME.

## One Case or Named Cases

An ordinary document directly declares the complete case:

```yaml
input: Create hello.txt with exactly the content "Hello, world!".
timeoutMs: 120000
runner:
  $type: acp
  agent: ../../agents/pi.yml
  config:
    model: opencode-go/deepseek-v4.1-flash
checks:
  - $type: file
    path: hello.txt
    exists: true
    matches: '/^Hello, world!\n?$/'
```

For several cases, common top-level fields sit beside `cases`; each entry supplies the fields absent from the common part. For example, keep the `runner` above and compare the same task with and without a project skill:

```yaml
cases:
  with-skill:
    files:
      .agents/skills/skill: skill
  without-skill: {}
```

Both `view` and `run` execute or display every entry in declaration order when `--case` is omitted, and only the named one when `--case <name>` is given. `cases` must be a non-empty mapping of non-empty string names to mappings. Unknown selection is an error; an ordinary document rejects a case name. The common part is never executed as an extra unnamed case.

#### Running Every Case

A multi-case document is one invocation, but every case is an ordinary run: it validates, prepares, executes and records exactly as it would alone, with its own run root and its own result directory. Nothing repeats and nothing is aggregated across cases; repetition and statistics are not built in.

- **All selected cases are validated before any runs.** Every case's implementation parameters, factories and authoring assets are checked first, so a configuration error in the last case runs none. It exits 2 without a result record.
- **An error or a failed check does not stop the following cases.** Cancellation does: the running case stops and the remaining cases are not started.
- **Output is one line per executed case:** `<case name>: <status> <result.json path>`. `--case` keeps the single-run report instead.
- **Exit status is 0 only when every case passed**, 1 when checks failed, and 2 when a case ended as `error`, `timeout` or `cancelled`. A cancelled sweep also prints how many cases did not run.

**Composition follows one recursive rule based on YAML structural type (`value`, `list`, `map`):**

- **`value`** (`input`, `runner`, `fixture`, `timeoutMs`, `expect`): scalar or atomic object; a case replaces the common default as a whole (no partial nested merge).
- **`list`** (`checks`): sequence; case items append after common items.
- **`map(<child>)`** (`files` is `map(value)`, `mocks` is `map(map(value))`): mapping; keys merge recursively using `<child>` — when `<child>` is `value`, a repeated key in the case replaces the common value (duplicate keys within the same YAML mapping remain parse errors).

Naming mirrors type: plural fields (`files`, `checks`, `mocks`) are collections that merge, while singular fields (`input`, `runner`, `fixture`, `timeoutMs`, `expect`) are atomic `value`s that replace whole. `agent-evals view` prints the resolved YAML with inline `# <file>:<line>` comments: an untouched collection is annotated once at its top key, a merged collection annotates each entry, and any overridden value notes `(overrides <file>:<line>)`. Siblings are independent, and names have no built-in skill/comparison behavior.

## Common Fields and Parsing

| Field       | Type              | In `cases`                                | Contract                                                                                                                                                |
| ----------- | ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`     | `value`           | replaces common                           | Required non-empty initial user message.                                                                                                                |
| `runner`    | `value`           | replaces common (whole)                   | Required implementation record.                                                                                                                         |
| `fixture`   | `value`           | replaces common                           | Optional directory relative to this YAML, copied into the workspace root. Omission starts an empty workspace.                                           |
| `timeoutMs` | `value`           | replaces common                           | Optional positive integer milliseconds; defaults to 300000. Bounds runner execution and is also each check's budget, not the whole run's wall time.     |
| `expect`    | `value`           | replaces common                           | Optional `pass` (default) or `fail`: whether the checks are expected to fail, as a vacuity or negative baseline. See [negative cases](#negative-cases). |
| `files`     | `map(value)`      | merge by key (case value replaces common) | Optional mapping from a destination to an authoring file or directory, placed after the fixture; a `~/` destination places into the run HOME.           |
| `checks`    | `list`            | append after common                       | Required non-empty list of implementation records.                                                                                                      |
| `mocks`     | `map(map(value))` | merge by group & target (case value wins) | Optional declared collaborator substitutes; see [Mocks](#mocks).                                                                                        |
| `cases`     | document          | n/a                                       | Optional document-level selection control; not passed to execution.                                                                                     |

Unknown common fields, invalid shapes and duplicate YAML keys are errors. There is one document/file: no `extends`, imported collections or nested `cases`. Implementation parameters may contain [placeholders](#placeholders). Null is a value, not omission or deletion.

Anchor declarations, alias nodes and the scalar mapping key `<<` are rejected at every depth, including quoted `<<` keys. Parser warnings, including unknown tags such as `!include`, are errors. Ordinary string values containing `&`, `*`, `<<` or tag-like text remain data; built-in YAML tags that parse without warnings are not categorically banned.

Authoring resources are relative to the YAML file; checker targets are relative to the evaluated workspace. Neither is silently based on the engine's working directory. Credentials are separate runtime inputs from the invocation directory; see [Setup](setup.md#credentials-and-env).

### Negative Cases

`expect: fail` declares that the checks are supposed to fail: a vacuity arm, a deliberate negative test, a baseline that must not satisfy the task. It changes how the outcome is read, not what is recorded.

- The result's `status` is still what the checks decided (`pass` or `fail`) — the record never rewrites evidence.
- One run prints `expected-fail` or `unexpected-pass` on its case line, and the session report uses `EXPECTED FAIL` / `UNEXPECTED PASS`.
- The exit code is 0 when every repetition failed as declared, 1 when any repetition passed (an unexpected pass), and 2 when a run or check could not be judged. A timeout is never absorbed by the declaration.
- The aggregate line names the share: `3 fail (2 expected)`, `1 passed (1 unexpected)`.

A document that mixes positive and negative cases therefore succeeds only when both halves did what they declared. Without the field, a `noop` vacancy arm would make every `run` of the document exit 1 and every record look like a broken test.

### Fixture and Files

`fixture` is the base environment: a workspace directory. `files` is the per-case variation layered on top. Each key is a destination and each value an authoring file or directory read from the case YAML's directory — the same base as `fixture`, not the fixture directory and not the invocation directory.

A destination without `~/` is relative to the prepared workspace root: `.` is the root, never absolute and never containing `..`. A destination starting with `~/` places into the run HOME instead: `~/notes/today.md` is a file, `~/notes` a directory, and `~/` the HOME root itself. The fixture populates the workspace first; workspace entries overlay it, HOME entries overlay the agent file's `files` and login state, and the case's `~/` entries come last. The native `pi` runner has no HOME, so it rejects a case that places or checks anything under `~/` before any run resource exists.

- An entry may replace a file that came from `fixture`, from the agent file, or from the fixture's HOME equivalent.
- Entries may not overwrite each other: two entries producing the same file path are an error, including a `~/` root that the HOME baseline then records. Directory entries merge.
- A file arriving where a directory exists, or a directory where a file exists, is an error rather than a replacement, whether the existing path came from `fixture`, the agent file or another entry.
- A case may never place over a login file; a `~/.auth/token` entry is a configuration error when `login.files` declares it.
- Placement happens before the baseline snapshot, so placed files are part of the baseline and `changed: false` covers them. The HOME baseline holds only what the case placed, not the agent file's or login's content, so `changed` under `~/` compares against the case's own placement.

A source directory declares what is not placed in a `.agentevalsignore` file at its own root, written in gitignore syntax: `/evals` for the expectation assets beside a skill body, `__pycache__` for bytecode. The same file is honoured wherever the engine copies an authoring tree into a run — the fixture, a case's `files`, a checker's `files` and the Pi runner's `skills` directories — and each directory is read as the copy reaches it, so one file in a skill directory works whether an entry names that skill or a tree of skills above it. Patterns are relative to the directory holding the file, the ignore file itself is never placed, and the rules apply to traversal only: a file or directory an entry names directly is placed even when an ignore file in its parent excludes it, and ignore files above the named source are not read. Unlike git, the answers of different files are combined, so a `!` in a deeper file cannot re-include what a higher one excluded; within one file negation behaves as gitignore does. An ignore file that cannot be read as a regular file is a configuration error.

The engine only copies; it assigns no meaning to a destination and knows no harness paths. A project-level skill is one use: place its directory where the harness discovers it, for example `.agents/skills/` for Pi and Copilot CLI or `.claude/skills/` for Claude Code. A user-level skill or instruction file is the same mechanism under `~/`: `~/.claude/skills/…` for Claude Code, or other paths a harness reads from HOME.

Order inside HOME is agent `files` → login files → the case's `~/` entries. The agent file's `files` may not collide with its own login files; a case may replace an agent-placed file, and only a collision with login state is an error. Those login collisions are configuration errors before the harness starts, including a directory source whose contents name a login file; agent `files` sources are also read at that point, so a missing source is a configuration error too. Two case entries normalizing to one path and a file-versus-directory conflict are placement errors before the harness runs.

Login state is protected by what the filesystem holds, not only by the declared spelling: placement refuses any target whose file identity is one of the login files copied into HOME, so a differently-cased or otherwise normalised path the filesystem treats as one file cannot be written through. On a case-sensitive filesystem the spellings are different files, and the persistent login directory stays untouched either way.

## Mocks

A case may replace a `PATH` command with a fixed result for one run:

```yaml
mocks:
  shell:
    make:
      return:
        exitCode: 1
        stderr: "release commands are disabled\n"
```

[Mocks](mocks.md) owns what mocks do, the supported fields and defaults, a complete case, `mocks.json` and the current limitations.

## Placeholders

```yaml
apiKey: ${env:OPENCODE_API_KEY} # a value from the invocation .env
url: https://${env:HOST}/v1 # embedded in text
cache: ${TMPDIR}/cache # a built-in variable
note: write $${env:X} # $${ is a literal ${
```

- `${env:NAME}` reads `NAME` from the invocation `.env` ([Setup](setup.md#credentials-and-env)). `${NAME}` reads a built-in variable: `HOME` and `TMPDIR` are the run's HOME and temporary directory, the same directories the runner gives its process; a preparation helper uses its own. Other sources and names are errors; nothing falls back to the operator's environment.
- Placeholders apply to every string in the selected runner/checker parameters, nested objects and arrays included, and in standalone agent files—not keys, `$type` or Case-level fields. A `$type` selector is a registry key, so it is literal text even when it contains something that looks like a placeholder. YAML quoting does not change them. A [`judge`](#judge-checker-type-judge) that declares its own `runner` is the one exception to "the run's HOME and TMPDIR": that declaration is substituted against the evaluated run (see the judge section).
- The engine chooses the run directories' paths first, substitutes, applies the implementation schema, and only then creates the directories. Substituted text is not scanned again and is not converted to numbers or booleans. Malformed placeholders in the selected case fail at load, also for `view`; a missing `.env` name fails before any run resource exists.
- `view` and result declarations show placeholders unsubstituted; the declared text itself says which parts are placeholders.

These are value-source rules, not secrecy rules. Implementations decide how values are used and exposed; the engine does not redact based on parameter names or source. File and command behavior is documented in [Setup](setup.md#credentials-and-env).

## Implementation Records

`$type` selects a registered implementation. All remaining fields belong to its Zod parameter schema; the engine does not understand model, skill or rubric semantics. There is no `params` wrapper, and plain `type` is not the selector.

On `run`, the engine validates each record once, reports schema errors with field paths, and passes inferred output to its factory. Built-in schemas reject unknown fields and do not broadly coerce YAML scalars: `false` and `0` stay typed, quoted numbers/booleans stay strings, and explicit null does not trigger a missing-field default.

### Pi Runner (`$type: pi`)

| Parameter    | Contract                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `model`      | Required non-empty Pi model selector.                                                                                              |
| `thinking`   | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; default `medium`.                                                    |
| `skills`     | Explicit config-relative skill files/directories; a directory's `.agentevalsignore` applies. Default empty. Discovery is disabled. |
| `apiKey`     | Optional non-empty string; use `${env:NAME}` for private storage. Current transport requires `provider/model` when supplied.       |
| `executable` | Pi executable name/path; default `pi`.                                                                                             |

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

| Parameter | Contract                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`   | Required. An inline [agent object](#agent-files), or a config-relative path to a standalone file holding one. `acpCommand`, `environment`, `deps`, `path`, `files` and `login` are used. |
| `config`  | Optional mapping of session config values (string or boolean), applied in declaration order. A key names an option's category when exactly one has it, otherwise an option ID.           |

A path-referenced file resolves its own directories from its location and its placeholders like the case's own parameters; an inline object is part of them. Missing `deps`, an invalid login directory, an agent `files` destination without `~/`, or an agent `files`/login collision are configuration errors before any run resource exists.

Each run links `deps` at the run root, copies the agent file's `files` and declared login files into the run HOME, then lets the case's `~/` entries overlay them, starts `acpCommand` in the workspace under the sandbox, creates one session, applies `config`, then sends the input as one prompt. `agent-evals config <agent.yml>` lists the offered options. A key matching no option, or a value the agent does not offer, fails the run before prompting; set `model` first because other choices may depend on it. Project skills come from the prepared workspace (`fixture` and `files`); user-level skills and user data come from the case's `~/` entries and from the agent file's `files`, not from runner parameters. The agent declares the ACP runner's own HOME content; a case cannot replace its login state.

The run completes only when the turn ends with `end_turn`; any other stop reason, an agent exit or a protocol error is an execution error. The runner records a [trace](#inspecting-and-recording); output is the agent's text after its last tool call. Permission requests are approved (`allow_once`, else `allow_always`): the sandbox is the boundary. On completion, timeout or cancellation the whole sandbox is stopped, then changed original login files are copied back. `deps` and `mocks` are readable but never writable; `home`, `workspace` and `tmp` are writable; `engine/` — the baseline, policy, placement staging and check state — is unreadable. With [`mocks`](#mocks), the runner puts the forwarder directory first on the process `PATH`.

Example: [`deploy-runbook-posix`](../examples/cases/deploy-runbook-posix/case.yml), whose Pi, Claude and Copilot cases share one fixture and one [`mocks`](mocks.md) declaration and differ in agent, model and whether `files` places `skill` where that harness discovers it (`.agents/skills/` or `.claude/skills/`).

### Noop Runner (`$type: noop`)

A parameterless baseline runner. It starts no harness and no sandbox and completes at once with `finalText: null`, no diagnostics, an empty trace (`trace.json` is `[]`), and no usage. It declares mock support, so a case with `mocks` loads; the forwarders are written and nothing calls them, so `mocks.json` is `[]`. It declares HOME support, so a case's `~/` entries are placed and snapshotted and a `~/` check sees the environment it would have seen with no agent.

Run a case under it to see which checks need the agent: `file` `matches` or `notMatches`, a `mock` or `trace` `skill` check with its default count, or a `shell` command over a broken fixture fail, while restraint checks (`times: 0`, `changed: false` on a file that already exists) pass by construction. A `trace` `message` check is an `error` here, because the agent produced no text. It prepares the case's `~/` entries and their baseline like any other run, so a `~/` restraint is proved vacuous or not. A vacancy case declares `expect: fail`, so the failures its checks report are the expected outcome rather than a failed command; see [negative cases](#negative-cases). Select it per named case; `run` has no baseline flag.

### File Checker (`$type: file`)

| Parameter    | Contract                                                                                                                                                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`       | Required workspace-relative file, directory, or glob path (`*`, `**`, `?`, `[...]`, `{a,b}`), or `~/…` for the run HOME. Not absolute and without `..` segments; `~/` alone names HOME, not a file. Any path containing glob metacharacters (`*`, `?`, `[`, `]`, `{`, `}`) is treated as a glob (not an exact path for `changed`). |
| `exists`     | Optional boolean; `false` is supported. A regular file or a directory exists; a special file is an error. With a glob, `true` requires at least one matching path and `false` requires none.                                                                                                                                       |
| `changed`    | Optional boolean; compare against the initial baseline (exact file or directory paths only, not globs). On a file, `false` passes for identical or both-absent files and `true` only for one the run created, removed or modified. On a directory, every path beneath it is compared, so `false` requires an identical tree.       |
| `matches`    | Optional literal or `/…/` RE2 pattern, or a non-empty list of up to 100. Search semantics, not an implicit whole-file match. With a glob, passes when at least one matched regular file matches.                                                                                                                                   |
| `notMatches` | Optional literal or `/…/` RE2 pattern, or a non-empty list of up to 100. Fails when a pattern is found. With a glob, passes only when none of the matched regular files match.                                                                                                                                                     |

At least one of `exists`, `changed`, `matches` or `notMatches` is required, and every declared pattern produces its own result. A pattern scalar is a non-empty string or a finite number compared as its text; unquoted booleans and mappings are configuration errors, since an unquoted `state: failed` in a list is a mapping rather than a string. A string is a literal substring unless it starts and ends with `/`, which makes it a RE2 pattern searched within the file: `^` and `$` bind to the file's start and end unless the pattern uses `(?m)`. A literal that itself starts and ends with `/` is written as a regex, such as `/\/bin\//`. Every `/…/` pattern compiles at load time on the shared RE2 engine ([Mocks](mocks.md#regexes) owns the dialect), which is linear-time and needs no worker or timeout.

A missing file (or a glob matching zero regular files) fails both `matches` and `notMatches`, so a restraint check never passes because the agent wrote nothing. File reads are capped at 1 MiB. A directory's `changed` walks the tree without following links: each regular file is compared by bytes under the same cap, and a symlink or special file is compared by kind, so a link the agent wrote is a difference rather than unreadable evidence. `exists` answers for a regular file or a directory, the pattern predicates still require one regular file, and `changed` covers both. Nothing caps the number of entries; the check's `timeoutMs` bounds the walk. Unsafe/replaced roots, escaping/broken symlinks, non-regular files, oversized files and unreadable evidence are errors rather than passes. No content normalization or `includes` alias is provided. A `~/` path is rejected at load for a runner that gives the run no HOME, and `changed` compares against the case's own HOME placement, not against the agent file's or the login's content.

### Mock Checker (`$type: mock`)

Asserts on the calls a declared mock recorded; [Mocks](mocks.md#the-mock-checker) owns the evidence model and its limits.

```yaml
- $type: mock
  shell: [git, push, { /-f|--force/: true }]
  times: 0
```

| Parameter | Contract                                                                                                                                                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`   | Required list. Position 0 is a declared `mocks.shell` target written as a literal with the same shape a declaration requires (relative, no `..`, not a directory): `./scripts/x` and `scripts/x` name the same workspace target, while `x` and `./x` stay distinct, exactly as in the declaration. The rest is a mock rule's [`args`](mocks.md#matching) grammar. |
| `times`   | Optional non-negative integer, the exact number of matching calls. `0` asserts none; omitted means at least one.                                                                                                                                                                                                                                                  |

Strict parameters; unknown fields are errors, and position 0 cannot be a `/…/` pattern because a pattern cannot be compared with the declared targets. A case with no `mocks`, or a check naming an undeclared target, is a configuration error at load time, before any run directory exists. The check matches the recorded calls, not the declared rules, so its pattern need not equal any rule's `args`, and it counts a call that reached the mock even when a rule refused it. One result: `pass` or `fail`, with the number and arguments of the matching calls on failure.

### Shell Checker (`$type: shell`)

Runs an author's program after the run and judges its exit status; use it for outcomes only execution shows, such as the project's tests.

```yaml
- $type: shell
  files:
    tests/acceptance.test.js: checks/acceptance.test.js
  run: [node, --test, tests/acceptance.test.js]
```

| Parameter | Contract                                                                                                                                                                                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`     | Required non-empty list of non-empty strings: a program and its arguments, the same form as a mock's `run`. Never a shell interpreter.                                                                                                                                                                                                  |
| `files`   | Optional mapping from a workspace-relative destination (never `~/`) to an authoring file or directory, with the same destination rules as `case.files` but not `.` for the root. Sources resolve from the case file; `../shared/test.js` is allowed, and a source directory's `.agentevalsignore` applies. Placed when this check runs. |

The program starts in the workspace root in the engine's check sandbox: open reads, writes only beneath the workspace and a private HOME and temporary directory, no network, and only `PATH`, `HOME` and `TMPDIR` in its environment (`PATH` is the operator's). It is supervised like the harness, so its whole process tree ends with the check. Exit `0` passes; any other exit fails with the tail of its output as the reason; a program that cannot start, dies from a signal or exceeds the check deadline (`timeoutMs`) is an error, not a failed judgment.

The engine validates `files` when the case loads, and the check sandbox copies it into the live workspace just before the program starts, after the agent stopped, so the agent never saw those bytes during the run. Placed files stay for later checks and disappear with the run root; they are not part of the baseline. When the case loads, the engine checks that every source exists and that two entries do not produce the same file, so a missing source is a configuration error rather than a check result. Placement runs inside the check sandbox, so the sandbox's write policy contains it even against a concurrent race. It also never follows a destination symlink: a symlinked ancestor is a check error, and anything at a file's destination is removed before the copy, so an agent-planted symlink or hard link cannot redirect the write outside the workspace. A directory where a file goes is a check error.

A shell check runs in the live workspace, in declaration order, so a `file` `changed: false` check that must see the agent's result unchanged belongs before it. Mocks are closed when checks run: a mocked `PATH` command is not on the check's `PATH`, and a mocked workspace script reaches only a closed host. The sandbox policy is fixed and has no case syntax; a `judge` runs its declared runner in its own run root instead, so its sandbox is that runner's.

Extensions get the same behavior through the engine interfaces: `ImplementationContext.validateFiles(files)` at load time and `CheckerContext.checkSandbox.run(run, { files })` at check time. An extension checker assembles no file-staging logic or sandbox policy of its own.

### Trace Checker (`$type: trace`)

Asserts on what the run's trace shows, through derived events rather than raw entry fields. Two events: `skill`, the skills the run consulted, and `message`, the text the agent produced. A runner that records no trace, such as the native Pi runner, is a checker error, as for `judge` with `trace: true`; `noop` records an empty trace, so a positive skill check fails there and `times: 0` passes, while a message check is an error because the run produced no text.

```yaml
- $type: trace
  event: skill
  name: deploy-runbook

- $type: trace
  event: message
  matches: rollback started
  notMatches: /E4127/
```

| Parameter    | Contract                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`      | Required. `skill` or `message`. An unknown value is a configuration error listing the accepted events.                                                                                 |
| `name`       | `skill` only. Required skill name: a literal for one exact name, or a `/…/` RE2 pattern searched within it (the same literal-or-pattern grammar as [`file`](#file-checker-type-file)). |
| `times`      | `skill` only. Optional non-negative integer, the exact number of matching consultations. `0` asserts none; omitted means at least one.                                                 |
| `matches`    | `message` only. Text the artifact must hold: a literal substring, or a `/…/` RE2 pattern searched within it, or a non-empty list of either.                                            |
| `notMatches` | `message` only. Text the artifact must not hold, with the same grammar.                                                                                                                |

Strict parameters, per event: an unknown field is a configuration error, and so is a parameter the selected event does not read — `matches` or `notMatches` with `skill`, `name` or `times` with `message`. The error names the field. A `message` check needs `matches`, `notMatches`, or both. Results are `pass` or `fail`; evidence the runner cannot supply is an `error`.

#### Skill Consultations

A literal `name` matches at most one consultation, so `times` other than `0` or `1` requires a `/…/` pattern. One result. Its reason always lists the run's consulted skills, so a pass also shows why it held: `found 1 consultation, consulted: deploy-runbook`, or `expected exactly 0 consultations of markdown-writing, consulted: knowledge-base, markdown-writing`.

When an executed command's text names the path of a `SKILL.md` a baseline placed, the reason adds that skill separately, as in `; touched via shell: knowledge-base`. Shell access is **reported, never counted**: it changes neither the status nor `times`, because whether reading a body through a shell is a consultation is ambiguous and parsing shell commands would err in both directions. A `SKILL.md` the agent created during the run is not reported; only a case's placed files are.

Only completed tool calls (`type: "tool"`, `status: "completed"`) count, in the two forms harnesses report:

- **A dedicated skill tool.** Any non-`read` call with a non-empty `rawInput.skill` contributes that string. Claude Code titles it `Load skill: <name>` and GitHub Copilot CLI `Using skill: <name>`.
- **A `SKILL.md` read.** A `read` call whose target (`locations[0].path`, `rawInput.path` or `rawInput.file_path`) has the basename `SKILL.md`, as Pi reports it. The name is the frontmatter `name` of the same file in the run's initial baseline when the target is in the workspace or in HOME, so offsets, chunks and edits during the run do not change it; otherwise the frontmatter `name` of the text the read returned; otherwise the parent directory's name, which the result's reason says was used. Traces spell a path relative to the workspace, as `~/…`, or as an absolute `/var/…` or `/private/var/…`; all of these resolve to the same file.

A skill is one consultation however often or in however many chunks it was read. The derivation is the exported, asynchronous `skillConsultations(trace, sources)` from the [package entry](../src/index.ts), where `sources` names the run's workspace and HOME and the baselines that recorded what the case placed in each; an extension checker can reuse it. See [Extensions](extensions.md#current-limits).

What `trace` cannot prove about skills: shell reads such as `cat SKILL.md` are not consultations, so a positive check can fail although the skill body was read, and `times: 0` proves only that no recognized tool call loaded it — the `touched via shell` note is informational and never evidence of a consultation; a placed skill's `description` stays visible in the harness's roster, so `times: 0` is about loading the body; any completed non-read call with a string `skill` parameter counts, so an unrelated tool with that parameter would be read as a consultation; and copies of a same-named skill are not distinguished, because skill tools report only a name. Ordering assertions and field matching on raw trace entries are not offered. "No skill consulted at all" needs no new option: `name: /.*/` with `times: 0` matches every consultation and asserts there are none.

#### The Agent's Text

The artifact is every `message` entry of the trace, in run order, concatenated with no separator, so a pattern may span two entries. `thought` and `tool` entries are excluded: reasoning and tool output are never evidence for this event. Nothing is truncated, so the whole recorded text is searched; there is no prefix guarantee to rely on. A literal `matches` is a substring and a `/…/` pattern is searched within the text, exactly as `file`'s predicates read a file. Each declared pattern is one result, `matches` first, in declaration order; its subject says which pattern and kind it decides (`message matches "rollback started"`, `message does not match /E4127/`) and its reason says whether the pattern was found.

A run whose trace holds no message text is one `error` result, never a `pass` or a `fail`: the agent produced nothing to assert on, so a `notMatches` restraint must not pass vacuously. This includes `noop`, whose trace is empty, and a trace of only `thought` entries. The derivation is the exported `messageText(trace)` from the [package entry](../src/index.ts); an extension checker or the judge can reuse it instead of joining the messages again.

What `trace` cannot prove about the text: it is what the agent said in the recorded session, not a separate user-facing output record, so messages before a later tool call are included and any text the harness did not report is absent; and a `notMatches` pass says only that the pattern is nowhere in the recorded text.

### Judge Checker (`$type: judge`)

| Parameter | Contract                                                                     |
| --------- | ---------------------------------------------------------------------------- |
| `runner`  | Optional runner declaration; absent means the case's own.                    |
| `files`   | Optional non-empty list of workspace or `~/` file, directory, or glob paths. |
| `trace`   | Optional literal `true`: give the run's trace as evidence.                   |
| `rubric`  | Required non-empty list of non-empty statements.                             |

At least one of `files` and `trace` is required; with both, both are staged and the model decides which statements need which. `~/` paths require a runner that provides a HOME and may not name `~/` or `~/\.` itself.

```yaml
- $type: judge
  # Absent here: the judge runs this case's runner with its harness, model and
  # credentials. Name a runner to judge with a different one.
  files:
    - diagnosis.md
    - ~/mine/space/Plan/**/*.md
  trace: true
  rubric:
    - The agent consulted the deploy-runbook skill before writing the diagnosis.
```

The judge runs a runner over its own workspace: it stages workspace files under `workspace/<path>`, HOME files under `home/<path>`, and the rendered trace as `trace.md`, then asks that runner to decide the rubric from those files. Directory structure is preserved under each prefix, so workspace files, HOME files and `trace.md` never collide. Each entry in `files` may name a regular file, a directory (staged recursively), or a glob (`*`, `**`, `?`, `[...]`, `{a,b}`); `.` segments and trailing separators are normalized, and a backslash is part of a file name rather than a separator. Runner login files are protected the same way as `--retain`: an explicit path or file identity pointing to protected login state is rejected as a checker error, while directory and glob walks skip protected paths, protected file identities, symlinks and special files. The prompt carries the task, the rubric and the staged evidence paths, never their contents, so the model chooses how much of a large trace or file it opens. The run's workspace and HOME themselves are never handed over, and each file is read once through the same regular-file access every checker uses. Missing files, empty directories and unmatched globs are reported in the prompt rather than failing the check; the trace is rendered in run order without cutting, with each tool call's title, kind, status, input and output. Use it for process questions a fixed rule cannot answer, such as whether the agent's account matches what it actually did. Skill consultations have a deterministic checker ([`trace`](#trace-checker-type-trace)); do not judge them twice. A requested call shows what the agent asked for, not every effect, and harnesses differ in what they report (reasoning may be absent). `trace: true` with a runner that records no trace, such as the native Pi runner, is a checker error. Everything about how the judge reaches a model — harness, model, credentials, tools and sandbox — is the declared runner's decision, and so is whether the evidence is read at all: the judge stages the files, it never parses them itself, so a runner whose harness cannot read its own workspace answers from the prompt alone. A runner that cannot produce a verdict is a checker error that says so, not a failed check: `noop` returns no text at all, and a harness whose model is configured outside the case only helps if that configuration supplies one. Declare a `runner` for the judge where the inherited one cannot judge.

Verdict JSON must have exactly one criterion per rubric item, in rubric order, each with a boolean `pass` and a non-empty `reason`. A `criterion` label is ignored, as are extra fields; a malformed object, an absent verdict, or the wrong number of criteria is a checker error rather than a failed check. A valid negative judgment is `fail`. When a document includes `judge` checks, session and matrix reports include the declared judge harness/model (falling back to the case runner when omitted) on the document header line.

Two limits follow from running a runner. A judge's declared parameters are substituted once, when the case loads, against the evaluated run: `${HOME}` and `${TMPDIR}` there name that run's directories, not the judge's private run root, so an agent file that points a harness at `${TMPDIR}` points it outside the judge's writable directories. And the runner's own arrangement still applies, including anything it keeps outside the run root, such as an ACP login store it may read and copy back.

## Inspecting and Recording

`view` uses the same authoring resolver as `run`, then prints the resolved declaration and each top-level field's source file, 1-based declaration line, and common/selected-case origin. Case labels are JSON-escaped. Placeholders are shown unsubstituted. It does not show implementation defaults or invoke implementation schemas, factories, environment lookups or harnesses; it is not a runtime-readiness check.

A `placement:` section follows the field origins: one line per case-level entry — `fixture <dir>`, `files "<destination>"` and `home "<~/destination>"` — with how many paths that entry would place and how many it excludes. The dry run uses the same traversal and `.agentevalsignore` rules as a run, and names the agent file's HOME content only as the runner's business: it is not listed. `--files` lists every placed destination with its authoring source and every exclusion with the deciding ignore file's directory; an excluded directory is one line without its contents, and the `.agentevalsignore` file itself is not listed. A missing source is a configuration error, so `view` fails where a run would, but it starts nothing.

`run` writes `.agent-evals/<run-id>/result.json` in the invocation directory by default; `--results-dir` changes the root. This is retained report data, not the evaluated workspace. Schema version 1 retains source path/optional case name, declared `resolvedConfig`, runner outcome, individual checks, overall status, diagnostics and cleanup status. The runner record also carries an optional `usage`, as far as the harness reports it: `context` (`used` and `size` from the last ACP `usage_update`), `cost` (that update's cumulative session `amount` and `currency`; omitted leaves it, `null` clears it) and `tokens` (`totalTokens`, `inputTokens`, `outputTokens`, plus optional `thoughtTokens`, `cachedReadTokens` and `cachedWriteTokens` from the prompt response's unstable `usage`). Each part is optional, nothing is estimated, and `_meta` is not recorded. Usage is reported whether or not the run completed, so a timed-out run keeps the last context and cost it saw; tokens arrive with the turn's completion. Native Pi and `noop` report no usage. Substituted and schema-normalized/defaulted values do not replace the declaration; implementation outputs are retained normally. A runner that records a trace (currently `acp`) also writes `trace.json` beside it, including for failed, timed-out or cancelled runs: an ordered list of `message` and `thought` entries (consecutive chunks joined) and `tool` entries. ACP updates replace the fields they carry, so each tool entry is one `toolCallId` in its final state with the harness's own fields (`title`, `kind`, `status`, `rawInput`, `content`, ...); intermediate states are not kept. Non-text content and other session updates are not recorded. A case that declares [`mocks`](#mocks) also writes `mocks.json`: the calls that reached a mocked command in arrival order, each as a `target` and its `arguments`. It is run evidence, not a copy of the `mocks` declaration, and holds no output or exit code and no judgment. The [judge](#judge-checker-type-judge) can take the trace as evidence, and the [trace checker](#trace-checker-type-trace) asserts derived skill consultations and the text the agent produced; raw trace entries have no field-level assertions, because field meanings differ between harnesses. Literal keys authored in YAML are declaration data and are not automatically masked. No resource hashes are retained, and by default (`--retain none`) no workspace snapshot is retained, so old resource contents cannot be reconstructed from their unchanged paths.

`--retain <mode>` controls whether post-run files are copied into `<results-dir>/<run-id>/artifacts/` before the temporary run root is removed: `none` (default), `on-failure` (retains `fail`, `error`, `timeout`, and `unexpected-pass` runs, skipping `pass`, `expected-fail`, and `cancelled`), or `all`. Retention copies `workspace/` and `home/` while excluding the runner's `login` files (by path in HOME and by file identity across both trees) and skipping symlinks and special files; all other run-root state (`tmp`, `mocks`, `engine`, `config`, `deps`) is still deleted.

`--reps <n>` repeats each selected case `n` times in declaration order; the default is 1. `--jobs <n>` bounds how many runs execute concurrently (default 1, serial); runs sharing a persistent `login.dir` serialize automatically, and per-run output lines still print in declaration order. Each repetition is its own run root, HOME, workspace and result record, and the exit code still reflects every repetition: it is 0 only when every repetition met its case's `expect` declaration, so a negative case that failed as declared is a success and an unexpected pass is not. Repeated output is one line per run, prefixed with `rep 2/3`, followed by the session report described below. Durations and rates are comparable only within the same repetition count and concurrency.

Every invocation ends with a session report after its per-run lines, one run or many; nothing is written beside the records.

```
evals/routing.yml
runner acp · harness pi · model vendor/model-1 · reps 3 · cases 12

PASS    q02-dollars-stuck-to-characters        3 runs   1m27s   101.3k tok    $0.0053
FLAKY   q09-convert-markdown-to-html           3 runs   1m21s    66.6k tok    $0.0057
        ✗ skill markdown-writing  2/3 fail — expected exactly 0 consultations, consulted: markdown-writing
FAIL    q10-vault-page-with-formula            3 runs   1m22s    88.2k tok    $0.0055
        ✗ skill markdown-writing  3/3 fail — expected exactly 0 consultations, consulted: knowledge-base, markdown-writing

36 runs · 30 passed · 6 fail · 14m4s · 882.0k tok · $0.0573
```

A case is a test and its checks are its assertions: the case line carries the verdict, the run count, the summed runner time, tokens and cost, and only the checks that did not pass in every run are listed beneath it with what a failing run reported. `PASS` and `FAIL` mean every run agreed; `FLAKY` means the repetitions disagreed; `ERROR` means at least one run or check could not be judged. A `noop` run can pass or fail a check that reads the workspace, but it reports `error` for a check that needs evidence the run cannot produce — a `trace` message assertion, for instance — so a `noop` baseline is an error only for those checks.

`—` stands for a value the runner does not report, such as usage from `noop` or the native Pi runner, and a figure followed by `(2/3)` is a subtotal over the runs that reported it, not a total. A recorded result is identified by the declared check that produced it and the subject it names, so two declarations with the same subject keep separate lines and a declaration-level error does not borrow an assertion's identity. A run that recorded no result for an identity is counted as `not judged` rather than dropped from the denominator. The header lists every distinct runner, harness and model the runs used, so a document that mixes harnesses does not attribute them all to the first run. The verdicts and totals count runs, not cases.

Records written before `expect` existed read as `expect: pass`, and records written before results named their declaration cannot feed `--matrix`; do not mix instrument versions in one results root.

`report` prints the same session from retained records without running anything: `report <results-dir>...` walks each path — a results root, one run directory or a `result.json` is accepted — and groups records by the case document they came from. Records from several documents print as one session each plus a `total` line, so a sweep split across invocations still adds up; the command knows only what the records say, not which case files produced them.

`report --matrix` prints the same records as one table per document instead of the session report: a row per recorded check identity — the declared check and the subject the checker named — a column per case, and a cell of `passes/judged` over that case's repetitions. A declaration that returned one generic error is its own row, never the first assertion's; an assertion missing from a repetition is named as not judged.

```
| # | Check | with-skill | without-skill | baseline (expect fail) |
| --- | --- | --- | --- | --- |
| 1 | file ~/mine/space unchanged since run start | 3/3 | 0/3 | 3/3 |
| 2 | judge Asks which project owns the session | 3/3 | 0/3 | 0/3 |
```

The table exists only when every case declares the same check list, because a row has to mean the same thing in every column; otherwise the command is a configuration error naming the first differing position. It also needs records that name the declared check behind each result, which current records do; a record written before that field is refused with a message pointing at the session report. Without any recorded result at all, the table says so instead of printing a header alone. A cell names errors (`2/2 (1 err)`) and runs that recorded no check (`2/2 (1 not judged)`) rather than folding them into the count, and a `|` inside a subject is escaped so it cannot open a column. `(expect fail)` marks a negative column from its records. The default report is unchanged; `--matrix` is the record-building view, and the session report is the run log.

Overall statuses are `pass`, `fail`, `error`, `timeout`, and `cancelled`; individual checks are `pass`, `fail`, or `error`. Pass/fail summarizes satisfaction of the configured checks, not model/skill quality or an improvement claim. A normal negative judgment is `fail`; inability to execute or evaluate is `error`, with timeout/cancellation reported separately. Exit codes are 0 for pass, 1 for failed checks, and 2 for configuration/execution/checker/timeout/cancellation errors; a case that declares `expect: fail` swaps the meaning of 0 and 1 without touching 2. Early configuration errors need not produce a run record.

## Trusted Extensions

`run` registers the built-ins and loads each implementation directory beneath the roots given with `--extension-dir`. An implementation directory's `index.ts`, `index.js` or `index.mjs` exports `runner`, `checker`, or both, and the `$type` is that definition's own `type`. Extensions execute as trusted host code; never name an agent-writable workspace or a results directory. [Extensions](extensions.md) holds the discovery rules, the runner and checker contracts and a minimal example.
