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

[M1](docs/m1-plan.md) is implemented: one local filesystem evaluation with a Pi RPC runner, direct macOS Seatbelt enforcement, and `file` and `judge` checkers. The checked-in example uses placeholder model names and does not call a model until an operator selects one. A real-model smoke test and independent review are still pending; routine tests never call a model.

Requirements: macOS with `sandbox-exec`, Node.js 24 or newer, and the `pi` CLI on `PATH` for runner and judge invocations.

The repository stays private during initial development. Reconsider publication once the initial skill-evaluation tooling is usable; visibility changes require explicit approval.

## Quick Start

```sh
npm install
npm run typecheck
npm test
```

Run one case and candidate:

```sh
node src/cli.ts --case examples/write-file/case.yml --candidate examples/write-file/candidate.yml
```

The example prompts the agent to create `hello.txt`, checks its existence and content, and asks an independent judge whether the task was completed. Before a real run, replace both `select-provider/...` model placeholders and make the selected provider credentials available to the isolated child process:

```yaml
runner:
  $type: pi
  model: <provider>/<model>
  thinking: medium
  envPassthrough:
    - <PROVIDER_API_KEY_ENVIRONMENT_VARIABLE>
```

`envPassthrough` forwards only the named variables; it does not inherit the operator environment. Results are written to `.eval-results/<run-id>/result.json` by default (`--results-dir` overrides this). Exit codes are `0` for a passing run, `1` for failing checks, and `2` for configuration, execution, timeout, cancellation, or checker errors.

## Limitations

- macOS only. There is no Linux or container backend.
- One initial user message and one case/candidate pair per invocation.
- Checks run after the agent stops and before the workspace is removed; full workspace snapshots are not retained.
- The judge reads one selected file; there is no general evidence-reference language.
- Checks read regular files only. A FIFO, device, socket, or directory is a check error rather than a blocking open or a passing observation.
- The runner records each workspace directory's device and inode and rejects a path replaced during the run instead of following the replacement.
- Pi runs under a sandbox-resident supervisor. Its shell wrapper terminates ordinary background jobs before the command returns, and the supervisor terminates tracked shell groups on stop from inside the same Seatbelt sandbox. The shell-group registry is agent-writable and untrusted; the host never signals groups from it. A process that deliberately leaves the shell's process group or session is outside this cleanup contract.
- Catastrophic regular expressions are evaluated in a worker that is terminated on the check deadline or an internal 5-second ceiling.
- The Seatbelt profile permits outbound network access for model calls. Real model traffic under the sandbox has not yet been smoke-tested.

## Layout

```text
src/
  cli.ts
  engine/          configuration, trusted discovery, orchestration, results
  runners/pi/      Pi RPC and session/process lifecycle
  checkers/file/
  checkers/judge/
  platform/macos/  Seatbelt policy and launch
tests/             cross-module integration tests and shared test assets
examples/write-file/
  case.yml
  candidate.yml
  skill/SKILL.md
docs/
```

Module unit tests are co-located with their modules; `tests/` holds cross-module integration tests and test-owned helpers.

## Documentation

- [Architecture](docs/architecture.md): overall direction, responsibilities, execution boundaries, and evidence collection.
- [Cases and configuration](docs/cases.md): YAML authoring, assets, implementation selection, checks, and dataset organization.
- [M1 plan](docs/m1-plan.md): the first milestone's goal, implementation steps, acceptance, and trade-offs.

Milestone plans own their delivery details. Larger milestones may split into plans such as `m1a-plan.md` and `m1b-plan.md`, with the parent retaining the overall goal and acceptance criteria.

## License

[MIT](LICENSE)
