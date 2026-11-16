# Setup

Requirements: Node.js 24+ and macOS with `/usr/bin/sandbox-exec`. `view` needs neither a harness nor credentials; `run` needs the selected harness prepared as below, plus an installed `pi` CLI and provider key whenever a case uses `$type: judge` or the native `pi` runner.

## Install the CLI

From a source checkout (`npm run eval` rebuilds `dist/` first):

```sh
npm ci
npm run eval -- --help
```

To install the private package into a separate prefix (for example to run concurrent evaluations without rebuilding `dist/` underneath them):

```sh
npm pack --pack-destination /tmp
npm install --prefix /tmp/agent-evals-install /tmp/agent-evals-0.0.0.tgz
/tmp/agent-evals-install/node_modules/.bin/agent-evals --help
```

Both entry points execute the same built `dist/cli.js`. The tarball includes built runtime assets, package metadata, `README.md`, `LICENSE` and `.env.example`, never source/tests/dev tooling or actual `.env` files. It is a Node.js package, not a standalone binary; installation does not require the source checkout, TypeScript, Husky or Git metadata.

## Credentials and `.env`

Start from [`.env.example`](../.env.example) in the directory where you invoke `agent-evals`:

```sh
cp .env.example .env
```

Runner and checker parameters reference entries with `${env:NAME}` ([syntax and placeholder rules](configuration.md#placeholders)). There is no host-environment fallback: only names referenced by the selected case or agent file are read, lazily and cached once per run. `view` never reads `.env` or runs lookups.

Each entry in `.env` is either a plain string or a `!`-prefixed lookup command:

```dotenv
OPENCODE_API_KEY=replace-with-your-local-key
# Or a trusted local lookup command:
OPENCODE_API_KEY="!security find-generic-password -w -s opencode-api-key"

PI_DEPS=/absolute/path/to/agent-evals-home/pi/deps
PI_LOGIN=/absolute/path/to/agent-evals-home/pi/login
CLAUDE_DEPS=/absolute/path/to/agent-evals-home/claude/deps
CLAUDE_LOGIN=/absolute/path/to/agent-evals-home/claude/login
CLAUDE_OAUTH_TOKEN="!security find-generic-password -w -s claude-oauth-token"
COPILOT_DEPS=/absolute/path/to/agent-evals-home/copilot/deps
COPILOT_LOGIN=/absolute/path/to/agent-evals-home/copilot/login
```

Lookup commands execute as trusted operator code from the invocation directory, with the operator environment. Node `execFile` applies a five-second timeout, a 64 KiB output limit and direct-process cancellation; descendants are operator-owned. Failures report entry names and exit status without printing raw command output, and are not retried.

`${env:NAME}` is a value source, not a secrecy flag: implementations own their outputs and the engine does not redact by field name. Always use placeholders rather than literal keys in YAML, because declared literals are retained in `result.json`. Keep `.env` private and out of Git, and never execute untrusted lookup commands.

## Prepare ACP Harnesses

### How Isolated Harness Homes Work

Seatbelt blocks the operator's real `$HOME`, login keychain, Homebrew prefix and version-manager directories so everyday dotfiles, global skills and session history never leak into an evaluation or get mutated by it. Instead, every ACP run (and `config` / `login` command) starts in a fresh temporary `$HOME` assembled from three parts declared in [`AgentConfig`](configuration.md#acp-preparation-helpers), then deletes that `$HOME` when finished:

- **`home.deps` — read-only software and static evaluation settings.** Holds the harness executable, ACP adapter, language runtime (when needed) and evaluation-specific user settings (such as disabling telemetry, connectors or interactive trust prompts), laid out relative to `$HOME`. Setup recreates its directories and links every file into the temporary `$HOME` as a **read-only symlink** — tens of thousands of files assemble in under a second, and a runaway agent cannot modify `deps` across runs.
- **`home.login` — mutable authentication state (optional).** Holds only the credential or account files the harness reads from `$HOME` (kept separate from your everyday sessions). Because harnesses lock, rewrite or rotate refresh tokens in place, these files cannot be read-only symlinks: setup **copies** them into the temporary `$HOME` before launch, copies modified originals back after the sandbox stops, and discards transient caches, logs and session databases created during the run.
- **`home.path` — `$HOME`-relative command directories.** Inside the sandbox, `PATH` contains only `home.path` entries followed by `/usr/bin:/bin:/usr/sbin:/sbin`. Naming the directory where `deps` placed its executables (for example `[.local/bin]` or `[bin]`) makes `acpCommand` and tool subshells find the harness's own binaries without inheriting the host `PATH`.

Nothing in `agent-evals` fixes directory names such as `deps/`, `login/` or `.local/bin`, or limits which ACP harnesses you can run: any directory layout that satisfies the three rules above (real subdirectories and regular files in `deps`, non-overlapping regular files in `login`, matching `home.path` and `acpCommand`) works unchanged, either in a standalone `.yml` file or inline under `runner.agent`.

### Reference Examples

[`examples/agents/`](../examples/agents/) provides ready-to-use configurations (`<name>.yml`), settings templates (`<name>-settings.json`) and setup scripts (`<name>-setup.sh`) for Pi, Claude Code and GitHub Copilot CLI:

```sh
./examples/agents/pi-setup.sh ~/agent-evals-home/pi
./examples/agents/claude-setup.sh ~/agent-evals-home/claude
./examples/agents/copilot-setup.sh ~/agent-evals-home/copilot
```

Each example script populates `deps/` and `login/` under its target path and prints the `*_DEPS` / `*_LOGIN` lines for `.env`:

| Harness                                                           | Setup script & overrides                                                                                                                                                                                | Settings file copied into `deps/`                                                                                                             | Authentication                                                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pi** ([`pi.yml`](../examples/agents/pi.yml))                    | [`pi-setup.sh`](../examples/agents/pi-setup.sh) installs official Node 24, `@earendil-works/pi-coding-agent` and official `pi-acp` (`NODE_VERSION`, `PI_ACP_SPEC`).                                     | [`pi-settings.json`](../examples/agents/pi-settings.json) → `.pi/agent/settings.json` (`defaultProjectTrust: "always"`, no telemetry/retries) | `npm run eval -- login examples/agents/pi.yml` saves `.pi/agent/auth.json` into `PI_LOGIN`.                                                                                    |
| **Claude Code** ([`claude.yml`](../examples/agents/claude.yml))   | [`claude-setup.sh`](../examples/agents/claude-setup.sh) installs official Node 24 and `@agentclientprotocol/claude-agent-acp`, linking its bundled `claude` binary (`NODE_VERSION`, `CLAUDE_ACP_SPEC`). | [`claude-settings.json`](../examples/agents/claude-settings.json) → `.claude/settings.json` (disables account skill sync and connectors)      | One-year [`claude setup-token`](#claude-code-claudeyml) stored in Keychain as `CLAUDE_OAUTH_TOKEN`.                                                                            |
| **Copilot CLI** ([`copilot.yml`](../examples/agents/copilot.yml)) | [`copilot-setup.sh`](../examples/agents/copilot-setup.sh) downloads the standalone `@github/copilot-<platform>` binary or copies `COPILOT_BIN` (`COPILOT_VERSION`, `COPILOT_BIN`).                      | [`copilot-settings.json`](../examples/agents/copilot-settings.json) → `.copilot/settings.json` (`storeTokenPlaintext: true`, sandbox off)     | `npm run eval -- login examples/agents/copilot.yml` (or copy `copilotTokens`, `authTokens`, `lastLoggedInUser` and `loggedInUsers` into `COPILOT_LOGIN/.copilot/config.json`). |

#### Pi (`pi.yml`)

`pi-setup.sh` installs the published [`pi-acp`](https://www.npmjs.com/package/pi-acp) package by default. To install the [`LelouchHe/pi-acp`](https://github.com/LelouchHe/pi-acp) fork (which adds prompt-response `usage.tokens` totals and `_meta.directTools` MCP support before upstream release), point `PI_ACP_SPEC` at a local checkout or tarball:

```sh
PI_ACP_SPEC=/path/to/pi-acp ./examples/agents/pi-setup.sh ~/agent-evals-home/pi
npm run eval -- login examples/agents/pi.yml
```

If interactive `pi` startup needs `fd` or `rg`, place them in `$PI_DEPS/.local/bin` as well.

#### Claude Code (`claude.yml`)

Claude runs on a one-year [`claude setup-token`](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) subscription token rather than `login` (never refreshed, so idle periods and concurrent runs do not invalidate your everyday login; requires Pro, Max, Ultra, Team or Enterprise — use `ANTHROPIC_API_KEY` instead for heavy automated runs):

```sh
# Opens browser authorization and prints the token without saving it:
"$CLAUDE_DEPS/.local/bin/claude" setup-token
# Store in macOS Keychain (-w last prompts without echoing into shell history):
security add-generic-password -U -a "$USER" -s claude-oauth-token -w
```

Reference it in `.env` as `CLAUDE_OAUTH_TOKEN="!security find-generic-password -w -s claude-oauth-token"`. [`claude.yml`](../examples/agents/claude.yml) also sets `CLAUDE_CODE_TMPDIR: ${TMPDIR}` because Claude Code ignores `TMPDIR` and otherwise writes to `/tmp/claude-<uid>`, which Seatbelt denies.

#### GitHub Copilot CLI (`copilot.yml`)

`copilot-setup.sh` downloads the standalone native Mach-O binary from `@github/copilot-<platform>` by default. If you already have the standalone native binary installed (for example via Homebrew Cask at `/opt/homebrew/bin/copilot` — **not** an `npm install -g @github/copilot` JS wrapper, which requires Node and its `node_modules` tree), you can pass `COPILOT_BIN=/path/to/copilot` to copy it instead; the script verifies that `COPILOT_BIN` is a Mach-O executable.

## Verify Readiness

Check configuration resolution without credentials, run the offline `noop` baseline before spending tokens, and query each prepared harness's advertised models and options (`config` runs `initialize` and `session/new` inside the sandbox without sending a prompt):

```sh
npm run eval -- view examples/cases/deploy-runbook/case.yml --case baseline
npm run eval -- run examples/cases/deploy-runbook/case.yml --case baseline # expected to fail positive checks
npm run eval -- config examples/agents/pi.yml
npm run eval -- config examples/agents/claude.yml
npm run eval -- config examples/agents/copilot.yml
```
