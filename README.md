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
npm run eval -- view examples/write-file/case.yml --case with-skill
npm run eval -- run examples/write-file/case.yml --case with-skill
```

The example also has `without-skill`; names are labels, not built-in A/B modes. Both use `opencode-go/deepseek-v4.1-flash` and default thinking `medium`. This tiny task proves integration, not skill improvement. [Configuration Reference](docs/configuration.md) explains the file format and commands.

## Installable CLI

The installed `agent-evals` bin and `npm run eval` execute the same generated `dist/cli.js`, built from the sole `src/cli.ts` implementation. Development invocation rebuilds first. To try the private package without a global installation:

```sh
npm pack --pack-destination /tmp
npm install --prefix /tmp/agent-evals-install /tmp/agent-evals-0.0.0.tgz
/tmp/agent-evals-install/node_modules/.bin/agent-evals --help
```

Then use that command as `agent-evals run case.yml --case name` or `agent-evals view case.yml --case name`. The tarball includes built runtime assets, package metadata, README, LICENSE and `.env.example`, not source/tests/dev tooling or actual `.env` files. It is a Node.js package, not a standalone executable; installation does not require the source checkout, TypeScript, Husky or Git metadata.

## Credentials

Keep credential values out of YAML; declare only their names. On `run`, the only default source is `.env` in the invocation working directory; for `npm run eval`, normal npm working-directory semantics apply. There is no upward, case-directory, package-directory, HOME, personal Pi-auth or ambient API-key fallback. Start from [`.env.example`](.env.example).

Each Pi runner or judge record explicitly lists the names it needs:

```yaml
runner:
  $type: pi
  model: opencode-go/deepseek-v4.1-flash
  credentials: [OPENCODE_API_KEY]
```

Each name is read from `.env` and injected under the same environment-variable name. The list defaults to empty: no key is inferred from a provider/model, and missing declared entries fail before model start. Choose names recognized by the harness. There is no provider/key mapping, aliasing or arbitrary parameter binding; future binding questions are tracked in [Open Questions](docs/roadmap.md#open-questions). Declarations are trusted operator configuration: explicitly injecting names such as `HOME`, `PATH` or `NODE_OPTIONS` can change the harness setup or behavior. Choose those overrides deliberately; there is no name/prefix blacklist.

Use a plain value, or a parsed value starting with `!` to fetch an existing secret:

```dotenv
OPENCODE_API_KEY=replace-with-your-local-key
# Alternatively, replace that value with an explicit lookup command:
# OPENCODE_API_KEY="!security find-generic-password -w -s opencode-api-key"
```

The file is parsed in memory with Node's dotenv parser, not sourced as shell code. Only requested entries are resolved; an unused command does not run. Each requested key is cached once per run and shared by runner/judge as needed. Only each instance's declared credentials reach its isolated process, not all `.env` values or the operator environment. `envPassthrough` is not a Case parameter.

Lookup commands execute as trusted host operator code from the invocation directory, with the operator environment. Node `execFile` limits the direct shell/command to five seconds and 64 KiB of output; timeout or abort terminates that direct process with SIGKILL. Use synchronous lookup commands that manage their own descendants: background jobs and daemons are operator-owned and are not tracked or promised cleaned by this toolkit. This does not change the separate Pi agent-process cleanup.

Failure, empty output, timeout, excessive output or cancellation fails closed without retry. Trimmed stdout becomes the key. Errors report the credential name and failure category/exit code, not the command, stdout or stderr, which may contain secrets. `view` never reads `.env` or executes a lookup.

Treat `.env` as sensitive executable configuration. Do not generate it from an evaluated workspace, commit real values, or assume someone else's commands are safe. Keys are not written to run/config/auth files or retained results. `.env` files are Git-ignored; `.env.example` contains no secret.

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
