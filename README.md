# Agent Evals

[![CI](https://github.com/LelouchHe/agent-evals/actions/workflows/ci.yml/badge.svg)](https://github.com/LelouchHe/agent-evals/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@lelouchhe/agent-evals)](https://www.npmjs.com/package/@lelouchhe/agent-evals)

A toolkit for evaluating AI agent systems on the real CLI and harness layer.

Supports **Node.js 24+** on **macOS**, **Linux / WSL2**, and **native Windows** ([Platforms](https://github.com/LelouchHe/agent-evals/blob/main/docs/platforms.md) · [Setup](https://github.com/LelouchHe/agent-evals/blob/main/docs/setup.md) · [Roadmap](https://github.com/LelouchHe/agent-evals/blob/main/docs/roadmap.md)). _Pre-1.0: minor releases may include breaking changes._

## Why Agent Evals

- **Whole-system evaluation for any ACP-compatible agent.** Outcomes depend on the model _plus_ its harness, skills, instructions, and tool loop. One generic [ACP runner](https://github.com/LelouchHe/agent-evals/blob/main/docs/configuration.md#acp-runner-type-acp) drives any ACP-compatible CLI agent via an agent YAML — [Pi](https://github.com/LelouchHe/agent-evals/blob/main/examples/agents/pi.yml), [Claude Code](https://github.com/LelouchHe/agent-evals/blob/main/examples/agents/claude.yml), and [GitHub Copilot CLI](https://github.com/LelouchHe/agent-evals/blob/main/examples/agents/copilot.yml) ship as tested examples, and any other ACP agent works once configured.
- **Host-native OS sandboxing, not containers.** Runs directly on macOS (Seatbelt), Linux/WSL2 (`bubblewrap`), and native Windows (`win-sandbox.exe`) in an isolated run root with a private `HOME` and workspace ([layout](https://github.com/LelouchHe/agent-evals/blob/main/docs/setup.md#how-isolated-harness-homes-work)). Real host toolchains stay intact while operator dotfiles, keychains, and hidden acceptance tests stay unreachable.
- **Built-in shell mocks and five checkers.** Intercept, stub, or refuse CLI commands from the host via [`mocks.shell`](https://github.com/LelouchHe/agent-evals/blob/main/docs/mocks.md), and assert over workspace `file`s, sandboxed `shell` scripts, recorded `mock` calls, structured `trace`s, and LLM `judge`s — plus a `noop` runner for vacuity baselines.
- **Extensible by design.** Plug in custom runners and checkers with `--extension-dir` ([extensions repo](https://github.com/LelouchHe/agent-evals-extensions) · [contract](https://github.com/LelouchHe/agent-evals/blob/main/docs/extensions.md)), or import contracts and evidence helpers directly from `@lelouchhe/agent-evals`.

## What a Case Looks Like

A case is one YAML file: a task, a prepared environment, and the checks that judge what the run left behind. Abridged from [`deploy-runbook-posix`](https://github.com/LelouchHe/agent-evals/blob/main/examples/cases/deploy-runbook-posix/case.yml):

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

## Quick Start

### Install

```sh
npm install -g @lelouchhe/agent-evals   # or: npx @lelouchhe/agent-evals
agent-evals setup sandbox               # verify host sandbox (on Windows, run once as Administrator)
agent-evals --help
```

> **Note on the bundled Windows binary:** Published npm packages include a small prebuilt Windows helper (`dist/platform/windows/win-sandbox.exe`, ~400 KB), compiled from [`native/win-sandbox/`](https://github.com/LelouchHe/agent-evals/tree/main/native/win-sandbox) in CI with npm provenance so native Windows installs work without Rust. It is **only used on native Windows** (`win32`) and is never executed on macOS or Linux.

### Try the Worked Examples

The worked examples live under `examples/` in this repository. After configuring `.env` and preparing at least one harness ([Setup](https://github.com/LelouchHe/agent-evals/blob/main/docs/setup.md)), run them with `agent-evals` (or `npx @lelouchhe/agent-evals` without a global install):

```sh
cp .env.example .env                        # fill in harness paths and keys (see docs/setup.md)
agent-evals view examples/cases/deploy-runbook-posix/case.yml --case pi-with-skill
agent-evals config examples/agents/pi.yml
agent-evals run examples/cases/deploy-runbook-posix/case.yml --case pi-with-skill
agent-evals run examples/cases/deploy-runbook-posix/case.yml --reps 3 --jobs 3 --retain on-failure --results-dir /tmp/deploy-runbook
agent-evals report --matrix /tmp/deploy-runbook
```

Three worked examples cover the main workflows:

- [`deploy-runbook-posix`](https://github.com/LelouchHe/agent-evals/blob/main/examples/cases/deploy-runbook-posix/case.yml) — Pi, Claude Code, Copilot CLI, and `noop` on macOS/Linux/WSL2, exercising skills, `~/` HOME placement, `mocks.shell`, hidden check-time scripts, and all five checkers.
- [`deploy-runbook-windows`](https://github.com/LelouchHe/agent-evals/blob/main/examples/cases/deploy-runbook-windows/case.yml) — the same ACP evaluation natively on Windows with PowerShell checks, `.cmd` mocks, and `~/` HOME placement.
- [`deploy-runbook-native-pi`](https://github.com/LelouchHe/agent-evals/blob/main/examples/cases/deploy-runbook-native-pi/case.yml) — the native Pi runner using an installed `pi` CLI and provider key alone, with `judge` inheriting the case's runner.

### Extensions & Programmatic API

Custom runners and checkers load via `--extension-dir` ([contract](https://github.com/LelouchHe/agent-evals/blob/main/docs/extensions.md)). The ESM package entry also exports the contracts, evidence helpers, and trace derivations (TypeScript consumers need `@types/node`):

```ts
import { messageText, readRunFile, type CheckerContext } from "@lelouchhe/agent-evals";
```

## Documentation

| Document                                                                                            | Question it answers                                                                            |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Setup](https://github.com/LelouchHe/agent-evals/blob/main/docs/setup.md)                           | How do I install the CLI, configure `.env`, and prepare Pi, Claude Code and Copilot?           |
| [Writing Cases](https://github.com/LelouchHe/agent-evals/blob/main/docs/cases.md)                   | How should tasks, fixtures, baselines and assertions be designed?                              |
| [Configuration Reference](https://github.com/LelouchHe/agent-evals/blob/main/docs/configuration.md) | How do YAML files, placeholders, runners, checkers and result records work?                    |
| [Mocks](https://github.com/LelouchHe/agent-evals/blob/main/docs/mocks.md)                           | How do I substitute or spy on shell commands, and what does `mocks.json` contain?              |
| [Extensions](https://github.com/LelouchHe/agent-evals/blob/main/docs/extensions.md)                 | How do I write and load a custom runner or checker?                                            |
| [Platforms](https://github.com/LelouchHe/agent-evals/blob/main/docs/platforms.md)                   | Which host OSes are supported (macOS, Linux, WSL2, native Windows) and how each sandbox works? |
| [Architecture](https://github.com/LelouchHe/agent-evals/blob/main/docs/architecture.md)             | How do the modules cooperate, and what runtime/development limits apply today?                 |
| [Roadmap](https://github.com/LelouchHe/agent-evals/blob/main/docs/roadmap.md)                       | What is planned next (M6 sandbox config, M7 MCP mocks), and where are past archives?           |

Delivered milestone records (`M1`–`M5`) are preserved under [`docs/archive/`](https://github.com/LelouchHe/agent-evals/blob/main/docs/archive/).

## Development

```sh
npm ci
npm run eval -- --help # rebuild dist/ and run the CLI from a source checkout
npm run check          # ESLint, Prettier, TypeScript, build, and deterministic model-free tests
npm run test:package   # Pack tarball, install into an external prefix, and verify the installed CLI
```

Serialize checkout build/test/eval commands because `npm run build` replaces `dist/` non-atomically; see [Architecture](https://github.com/LelouchHe/agent-evals/blob/main/docs/architecture.md#known-limitations) for runtime and development constraints.

## Releasing

- **CI ([`ci.yml`](https://github.com/LelouchHe/agent-evals/blob/main/.github/workflows/ci.yml)):** Runs deterministic `check` on macOS, Linux, and Windows for every PR and push to `main`. Setting the `OPENCODE_API_KEY` repository secret (`gh secret set OPENCODE_API_KEY`) enables the optional 3-OS live ACP `smoke` job; remove the secret (`gh secret remove OPENCODE_API_KEY`) to skip it.
- **Publish ([`publish.yml`](https://github.com/LelouchHe/agent-evals/blob/main/.github/workflows/publish.yml)):** Push a `vX.Y.Z` tag matching `package.json`'s version. The workflow re-runs `check`, builds `win-sandbox.exe` on `windows-latest`, publishes `@lelouchhe/agent-evals` (`--access public --provenance` using `NPM_TOKEN`), and creates the GitHub Release.

## License

[MIT](https://github.com/LelouchHe/agent-evals/blob/main/LICENSE)
