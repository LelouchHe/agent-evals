# Agent Evals

A toolkit for evaluating AI agent systems.

## Vision

The long-term goal is a general-purpose tool for evaluating AI agent systems—their instructions, skills, workflows, configurations, and harnesses.

Make agent changes measurable through repeatable tasks, controlled environments, and evidence-based comparisons of behavior, outcomes, cost, and latency.

## How It Works

A case supplies an input message, an initial environment, and checks. A configured runner drives the agent; checkers assess its messages, environment changes, or other available observations. Runner and checker implementations are selected through configuration rather than evaluation-specific engine branches.

```text
Create an isolated run directory
    -> Copy the fixture and prepare isolated HOME, Pi configuration, and scratch state
    -> Run Pi through native RPC under macOS Seatbelt
    -> Stop Pi and its owned child processes
    -> Run file and judge checks while the workspace exists
    -> Save a small result record and remove the runtime directory
```

## Current Status

[M1](docs/m1-plan.md) is implemented: one local filesystem evaluation with a Pi RPC runner, direct macOS Seatbelt enforcement, and `file` and `judge` checkers. The [single-file authoring revision](docs/configuration.md) is also implemented: one YAML file resolves either an ordinary case or common fields plus one selected named case, using disjoint top-level composition and source-annotated `view`. A run retains its resolved non-sensitive configuration together with the source path and optional case name.

The checked-in example selects OpenCode Go's DeepSeek Flash for both runner and judge and requires an explicit `OPENCODE_API_KEY` environment variable. The bounded independent review, focused repair verification, and approved real-model smoke for the original runtime are complete. That historical smoke used the earlier two-file format; the migrated single-file loader, its example, and the packaged CLI have model-free test coverage only and have not been live-model tested. Routine tests never call a model.

Requirements: macOS with `sandbox-exec`, Node.js 24 or newer, and the `pi` CLI on `PATH` for runner and judge invocations. `view` does not need `pi`, a model, or provider credentials.

The package is private and not published. It provides an installable `agent-evals` Node.js 24+ command; both that command and `npm run eval` execute the same built `dist/cli.js`.

The repository stays private during initial development. Reconsider publication once the initial skill-evaluation tooling is usable; visibility changes require explicit approval.

## Quick Start

```sh
npm ci
npm run check
```

Run one selected case through the development command:

```sh
npm run eval -- run examples/write-file/case.yml --case with-skill
```

Inspect the resolved case and each top-level field's origin without starting a harness:

```sh
npm run eval -- view examples/write-file/case.yml --case with-skill
```

`npm run eval` rebuilds `dist/` first and then runs the same entry point as the installed `agent-evals` command.

Before running the command, make `OPENCODE_API_KEY` available in the invoking process using your normal secret-management method; never put its value in example files. The example uses `opencode-go/deepseek-v4.1-flash` for both runner and judge, with thinking omitted to use their default (`medium`) and a 120-second execution budget per invocation. It prompts the agent to create `hello.txt`, checks its existence and content, and asks an independent judge whether the task was completed. The example defines `with-skill` and `without-skill` cases that differ only in their explicit runner records; its names have no built-in A/B meaning and no comparison is performed.

`envPassthrough` forwards only the named variables; it does not inherit the operator environment. Results are written to `.eval-results/<run-id>/result.json` by default (`--results-dir` overrides this). Each result retains the resolved non-sensitive configuration actually used, plus the source path and optional case name, so later edits to the YAML do not erase an old run's declared parameters. Case names are metadata only and never determine result paths. Exit codes are `0` for a passing run, `1` for failing checks, and `2` for configuration, execution, timeout, cancellation, or checker errors.

## Installable CLI

The package is private and is not published. To use the CLI without `npm run`, build and install a local tarball into a disposable prefix:

```sh
npm run build
npm pack --pack-destination /tmp
npm install --prefix /tmp/agent-evals-install /tmp/agent-evals-0.0.0.tgz
/tmp/agent-evals-install/node_modules/.bin/agent-evals --help
```

The tarball contains the built runtime under `dist/`, plus README, LICENSE, and package metadata. It does not contain source, tests, docs, generated results, or dev tooling. The installed command and `npm run eval` execute the same built `dist/cli.js`. This is a Node.js CLI, not a self-contained executable or OS installer; it requires Node.js 24+ and, for execution, macOS Seatbelt. Installing the tarball does not require TypeScript, Husky, Git metadata, or the repository checkout.

## Development

`npm ci` installs the locked development dependencies and configures Husky for this repository through `prepare`. It changes only the repository-local `core.hooksPath`, not global Git configuration.

| Command                | Purpose                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run build`        | Compile the sole TypeScript CLI into ignored `dist/` and copy runtime assets.                      |
| `npm run lint`         | ESLint recommended JavaScript and TypeScript checks.                                               |
| `npm run lint:fix`     | Apply available lint fixes explicitly.                                                             |
| `npm run format:check` | Check Prettier formatting without changing files.                                                  |
| `npm run format`       | Apply Prettier formatting explicitly.                                                              |
| `npm run typecheck`    | Check TypeScript types.                                                                            |
| `npm test`             | Build, then run deterministic tests, including real local Git-hook probes. No models are called.   |
| `npm run check`        | Run lint, formatting, type checking, and the full build-backed test suite in order.                |
| `npm run eval`         | Rebuild and run the same `dist/cli.js` entry point exposed as the installed `agent-evals` command. |

Prettier uses 120-column wrapping and its default two-space, double-quote, semicolon style. Generated results, generated `dist/` output, tarballs, Husky internals, and local agent adapters are excluded from formatting and version control. The executable malformed-protocol fixture keeps a narrowly scoped ESLint exception for its existing `@ts-nocheck`; other TypeScript files retain the recommended rule.

- **pre-commit:** checks lint and formatting for the whole project; it never rewrites or stages files automatically.
- **pre-push:** runs the complete gate. New trees may be pushed only from the checked-out `HEAD` with a clean worktree, so the checked files match the outgoing commit. Ref deletions do not upload a new tree and skip the gate.

The pinned development toolchain contains `minimatch@10.2.6`, affected by [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). The advisory requires an attacker-controlled glob pattern and `optimizationLevel >= 2`. The reviewed ESLint/config-array/TypeScript-ESTree call sites use the default level 1; independent instrumentation of the real lint run found no level-2 calls. The runtime-only audit (`npm audit --omit=dev`) reported no advisories.

This advisory is temporarily accepted for the reviewed, pinned toolchain; the dependency is not considered fixed. Reassess when compatible upstream tool releases adopt patched `minimatch` (11.0.1 or later), when matching options/defaults change, or when a new path combines untrusted patterns with level-2 optimization. Do not force a dependency downgrade or blanket major-version override just to clear the audit.

## Limitations

- macOS only. There is no Linux or container backend.
- One initial user message and one resolved case per invocation.
- The installable CLI is a Node.js package, not a bundled standalone executable; Node.js 24+, the `yaml` dependency, and the package layout are required.
- Checks run after the agent stops and before the workspace is removed; full workspace snapshots are not retained.
- The judge reads one selected file; there is no general evidence-reference language.
- Checks read regular files only. A FIFO, device, socket, or directory is a check error rather than a blocking open or a passing observation.
- The runner records each workspace directory's device and inode and rejects a path replaced during the run instead of following the replacement.
- Pi runs under a sandbox-resident supervisor. Its shell wrapper terminates ordinary background jobs before the command returns, and the supervisor terminates tracked shell groups on stop from inside the same Seatbelt sandbox. The shell-group registry is agent-writable and untrusted; the host never signals groups from it. A process that deliberately leaves the shell's process group or session is outside this cleanup contract.
- Catastrophic regular expressions are evaluated in a worker that is terminated on the check deadline or an internal 5-second ceiling.
- The Seatbelt profile permits outbound network access for model calls. The smoke exercised OpenCode Go's model endpoint; other providers and endpoints remain unverified.

## Layout

```text
src/
  cli.ts
  engine/          configuration, authoring, trusted discovery, orchestration, results
  runners/pi/      Pi RPC and session/process lifecycle
  checkers/file/
  checkers/judge/
  platform/macos/  Seatbelt policy and launch
scripts/           build helper
tests/             cross-module integration and packaged-artifact tests, shared assets
examples/write-file/
  case.yml
  skill/SKILL.md
docs/
dist/              generated build output (ignored, not committed)
```

Module unit tests are co-located with their modules; `tests/` holds cross-module integration tests and test-owned helpers.

## Documentation

- [Architecture](docs/architecture.md): overall direction, responsibilities, execution boundaries, and evidence collection.
- [Cases and configuration](docs/cases.md): authoring principles, assets, implementation selection, and currently supported M1 records.
- [Case configuration](docs/configuration.md): implemented single-file authoring, disjoint top-level composition, source-annotated `view`, and retained run configuration.
- [M1 plan](docs/m1-plan.md): the first milestone's goal, implementation steps, acceptance, and trade-offs.

Milestone plans own their delivery details. Larger milestones may split into plans such as `m1a-plan.md` and `m1b-plan.md`, with the parent retaining the overall goal and acceptance criteria.

## License

[MIT](LICENSE)
