# Setup

Requirements: Node.js 24+ and macOS with `/usr/bin/sandbox-exec`. `view` needs neither a harness nor credentials; `run` needs the selected harness prepared as below, plus an installed `pi` CLI and provider key whenever a case uses the native `pi` runner or declares one for `$type: judge`.

## Install the CLI

From a source checkout (`npm run eval` rebuilds `dist/` first):

```sh
npm ci
npm run eval -- --help
```

To install the private package into a separate prefix (for example to run concurrent evaluations without rebuilding `dist/` underneath them):

```sh
npm pack --pack-destination /tmp
npm install --prefix /tmp/agent-evals-install /tmp/agent-evals-0.1.0.tgz
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
CLAUDE_DEPS=/absolute/path/to/agent-evals-home/claude/deps
CLAUDE_LOGIN=/absolute/path/to/agent-evals-home/claude/login
CLAUDE_OAUTH_TOKEN="!security find-generic-password -w -s claude-oauth-token"
COPILOT_DEPS=/absolute/path/to/agent-evals-home/copilot/deps
COPILOT_GITHUB_TOKEN="!security find-generic-password -w -s copilot-github-token"
```

Lookup commands execute as trusted operator code from the invocation directory, with the operator environment. Node `execFile` applies a five-second timeout, a 64 KiB output limit and direct-process cancellation; descendants are operator-owned. Failures report entry names and exit status without printing raw command output, and are not retried.

`${env:NAME}` is a value source, not a secrecy flag: implementations own their outputs and the engine does not redact by field name. Always use placeholders rather than literal keys in YAML, because declared literals are retained in `result.json`. Keep `.env` private and out of Git, and never execute untrusted lookup commands.

## Prepare ACP Harnesses

### How Isolated Harness Homes Work

Seatbelt blocks the operator's real `$HOME`, login keychain, Homebrew prefix and version-manager directories so everyday dotfiles, global skills and session history never leak into an evaluation or get mutated by it. Instead, every ACP run (and `config` / `login` command) gets a fresh temporary run directory, assembled from what the [agent file](configuration.md#agent-files) declares and deleted when finished:

- **`deps` — read-only software.** The harness executable, ACP adapter and language runtime (when needed), laid out by the caller. The run root gets one directory symlink, `deps`, and `PATH` entries are `run-xxxx/deps/<path>`; the software is referenced in place, never copied or mirrored into `HOME`, so `which pi` answers a run-root path and a runaway agent cannot modify it. `path` defaults to `[bin]`, so `deps/bin` plus shared files beside it is the example layout; any other layout works by declaring `path`.
- **`files` — the harness's static settings.** A `~/` destination per settings file, with the authoring file beside the agent file. The run **copies** them into `HOME` (a directory source merges, and `.agentevalsignore` applies), so a harness that rewrites its settings at startup changes only that run. There is no prepared HOME-base directory to drift out of date.
- **`login` — mutable authentication state (optional).** `dir` is the persistent login directory (kept separate from your everyday sessions); `files` is its composition. Because harnesses lock, rewrite or rotate refresh tokens in place, those files are **copied** into `HOME` before launch, and changed originals are copied back after the sandbox stops. Caches, logs and session databases created during the run are discarded.

Inside the sandbox, `PATH` contains only the declared `path` entries under the run's `deps`, followed by `/usr/bin:/bin:/usr/sbin:/sbin`, and the mock forwarder directory first when the case declares mocks. `HOME` holds the agent file's `files`, the login files and the case's own `~/` entries — never the software. The workspace (with any project skills) is the working directory, and `engine/` is unreadable to the agent.

Nothing in `agent-evals` fixes directory names: any layout with regular files under `deps`, regular files in the login directory, and matching `path` and `acpCommand` works, either in a standalone `.yml` file or inline under `runner.agent`.

### Credentials: Environment First, Login State Only When Required

The sandbox blocks the login keychain, so a harness cannot look up its own secret. There are two ways to give it one:

- **Environment (preferred).** A `.env` lookup runs on the host, outside the sandbox, and the agent file's `environment` passes the value to the harness process. Nothing is written under the caller's directories, and the secret can stay in Keychain. All three reference examples authenticate this way.
- **Login state (`login`).** Use it only when the harness cannot take its credential from the environment: typically an OAuth login whose access token the harness exchanges, refreshes and writes back itself (for example Pi's OAuth providers such as GitHub Copilot), so the refreshed file must be copied back after each run. It also fits non-secret state that should outlive a run; the Claude example keeps Claude Code's `.claude.json` there. The persistent copy is a plain file on disk, which is why the login directory is private and kept apart from everyday sessions.

An environment variable still reaches whatever the harness lets the evaluated agent run, in two ways (observed in November 2026):

- **Inherited by tool commands.** Pi passes its environment through to `bash`, so a plain `env` would put `OPENCODE_API_KEY` into the transcript and the model's context. [`pi-settings.json`](../examples/agents/pi-settings.json) sets Pi's `shellCommandPrefix` to `unset OPENCODE_API_KEY`, which runs before every `bash` tool command; add any other credential name you pass to Pi. Claude Code and Copilot CLI already remove their credential variable before running tool commands.
- **Read from an ancestor process.** macOS lets a process read the start-up environment of any process with the same user ID (`sysctl` `KERN_PROCARGS2`), and Seatbelt cannot block it. A command that deliberately reads the harness process this way still finds the credential in all three harnesses.

Neither method hides a credential from an agent that goes looking for it, so scope evaluation keys accordingly.

### Reference Examples

[`examples/agents/`](../examples/agents/) provides ready-to-use configurations (`<name>.yml`), settings templates (`<name>-settings.json`) and setup scripts (`<name>-setup.sh`) for Pi, Claude Code and GitHub Copilot CLI:

```sh
./examples/agents/pi-setup.sh ~/agent-evals-home/pi
./examples/agents/claude-setup.sh ~/agent-evals-home/claude
./examples/agents/copilot-setup.sh ~/agent-evals-home/copilot
```

Each example script prepares only software, under `deps/` (`deps/bin` plus `deps/share`), and prints the lines for `.env`; the Claude script also prepares `login/` for Claude Code's state file. Credentials come from `.env`, resolved outside the sandbox. The harness settings stay beside the agent file and are placed by its `files`:

| Harness                                                           | Setup script & overrides                                                                                                                                                                                | Settings placed by `files`                                                                                                                                            | Authentication                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Pi** ([`pi.yml`](../examples/agents/pi.yml))                    | [`pi-setup.sh`](../examples/agents/pi-setup.sh) installs official Node 24, `@earendil-works/pi-coding-agent` and official `pi-acp` (`NODE_VERSION`, `PI_ACP_SPEC`).                                     | [`pi-settings.json`](../examples/agents/pi-settings.json) → `~/.pi/agent/settings.json` (`defaultProjectTrust: "always"`, no telemetry/retries, key unset for `bash`) | `OPENCODE_API_KEY` from `.env`, for example a Keychain lookup.                                                                         |
| **Claude Code** ([`claude.yml`](../examples/agents/claude.yml))   | [`claude-setup.sh`](../examples/agents/claude-setup.sh) installs official Node 24 and `@agentclientprotocol/claude-agent-acp`, linking its bundled `claude` binary (`NODE_VERSION`, `CLAUDE_ACP_SPEC`). | [`claude-settings.json`](../examples/agents/claude-settings.json) → `~/.claude/settings.json` (disables account skill sync and connectors)                            | One-year [`claude setup-token`](#claude-code-claudeyml) stored in Keychain as `CLAUDE_OAUTH_TOKEN`.                                    |
| **Copilot CLI** ([`copilot.yml`](../examples/agents/copilot.yml)) | [`copilot-setup.sh`](../examples/agents/copilot-setup.sh) downloads the standalone `@github/copilot-<platform>` binary or copies `COPILOT_BIN` (`COPILOT_VERSION`, `COPILOT_BIN`).                      | [`copilot-settings.json`](../examples/agents/copilot-settings.json) → `~/.copilot/settings.json` (sandbox off)                                                        | A fine-grained PAT with the "Copilot Requests" permission, or a Copilot CLI OAuth token, stored in Keychain as `COPILOT_GITHUB_TOKEN`. |

#### Pi (`pi.yml`)

`pi-setup.sh` installs the published [`pi-acp`](https://www.npmjs.com/package/pi-acp) package by default. To install the [`LelouchHe/pi-acp`](https://github.com/LelouchHe/pi-acp) fork (which adds prompt-response `usage.tokens` totals and `_meta.directTools` MCP support before upstream release), point `PI_ACP_SPEC` at a local checkout or tarball:

```sh
PI_ACP_SPEC=/path/to/pi-acp ./examples/agents/pi-setup.sh ~/agent-evals-home/pi
```

If interactive `pi` startup needs `fd` or `rg`, place them in `$PI_DEPS/bin` as well: a prepared tool is software. Pi's own downloads land in the run `HOME` and disappear with the run.

#### Claude Code (`claude.yml`)

Claude runs on a one-year [`claude setup-token`](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) subscription token rather than `login` (never refreshed, so idle periods and concurrent runs do not invalidate your everyday login; requires Pro, Max, Ultra, Team or Enterprise — use `ANTHROPIC_API_KEY` instead for heavy automated runs):

```sh
# Opens browser authorization and prints the token without saving it:
"$CLAUDE_DEPS/bin/claude" setup-token
# Store in macOS Keychain (-w last prompts without echoing into shell history):
security add-generic-password -U -a "$USER" -s claude-oauth-token -w
```

Reference it in `.env` as `CLAUDE_OAUTH_TOKEN="!security find-generic-password -w -s claude-oauth-token"`. [`claude.yml`](../examples/agents/claude.yml) also sets `CLAUDE_CODE_TMPDIR: ${TMPDIR}` because Claude Code ignores `TMPDIR` and otherwise writes to `/tmp/claude-<uid>`, which Seatbelt denies.

#### GitHub Copilot CLI (`copilot.yml`)

`copilot-setup.sh` downloads the standalone native Mach-O binary from `@github/copilot-<platform>` by default. If you already have the standalone native binary installed (for example via Homebrew Cask at `/opt/homebrew/bin/copilot` — **not** an `npm install -g @github/copilot` JS wrapper, which requires Node and its `node_modules` tree), you can pass `COPILOT_BIN=/path/to/copilot` to copy it instead; the script verifies that `COPILOT_BIN` is a Mach-O executable.

Copilot authenticates from `COPILOT_GITHUB_TOKEN`, which takes precedence over stored credentials; with the token in the environment it persists no credential in the run `HOME`. Use a fine-grained PAT with the "Copilot Requests" permission or an OAuth token from the Copilot CLI app, and store it in Keychain:

```sh
# -w last prompts without echoing into shell history:
security add-generic-password -U -a "$USER" -s copilot-github-token -w
```

Reference it in `.env` as `COPILOT_GITHUB_TOKEN="!security find-generic-password -w -s copilot-github-token"`.

## Verify Readiness

Check configuration resolution without credentials, run the offline `noop` baseline before spending tokens, and query each prepared harness's advertised models and options (`config` runs `initialize` and `session/new` inside the sandbox without sending a prompt):

```sh
npm run eval -- view examples/cases/deploy-runbook/case.yml --case baseline
npm run eval -- run examples/cases/deploy-runbook/case.yml --case baseline # expected to fail positive checks
npm run eval -- config examples/agents/pi.yml
npm run eval -- config examples/agents/claude.yml
npm run eval -- config examples/agents/copilot.yml
```
