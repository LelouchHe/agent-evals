# Agent Evals

A toolkit for evaluating AI agent systems on the real CLI and harness layer.

## Why Agent Evals

- **Evaluate the whole agent system, not a bare model API.** Real outcomes depend on the model _plus_ its harness, skill routing, instruction hierarchy and tool loop. One generic [ACP runner](docs/configuration.md#acp-runner-type-acp) drives unmodified [Pi](examples/agents/pi.yml), [Claude Code](examples/agents/claude.yml) and [GitHub Copilot CLI](examples/agents/copilot.yml) configurations side by side (alongside the native `pi` runner), so changing a skill, instruction, flag or harness is a controlled experiment.
- **Host-native OS sandboxing, not Linux containers.** Each run executes directly on the host platform under macOS Seatbelt with one run-root layout: `deps` (caller software, referenced in place), a layered `HOME` (agent-file settings, copied login state, then the case's `~/` user data), the prepared workspace, a temporary directory, mock forwarders and engine-private state the agent cannot read. Real host toolchains and platform behavior stay intact, while operator dotfiles, login keychains, rubrics and check-time acceptance tests remain unreachable to the agent.
- **Three orthogonal evidence sources, deterministic first.** Instead of handing a raw chat log to an LLM judge and hoping for a score, assertions match each evidence source: workspace side effects (`file` and sandboxed `shell` checks, including hidden check-time tests), host-recorded boundary calls (`mocks.shell` + `mock` checks that intercept or spy on commands outside the sandbox), and run traces (`trace` for cross-harness skill consultations and the text the agent produced, paired with `judge` only where qualitative judgment is needed) — plus a `noop` baseline runner that catches vacuous checks.

Requirements: Node.js 24+ and macOS with `sandbox-exec`. Private and unpublished; visibility and publication require explicit approval.

## Quick Start

Follow [Setup](docs/setup.md) once to configure `.env` and prepare the harness directories you want to run, then inspect and run the worked example ([`examples/cases/deploy-runbook`](examples/cases/deploy-runbook/case.yml) — seven named cases across Pi, Claude Code, Copilot CLI and `noop`, exercising project skills, every `mocks.shell` action, hidden check-time `shell` acceptance scripts and all five checkers):

```sh
npm ci
cp .env.example .env                        # fill in harness paths and keys (see docs/setup.md)
npm run eval -- view examples/cases/deploy-runbook/case.yml --case pi-with-skill
npm run eval -- config examples/agents/pi.yml
npm run eval -- run examples/cases/deploy-runbook/case.yml --case pi-with-skill
```

[`deploy-runbook-native`](examples/cases/deploy-runbook-native/case.yml) runs the same task through the native Pi runner using an installed `pi` CLI and provider key alone.

## Documentation

| Document                                         | Question it answers                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [Setup](docs/setup.md)                           | How do I install the CLI, configure `.env`, and prepare Pi, Claude Code and Copilot? |
| [Writing Cases](docs/cases.md)                   | How should tasks, fixtures, baselines and assertions be designed?                    |
| [Configuration Reference](docs/configuration.md) | How do YAML files, placeholders, runners, checkers and result records work?          |
| [Mocks](docs/mocks.md)                           | How do I substitute or spy on shell commands, and what does `mocks.json` contain?    |
| [Extensions](docs/extensions.md)                 | How do I write and load a custom runner or checker?                                  |
| [Architecture](docs/architecture.md)             | How do the modules cooperate, and what runtime/development limits apply today?       |
| [Roadmap](docs/roadmap.md)                       | What is planned next (M6 sandbox config, M7 MCP mocks), and where are past archives? |

Delivered milestone records (`M1`–`M5`) are preserved under [`docs/archive/`](docs/archive/).

## Development

```sh
npm run check          # ESLint, Prettier, TypeScript, build, and deterministic model-free tests
npm run test:package   # Pack tarball, install into an external prefix, and verify the installed CLI
```

Serialize checkout build/test/eval commands because `npm run build` replaces `dist/` non-atomically; see [Architecture](docs/architecture.md#known-limitations) for runtime and development constraints.

## License

[MIT](LICENSE)
