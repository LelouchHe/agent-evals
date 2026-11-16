# Agent Evals

A toolkit for evaluating AI agent systems.

Evaluate instructions, skills, workflows, configurations and harnesses through explicit tasks, controlled environments and evidence-based checks. Harnesses run through a generic [ACP runner](docs/configuration.md#acp-runner-type-acp) (verified with Pi, Claude Code and GitHub Copilot CLI), the native Pi runner, or the `noop` baseline, under macOS Seatbelt, with `file`, `mock`, `shell`, `trace` and `judge` checkers. [M2](docs/m2-plan.md) delivered ACP execution and trace evidence; [M3](docs/m3-plan.md) delivered shell collaborator mocks and [M4](docs/m4-plan.md) delivered the `mock`/`shell` checkers, recorded usage and the `noop` runner, and [M5](docs/m5-plan.md) delivered the `trace` checker for skill consultations; M6 covers sandbox configuration and M7 covers MCP collaborators, neither with a plan yet, and [Roadmap](docs/roadmap.md) describes the broader target system.

Requirements: Node.js 24+; macOS with `sandbox-exec`. ACP runs need caller-prepared harness directories; the native runner needs an installed `pi` CLI. `view` needs neither a harness nor credentials. The package/repository remain private and unpublished; visibility and publication require explicit approval.

## Quick Start

[`examples/cases/deploy-runbook`](examples/cases/deploy-runbook/case.yml) asks an agent to diagnose a failed deploy. Its skill supplies private error-code knowledge the task and log do not reveal, so `with-skill` and `without-skill` cases are expected to differ; one run of each is a sample, not a pass rate. Names are labels, not built-in A/B modes. It has seven cases: `pi-with-skill`, `pi-without-skill`, `claude-with-skill`, `claude-without-skill`, `copilot-with-skill` and `copilot-without-skill` (each using a standalone agent configuration from [`examples/agents/`](examples/agents/)), plus a `baseline` case on the `noop` runner. It also exercises every `mocks.shell` action with harmless collaborators: a fixed result for `deployctl status`, an author-supplied host program for `release-facts`, a passing `uname -s` that runs the real command in the sandbox, and a refused `make`. Checks assert facts only those responses contain, a `trace` check asserts the skill consultation deterministically across harnesses, and a `mock` check with `times: 0` proves no `make` call was recorded beside the trace judge asking the same question; every call is retained in `mocks.json` beside `result.json` and `trace.json`. Two `shell` checks then run after the agent: one runs the fixture's `checks/check-diagnosis.sh`, guarded by a `file` `changed: false` check, and asserts only public facts from the log; the other runs `checks/acceptance.sh`, supplied through `shell.files` only at check time, so it can assert the private fix commands and combined facts without the agent ever seeing them. [Mocks](docs/mocks.md) owns the semantics and limitations.

```sh
npm ci
cp .env.example .env
# Set the harness directories and the judge's provider key or lookup command in .env.
npm run eval -- view examples/cases/deploy-runbook/case.yml --case pi-with-skill
npm run eval -- config examples/agents/pi.yml   # offered models and options, no prompt
npm run eval -- login examples/agents/pi.yml    # native login, saved into home.login
npm run eval -- run examples/cases/deploy-runbook/case.yml --case pi-with-skill
# Installed CLI: agent-evals config/login <agent.yml>
```

Prepare each harness's `deps` first; the examples do not bundle software or credentials. `login` opens the declared native program interactively and saves the declared login files on successful exit. Claude authenticates with a one-year [`claude setup-token` token](docs/configuration.md#claude-code-token) from `.env` instead, so it needs no `login`. The helpers and ACP runs use a temporary HOME and the same macOS sandbox. See [ACP preparation](docs/configuration.md#acp-preparation-helpers) for the format and storage rules.

[`deploy-runbook-native`](examples/cases/deploy-runbook-native/case.yml) runs the same evaluation through the native Pi runner, with an installed `pi` and only the provider key; it shares the ACP example's fixture and skill. [Configuration Reference](docs/configuration.md) explains the file format and commands.

## Installable CLI

The installed `agent-evals` bin and `npm run eval` execute the same generated `dist/cli.js`, built from the sole `src/cli.ts` implementation. Development invocation rebuilds first. To try the private package without a global installation:

```sh
npm pack --pack-destination /tmp
npm install --prefix /tmp/agent-evals-install /tmp/agent-evals-0.0.0.tgz
/tmp/agent-evals-install/node_modules/.bin/agent-evals --help
```

Then use that command as `agent-evals run case.yml --case name` or `agent-evals view case.yml --case name`. The tarball includes built runtime assets, package metadata, README, LICENSE and `.env.example`, not source/tests/dev tooling or actual `.env` files. It is a Node.js package, not a standalone executable; installation does not require the source checkout, TypeScript, Husky or Git metadata.

## Credentials

Reference local values from runner/checker parameters:

```yaml
runner:
  $type: pi
  model: opencode-go/deepseek-v4.1-flash
  apiKey: ${env:OPENCODE_API_KEY}
```

`${env:NAME}` reads from `.env` in the invocation working directory and can sit inside other text; `$${` writes a literal `${`. There is no host-environment fallback. See [placeholders](docs/configuration.md#placeholders) for scope and the built-in `${HOME}` and `${TMPDIR}`.

Start from [`.env.example`](.env.example). Values can be plain strings or explicit trusted lookup commands:

```dotenv
OPENCODE_API_KEY=replace-with-your-local-key
# Alternatively:
# OPENCODE_API_KEY="!security find-generic-password -w -s opencode-api-key"
```

The engine reads requested entries lazily and caches each name once per run. It resolves values before schema validation; implementations receive their normal fields and do not read `.env`. `view` never resolves values or runs lookups.

Lookup commands run as trusted operator code from that directory, with the operator environment. Node `execFile` applies a five-second timeout, 64 KiB output limit and direct-process cancellation; descendants are operator-owned. Failures report names/status, not raw command output, and are not retried.

`${env:NAME}` is a value source, not a secrecy flag. Implementations own their outputs; the engine does not redact by field name or source. Use placeholders rather than literal real keys in YAML, because declared literals are retained in results. Keep `.env` private and out of Git; do not execute someone else's lookup commands without trusting them.

## Development

```sh
npm run check
```

The gate runs ESLint, Prettier, TypeScript checking, a build and deterministic tests. Tests use synthetic credentials/fake harnesses and do not call models.

Run `npm run test:package` separately when verifying a distributable. It packs the current checkout, installs into a disposable directory outside the repository, and exercises the installed CLI with synthetic credentials. It may access the package registry to install runtime dependencies, but never calls a model; this installation step is deliberately not repeated by ordinary unit tests. `npm run format` and `npm run lint:fix` apply changes explicitly. `npm ci` sets up repository-local Husky: pre-commit checks lint/format without rewriting files; pre-push runs the complete gate against a clean worktree and the checked-out outgoing HEAD.

Checkout builds replace shared `dist/` non-atomically. Serialize checkout eval/build/test/pack/check/push commands; for concurrent evaluations use a separate installed prefix that is not rebuilt while in use. Generated `dist/`, tarballs, results and local agent adapters stay out of version control/format targets.

The pinned development toolchain's `minimatch@10.2.6` has [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). This is temporarily accepted for the reviewed level-1-only call paths: the advisory requires attacker-controlled patterns with `optimizationLevel >= 2`, which the reviewed lint flow does not use. Reassess on a compatible upstream fix or changed reachability; do not force a downgrade/major override merely to clear audit output.

## Documentation

| Document                                         | Question it answers                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [Architecture](docs/architecture.md)             | Which modules cooperate, through which interfaces, to execute a case?                 |
| [Configuration Reference](docs/configuration.md) | How do YAML, selection, parameters, view and results work?                            |
| [Extensions](docs/extensions.md)                 | How do I write and load my own runner or checker?                                     |
| [Writing Cases](docs/cases.md)                   | How should tasks, fixtures and assertions be designed?                                |
| [Mocks](docs/mocks.md)                           | How do I substitute a command, and what does `mocks.json` contain?                    |
| [Roadmap](docs/roadmap.md)                       | What is the target shape, and which capabilities are planned rather than implemented? |
| [M1 Delivery](docs/m1-plan.md)                   | What shipped in M1, what was verified, and which limits remain?                       |
| [M2 Delivery](docs/m2-plan.md)                   | How do ACP harnesses, isolated HOME assembly and trace evidence work?                 |
| [M3 Delivery](docs/m3-plan.md)                   | How do shell collaborator mocks work, and which limits remain?                        |
| [M4 Delivery](docs/m4-plan.md)                   | How do the `mock`/`shell` checkers, recorded usage and the `noop` baseline work?      |
| [M5 Delivery](docs/m5-plan.md)                   | How does the `trace` checker derive and assert skill consultations?                   |

Module tests live beside source; cross-module/hook/package tests live under `tests/`. Runtime code is under `src/engine`, `src/runners`, `src/checkers`, and `src/platform`; see the [source map](docs/architecture.md#source-map). Known runtime limitations belong in [M1](docs/m1-plan.md#known-limitations), not a second list here.

## License

[MIT](LICENSE)
