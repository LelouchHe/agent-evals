# Agent Evals

A toolkit for evaluating AI agent systems on the real CLI and harness layer.

Requirements: macOS with `sandbox-exec` and Node.js 24+. The CLI is published as `@lelouchhe/agent-evals`; a run additionally needs an invocation `.env` and prepared harness directories, per [Setup](https://github.com/LelouchHe/agent-evals/blob/main/docs/setup.md). Version 0.1.0 is the first public state — the toolkit, not a finished instrument; [Roadmap](https://github.com/LelouchHe/agent-evals/blob/main/docs/roadmap.md) lists what is still open.

## Why Agent Evals

- **Evaluate the whole agent system, not a bare model API.** Outcomes depend on the model _plus_ its harness, skills, instructions and tool loop. One generic [ACP runner](https://github.com/LelouchHe/agent-evals/blob/main/docs/configuration.md#acp-runner-type-acp) drives unmodified [Pi](https://github.com/LelouchHe/agent-evals/blob/main/examples/agents/pi.yml), [Claude Code](https://github.com/LelouchHe/agent-evals/blob/main/examples/agents/claude.yml) and [GitHub Copilot CLI](https://github.com/LelouchHe/agent-evals/blob/main/examples/agents/copilot.yml) side by side, so changing a skill, instruction, flag or harness is a controlled experiment.
- **Host-native OS sandboxing, not Linux containers.** Each run executes on the host under macOS Seatbelt in its own run root with a private `HOME` and workspace ([layout](https://github.com/LelouchHe/agent-evals/blob/main/docs/setup.md#how-isolated-harness-homes-work)). Host toolchains and platform behavior stay real, while operator dotfiles, login keychains, rubrics and check-time acceptance tests stay unreachable to the agent.
- **Three evidence sources, deterministic first.** Checks read workspace side effects (`file`, sandboxed `shell`), host-recorded calls to [mocked commands](https://github.com/LelouchHe/agent-evals/blob/main/docs/mocks.md) (`mock`) and the run's trace (`trace`), with an LLM `judge` only where qualitative judgment is needed. A `noop` baseline runner catches checks that pass without an agent.

## What a Case Looks Like

A case is one YAML file: a task, a prepared environment, and the checks that judge what the run left behind. Abridged from the [worked example](https://github.com/LelouchHe/agent-evals/blob/main/examples/cases/deploy-runbook/case.yml):

```yaml
input: Our deploy failed. Read deploy.log, confirm the release state with `deployctl status`, then write the cause and the commands to fix it into diagnosis.md.
fixture: fixture # copied into the workspace
mocks:
  shell:
    deployctl: # answered and recorded on the host, never run
      return:
        stdout: "state: failed at publish\n"
    make: # the fix must not be run: refused and recorded
      pass: false
checks:
  - $type: file
    path: diagnosis.md
    matches: "make rotate-signing-cert"
  - $type: mock
    shell: [make]
    times: 0
  - $type: trace # did the agent consult the skill?
    event: skill
    name: deploy-runbook
cases:
  pi-with-skill:
    runner:
      $type: acp
      agent: ../../agents/pi.yml
    files:
      .agents/skills/deploy-runbook: skill # the variable under test
  pi-without-skill:
    runner:
      $type: acp
      agent: ../../agents/pi.yml
  baseline:
    runner:
      $type: noop
    expect: fail # a vacuity arm: its failures are the expected outcome
```

Checker and runner [extensions](https://github.com/LelouchHe/agent-evals-extensions) live in their own repository and load with `--extension-dir` ([contract](https://github.com/LelouchHe/agent-evals/blob/main/docs/extensions.md)).

The package entry is also importable: it exports the runner and checker contracts, the evidence access a checker uses, and the trace derivations. It is ESM-only, and TypeScript consumers need `@types/node`.

```ts
import { messageText, readRunFile, type CheckerContext } from "@lelouchhe/agent-evals";
```

## Quick Start

```sh
npm install -g @lelouchhe/agent-evals   # or: npx @lelouchhe/agent-evals
agent-evals --help
```

Running a case is macOS-only and needs an invocation `.env` plus a prepared harness directory ([Setup](https://github.com/LelouchHe/agent-evals/blob/main/docs/setup.md)). The worked example below runs from a checkout, because its fixtures and agent files live in the repository.

Follow [Setup](https://github.com/LelouchHe/agent-evals/blob/main/docs/setup.md) once to configure `.env` and prepare the harness directories you want to run, then inspect and run the worked example ([`examples/cases/deploy-runbook`](https://github.com/LelouchHe/agent-evals/blob/main/examples/cases/deploy-runbook/case.yml) — seven named cases across Pi, Claude Code, Copilot CLI and `noop`, exercising project skills, every `mocks.shell` action, hidden check-time `shell` acceptance scripts and all five checkers):

```sh
npm ci
cp .env.example .env                        # fill in harness paths and keys (see docs/setup.md)
npm run eval -- view examples/cases/deploy-runbook/case.yml --case pi-with-skill
npm run eval -- config examples/agents/pi.yml
npm run eval -- run examples/cases/deploy-runbook/case.yml --case pi-with-skill
npm run eval -- report --matrix /tmp/deploy-runbook # after a sweep: one row per check
```

[`deploy-runbook-native`](https://github.com/LelouchHe/agent-evals/blob/main/examples/cases/deploy-runbook-native/case.yml) runs the same task through the native Pi runner using an installed `pi` CLI and provider key alone.

## Documentation

| Document                                                                                            | Question it answers                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Setup](https://github.com/LelouchHe/agent-evals/blob/main/docs/setup.md)                           | How do I install the CLI, configure `.env`, and prepare Pi, Claude Code and Copilot? |
| [Writing Cases](https://github.com/LelouchHe/agent-evals/blob/main/docs/cases.md)                   | How should tasks, fixtures, baselines and assertions be designed?                    |
| [Configuration Reference](https://github.com/LelouchHe/agent-evals/blob/main/docs/configuration.md) | How do YAML files, placeholders, runners, checkers and result records work?          |
| [Mocks](https://github.com/LelouchHe/agent-evals/blob/main/docs/mocks.md)                           | How do I substitute or spy on shell commands, and what does `mocks.json` contain?    |
| [Extensions](https://github.com/LelouchHe/agent-evals/blob/main/docs/extensions.md)                 | How do I write and load a custom runner or checker?                                  |
| [Architecture](https://github.com/LelouchHe/agent-evals/blob/main/docs/architecture.md)             | How do the modules cooperate, and what runtime/development limits apply today?       |
| [Roadmap](https://github.com/LelouchHe/agent-evals/blob/main/docs/roadmap.md)                       | What is planned next (M6 sandbox config, M7 MCP mocks), and where are past archives? |

Delivered milestone records (`M1`–`M5`) are preserved under [`docs/archive/`](https://github.com/LelouchHe/agent-evals/blob/main/docs/archive/).

## Development

```sh
npm run check          # ESLint, Prettier, TypeScript, build, and deterministic model-free tests
npm run test:package   # Pack tarball, install into an external prefix, and verify the installed CLI
```

Serialize checkout build/test/eval commands because `npm run build` replaces `dist/` non-atomically; see [Architecture](https://github.com/LelouchHe/agent-evals/blob/main/docs/architecture.md#known-limitations) for runtime and development constraints.

## Releasing

[CI](https://github.com/LelouchHe/agent-evals/blob/main/.github/workflows/ci.yml) runs the gate on macOS for every pull request and push to `main`. A release is a tag: push `vX.Y.Z` matching `package.json`'s version, and [publish](https://github.com/LelouchHe/agent-evals/blob/main/.github/workflows/publish.yml) re-runs that gate, publishes `@lelouchhe/agent-evals` to npm with provenance, and creates the GitHub release. The workflow needs the `NPM_TOKEN` repository secret: an npm token with publish rights for the `@lelouchhe` scope. A scoped package defaults to restricted, so the publish command passes `--access public`.

## License

[MIT](https://github.com/LelouchHe/agent-evals/blob/main/LICENSE)
