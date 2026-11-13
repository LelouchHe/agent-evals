# Agent Evals

A toolkit for evaluating AI agent systems.

Evaluate instructions, skills, workflows, configurations and harnesses through explicit tasks, controlled environments and evidence-based checks. The current [M1](docs/m1-plan.md) runs one filesystem case with Pi RPC, macOS Seatbelt, and `file`/`judge` checkers. See [Roadmap](docs/roadmap.md) for the intended broader system.

Requirements: Node.js 24+; macOS with `sandbox-exec` and an installed `pi` CLI for harness execution. `view` needs neither Pi nor credentials. The package/repository remain private and unpublished; visibility and publication require explicit approval.

## Quick Start

From the repository:

```sh
npm ci
cp .env.example .env
# Fill the provider key or lookup command in .env before running a model.
npm run eval -- view examples/cases/deploy-runbook/case.yml --case with-skill
npm run eval -- run examples/cases/deploy-runbook/case.yml --case with-skill
```

The example also has `without-skill`; names are labels, not built-in A/B modes. Both use `opencode-go/deepseek-v4.1-flash` and default thinking `medium`. The skill supplies private error-code knowledge the task and log do not reveal, so the cases are expected to differ; one run of each is a sample, not a pass rate. [Configuration Reference](docs/configuration.md) explains the file format and commands.

Runnable cases and their fixture/skill assets live under [`examples/cases/`](examples/cases/); they still use the native Pi runner. Standalone agent configurations under [`examples/agents/`](examples/agents/) are inputs to the ACP preparation helpers:

```sh
npm run eval -- config examples/agents/pi.yml
npm run eval -- login examples/agents/pi.yml
# Installed CLI: agent-evals config/login <agent.yml>
```

Set the referenced directory paths in the invocation `.env` and prepare `deps` first; the examples do not bundle software or credentials. `config` reports ACP configuration values without sending a prompt. `login` opens the declared native program interactively, then saves the declared login files on successful exit. Both use a temporary HOME and the same macOS sandbox. See [ACP preparation](docs/configuration.md#acp-preparation-helpers) for the format and storage rules. Claude's isolated installation remains unverified. Full ACP case execution is not implemented yet.

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
  apiKey: $env:OPENCODE_API_KEY
```

Only an unquoted, complete `$env:NAME` reads from `.env` in the invocation working directory; quoted or block strings stay literal. There is no host-environment fallback. See [value rules](docs/configuration.md#values-from-env) for scope and quoting.

Start from [`.env.example`](.env.example). Values can be plain strings or explicit trusted lookup commands:

```dotenv
OPENCODE_API_KEY=replace-with-your-local-key
# Alternatively:
# OPENCODE_API_KEY="!security find-generic-password -w -s opencode-api-key"
```

The engine reads requested entries lazily and caches each name once per run. It resolves values before schema validation; implementations receive their normal fields and do not read `.env`. `view` never resolves values or runs lookups.

Lookup commands run as trusted operator code from that directory, with the operator environment. Node `execFile` applies a five-second timeout, 64 KiB output limit and direct-process cancellation; descendants are operator-owned. Failures report names/status, not raw command output, and are not retried.

`$env` is a value source, not a secrecy flag. Implementations own their outputs; the engine does not redact by field name or source. Use references rather than literal real keys in YAML, because declared literals are retained in results. Keep `.env` private and out of Git; do not execute someone else's lookup commands without trusting them.

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
| [Writing Cases](docs/cases.md)                   | How should tasks, fixtures and assertions be designed?                                |
| [Roadmap](docs/roadmap.md)                       | What is the target shape, and which capabilities are planned rather than implemented? |
| [M1 Delivery](docs/m1-plan.md)                   | What shipped, what was verified, and which limits remain?                             |

Module tests live beside source; cross-module/hook/package tests live under `tests/`. Runtime code is under `src/engine`, `src/runners`, `src/checkers`, and `src/platform`; see the [source map](docs/architecture.md#source-map). Known runtime limitations belong in [M1](docs/m1-plan.md#known-limitations), not a second list here.

## License

[MIT](LICENSE)
